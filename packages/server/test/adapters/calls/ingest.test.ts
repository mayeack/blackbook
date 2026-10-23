/**
 * Call log ingest (collector GET /v1/calls → calls / call_handles → derived 'call' interactions) on synthetic call
 * logs (555-01xx numbers, example.com addresses), always through the @yb/shared zod contract the client applies.
 */
import { describe, expect, it } from 'vitest';
import { CallsResponse, type CallsQuery } from '@yb/shared/collector/v1';
import { callHandleKeys, callService, ingestCalls, type CallsSource } from '../../../src/adapters/calls/ingest';
import { callsJobs } from '../../../src/adapters/calls/jobs';
import { readCursor } from '../../../src/adapters/common/cursors';
import { CollectorHttpError, CollectorUnavailableError } from '../../../src/adapters/imessage/collectorClient';
import { rebuildPersonCanon } from '../../../src/db/canon';
import type { JobContext } from '../../../src/scheduler/scheduler';
import { memDb, seedIdentity, seedPerson, T0 } from '../../helpers';

type DB = ReturnType<typeof memDb>;
const MIN = 60_000;
const count = (db: DB, table: string, where = '1') => db.prepare(`SELECT count(*) FROM ${table} WHERE ${where}`).pluck().get() as number;

interface RawCall {
  rowid: number;
  unique_id: string;
  date: number;
  duration_s?: number;
  call_type?: number | null;
  provider?: string | null;
  originated?: boolean;
  answered?: boolean;
  handles: string[];
}

const call = (rowid: number, handles: string[], o: Partial<RawCall> = {}): RawCall => ({
  rowid,
  unique_id: `CALL-${String(rowid).padStart(4, '0')}`,
  date: T0 + rowid * MIN,
  duration_s: 0,
  call_type: 1,
  provider: 'com.apple.Telephony',
  originated: false,
  answered: true,
  handles,
  ...o,
});

/** Serves `log` the way the collector pages it (rowid order, limit, has_more, max_rowid), through the zod contract. */
class FakeCalls implements CallsSource {
  requests: CallsQuery[] = [];
  constructor(public log: RawCall[]) {}
  async calls(q: CallsQuery) {
    this.requests.push(q);
    const after = Number(q.after_rowid ?? 0);
    const limit = Number(q.limit ?? 500);
    const rows = this.log.filter((c) => c.rowid > after).sort((a, b) => a.rowid - b.rowid);
    const page = rows.slice(0, limit);
    return CallsResponse.parse({
      api: 'v1',
      generated_at: T0,
      items: page,
      next_after_rowid: page.length ? page[page.length - 1]!.rowid : after,
      has_more: rows.length > limit,
      max_rowid: Math.max(0, ...this.log.map((c) => c.rowid)),
    });
  }
}

function world() {
  const db = memDb();
  const alice = seedPerson(db, { display_name: 'Alice Avery', first_name: 'Alice', last_name: 'Avery' });
  const bea = seedPerson(db, { display_name: 'Bea Brook', first_name: 'Bea', last_name: 'Brook' });
  seedIdentity(db, alice, 'phone', '+12125550101');
  seedIdentity(db, alice, 'email', 'alice@example.com');
  seedIdentity(db, bea, 'phone', '+12125550102');
  return { db, alice, bea };
}

const interactions = (db: DB) =>
  db
    .prepare(`SELECT person_id, channel, started_at, ended_at, initiated_by_me, call_id FROM interactions WHERE kind = 'call' AND origin = 'derived' ORDER BY started_at, person_id`)
    .all() as { person_id: string; channel: string; started_at: number; ended_at: number | null; initiated_by_me: number; call_id: string }[];

describe('call log mapping', () => {
  it('maps CallHistory types and providers to a service', () => {
    expect(callService({ call_type: 1, provider: 'com.apple.Telephony' })).toBe('phone');
    expect(callService({ call_type: 8, provider: 'com.apple.FaceTime' })).toBe('facetime_video');
    expect(callService({ call_type: 16, provider: 'com.apple.FaceTime' })).toBe('facetime_audio');
    expect(callService({ call_type: null, provider: 'com.apple.FaceTime' })).toBe('facetime_audio');
    expect(callService({ call_type: null, provider: 'com.apple.Telephony' })).toBe('phone');
    expect(callService({ call_type: 2, provider: 'com.example.voip' })).toBe('other');
  });

  it('normalizes handles like identities and drops what no person can have', () => {
    expect(callHandleKeys(['(212) 555-0101', '+1 212-555-0101', 'Alice@Example.com', '12345', 'urn:biz:abc', ''])).toEqual([
      { kind: 'phone', key: '+12125550101' },
      { kind: 'email', key: 'alice@example.com' },
    ]);
  });
});

describe('ingestCalls', () => {
  it('stores every call, and links answered calls from known people as interactions', async () => {
    const { db, alice, bea } = world();
    const src = new FakeCalls([
      call(1, ['(212) 555-0101']),
      call(2, ['+12125550101'], { answered: false }),
      call(3, ['alice@example.com'], { call_type: 8, provider: 'com.apple.FaceTime', originated: true, duration_s: 754.4 }),
      call(4, ['+12125550199']),
      call(5, ['+12125550102', '+12125550101'], { call_type: 16, provider: 'com.apple.FaceTime' }),
    ]);
    const stats = await ingestCalls(db, src, { now: T0 });
    expect(stats).toMatchObject({ fetched: 5, inserted: 5, updated: 0 });
    expect(count(db, 'calls')).toBe(5);
    expect(count(db, 'call_handles')).toBe(6);
    expect(readCursor(db, 'calls')?.cursor).toBe('5');

    // Missed (2) and unknown (4) calls are stored but are not interactions; the group call counts for both.
    const rows = interactions(db);
    const byCall = (minute: number) => rows.filter((r) => r.started_at === T0 + minute * MIN).map((r) => `${r.person_id}:${r.channel}`).sort();
    expect(rows).toHaveLength(4);
    expect(byCall(1)).toEqual([`${alice}:phone`]);
    expect(byCall(3)).toEqual([`${alice}:facetime`]);
    expect(byCall(5)).toEqual([`${alice}:facetime`, `${bea}:facetime`].sort());
    const facetime = rows.find((r) => r.started_at === T0 + 3 * MIN)!;
    expect(facetime).toMatchObject({ initiated_by_me: 1, ended_at: T0 + 3 * MIN + 754_400 });
    expect(rows.find((r) => r.started_at === T0 + MIN)).toMatchObject({ ended_at: null, initiated_by_me: 0 });

    const health = db.prepare(`SELECT status, newest_data_at, details FROM source_health WHERE source = 'calls'`).get() as Record<string, unknown>;
    expect(health).toMatchObject({ status: 'ok', newest_data_at: T0 + 5 * MIN });
    expect(JSON.parse(health.details as string)).toEqual({ calls: 5, linked: 4 });
  });

  it('pages from the cursor, is idempotent, and picks up past calls when a number becomes a contact', async () => {
    const { db } = world();
    const src = new FakeCalls([call(1, ['+12125550101']), call(2, ['+12125550103']), call(3, ['+12125550101'])]);
    await ingestCalls(db, src, { now: T0 });
    expect(interactions(db)).toHaveLength(2);

    src.log.push(call(4, ['+12125550103']));
    const again = await ingestCalls(db, src, { now: T0 + 1 });
    expect(src.requests.at(-1)).toMatchObject({ after_rowid: 3 });
    expect(again).toMatchObject({ fetched: 1, inserted: 1, interactionsUpserted: 0, interactionsDeleted: 0 });

    // +12125550103 joins the book: both of its calls link on the next run, with nothing new fetched.
    const cleo = seedPerson(db, { display_name: 'Cleo Cole', first_name: 'Cleo', last_name: 'Cole' });
    seedIdentity(db, cleo, 'phone', '+12125550103');
    const linked = await ingestCalls(db, src, { now: T0 + 2 });
    expect(linked).toMatchObject({ fetched: 0, interactionsUpserted: 2 });
    expect(interactions(db).filter((r) => r.person_id === cleo)).toHaveLength(2);
  });

  it('pages through a long log and restarts when the call log was rebuilt', async () => {
    const { db } = world();
    const src = new FakeCalls(Array.from({ length: 1203 }, (_, i) => call(i + 1, ['+12125550101'])));
    expect((await ingestCalls(db, src, { now: T0 })).fetched).toBe(1203);
    expect(src.requests.map((r) => r.after_rowid)).toEqual([0, 500, 1000]);

    // A rebuilt store with lower rowids: re-read from 0, same unique ids update in place, new ones are added.
    src.log = [call(1, ['+12125550101']), call(2, ['+12125550101'], { unique_id: 'CALL-NEW1' })];
    const after = await ingestCalls(db, src, { now: T0 + 1 });
    expect(after).toMatchObject({ cursorReset: 1, fetched: 2, inserted: 1 });
    expect(count(db, 'calls')).toBe(1204);
    expect(readCursor(db, 'calls')?.cursor).toBe('2');
  });

  it('counts a call once per person (merged records included), never for me or a service', async () => {
    const { db, alice } = world();
    const dup = seedPerson(db, { display_name: 'Alice A', first_name: 'Alice' });
    seedIdentity(db, dup, 'phone', '+12125550104');
    db.prepare(`UPDATE people SET status = 'merged', merged_into_id = ? WHERE id = ?`).run(alice, dup);
    rebuildPersonCanon(db);
    const me = seedPerson(db, { display_name: 'Me', kind: 'me' });
    seedIdentity(db, me, 'phone', '+12125550100');
    const svc = seedPerson(db, { display_name: 'Pharmacy', status: 'service' });
    seedIdentity(db, svc, 'phone', '+12125550105');

    await ingestCalls(db, new FakeCalls([call(1, ['+12125550101', '+12125550104']), call(2, ['+12125550100']), call(3, ['+12125550105'])]), {
      now: T0,
    });
    const rows = interactions(db);
    expect(rows).toHaveLength(1);
    expect([alice, dup]).toContain(rows[0]!.person_id);
  });

  it('drops a derived call interaction when its identity is detached', async () => {
    const { db } = world();
    const src = new FakeCalls([call(1, ['+12125550102'])]);
    await ingestCalls(db, src, { now: T0 });
    expect(interactions(db)).toHaveLength(1);
    db.prepare(`UPDATE identities SET status = 'detached' WHERE key = '+12125550102'`).run();
    expect((await ingestCalls(db, src, { now: T0 + 1 })).interactionsDeleted).toBe(1);
    expect(interactions(db)).toHaveLength(0);
  });
});

describe('calls job', () => {
  const ctx = (db: DB) => ({ db, now: () => T0, jobRunId: 'run-1' }) as unknown as JobContext;
  const failing = (e: Error): CallsSource => ({ calls: () => Promise.reject(e) });
  const health = (db: DB) => db.prepare(`SELECT status, last_error FROM source_health WHERE source = 'calls'`).get();

  it('reports an outdated collector, missing access and a Mac without a call log without failing', async () => {
    for (const [err, status, stat] of [
      [new CollectorHttpError(404, 'not_found'), 'error', 'collector_outdated'],
      [new CollectorHttpError(503, 'fda_missing'), 'auth_required', 'access_denied'],
      [new CollectorHttpError(404, 'callhistory_unavailable'), 'disabled', 'no_call_history'],
      [new CollectorUnavailableError('unreachable', 'collector is not reachable (ECONNREFUSED)'), 'error', 'collector_unavailable'],
    ] as const) {
      const db = memDb();
      const [job] = callsJobs({ collectorUrl: 'http://127.0.0.1:4321', collectorTokenFile: '/nonexistent', client: failing(err) });
      const out = await job!.run(ctx(db));
      expect(out).toMatchObject({ status: 'skipped', stats: { [stat]: 1 } });
      expect(health(db)).toMatchObject({ status });
    }
  });

  it('fails on other collector errors', async () => {
    const db = memDb();
    const [job] = callsJobs({
      collectorUrl: 'http://127.0.0.1:4321',
      collectorTokenFile: '/nonexistent',
      client: failing(new CollectorHttpError(503, 'callhistory_unavailable')),
    });
    await expect(job!.run(ctx(db))).rejects.toThrow(CollectorHttpError);
    expect(health(db)).toMatchObject({ status: 'error', last_error: 'callhistory_unavailable' });
  });
});
