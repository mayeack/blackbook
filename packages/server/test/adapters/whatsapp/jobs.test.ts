import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { MockAgent } from 'undici';
import type { Health, WhatsAppSnapshotResponse } from '@yb/shared/collector/v1';
import { EVERY_MS, HEALTH_MESSAGES, runWhatsapp, STALE_AFTER_MS, WhatsAppSchemaError, whatsappJobs } from '../../../src/adapters/whatsapp/jobs';
import {
  CollectorContractError,
  CollectorHttpError,
  CollectorUnavailableError,
  WhatsAppCollector,
  type WhatsAppCollectorApi,
} from '../../../src/adapters/whatsapp/snapshot';
import { buildJobs } from '../../../src/scheduler/jobs/index';
import { memDb, seedIdentity, seedPerson, T0, tempDir } from '../../helpers';
import { CHAT_SCHEMA, jid, WaFixture } from './fixture';

type DB = ReturnType<typeof memDb>;
const MIN = 60_000;
const HOUR = 60 * MIN;
const ALEX = '+15125550101';
/** A placeholder origin, never the real collector port: the MockAgents answer and refuse everything else. */
const BASE = 'http://127.0.0.1:9';

const fixtures: WaFixture[] = [];
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) f.close();
  for (const c of cleanups.splice(0)) await c();
});

const healthRow = (db: DB) =>
  db.prepare(`SELECT status, last_error, newest_data_at, details FROM source_health WHERE source = 'whatsapp'`).get() as
    | { status: string; last_error: string | null; newest_data_at: number | null; details: string | null }
    | undefined;

const healthBody = (running: boolean): Health =>
  ({
    version: '1.0.0',
    build: '1',
    macos: '27.0',
    uptime_s: 10,
    permissions: { fda: 'granted', contacts: 'granted', automation_messages: 'granted' },
    chatdb: { max_rowid: 1, newest_at: T0 },
    whatsapp: { installed: true, running, container_mtime: T0 },
    messages_app_running: true,
  }) as Health;

/** A collector stand-in: returns the given snapshot (or throws), and a health with `running`. */
function fakeClient(o: { snap?: () => WhatsAppSnapshotResponse; error?: Error; running?: boolean; healthFails?: boolean }) {
  const calls: string[] = [];
  const client: WhatsAppCollectorApi = {
    async snapshot() {
      calls.push('snapshot');
      if (o.error) throw o.error;
      return o.snap!();
    },
    async health() {
      calls.push('health');
      if (o.healthFails) throw new CollectorUnavailableError('unreachable', 'collector is not reachable (ECONNREFUSED)');
      return healthBody(o.running ?? true);
    },
  };
  return { client, calls };
}

function snapOf(f: WaFixture, o: { unchanged?: boolean; mtime?: number } = {}): WhatsAppSnapshotResponse {
  return {
    unchanged: o.unchanged ?? false,
    snapshot_dir: f.dir,
    files: f.files(),
    source_mtime: o.mtime ?? T0,
    max_pk: null,
    bytes: 1,
  } as WhatsAppSnapshotResponse;
}

function world() {
  const db = memDb();
  const me = seedPerson(db, { kind: 'me', display_name: 'Me' });
  seedIdentity(db, me, 'phone', '+15125550100');
  const f = new WaFixture();
  fixtures.push(f);
  const dm = f.addSession(jid(ALEX), 0, 'Alex Rivera');
  f.addMessage({ session: dm, at: T0, text: 'synthetic hello' });
  f.addMessage({ session: dm, from: 'me', at: T0 + MIN, text: 'synthetic reply' });
  return { db, f, dm };
}

describe('whatsapp job', () => {
  it('is registered every 30 min once the collector is configured', () => {
    const jobs = buildJobs({ config: { backupDir: '/tmp/yb-x/b', logDir: '/tmp/yb-x/l', collectorTokenFile: '/tmp/yb-x/collector.token' } });
    const wa = jobs.find((j) => j.name === 'whatsapp');
    expect(wa?.schedule).toEqual({ kind: 'interval', everyMs: EVERY_MS });
    expect(EVERY_MS).toBe(30 * MIN);
  });

  it('WhatsApp not installed → disabled "Link WhatsApp for Mac", skipped, no error', async () => {
    const db = memDb();
    const { client } = fakeClient({ error: new CollectorHttpError(404, 'whatsapp_not_installed') });
    const out = await runWhatsapp(db, client, { now: T0 });
    expect(out).toEqual({ status: 'skipped', stats: { not_installed: 1 } });
    expect(healthRow(db)).toMatchObject({ status: 'disabled', last_error: HEALTH_MESSAGES.notLinked });
  });

  it('a store that was never linked is disabled too', async () => {
    const db = memDb();
    const f = new WaFixture({ chatSchema: 'CREATE TABLE Z_METADATA (Z_VERSION INTEGER PRIMARY KEY)', contacts: false, lid: false });
    fixtures.push(f);
    const out = await runWhatsapp(db, fakeClient({ snap: () => snapOf(f) }).client, { now: T0 });
    expect(out).toEqual({ status: 'skipped', stats: { not_linked: 1 } });
    expect(healthRow(db)).toMatchObject({ status: 'disabled', last_error: HEALTH_MESSAGES.notLinked });
  });

  it('ingests, then reports ok with counts (no names, numbers or text in the card)', async () => {
    const { db, f } = world();
    const out = await runWhatsapp(db, fakeClient({ snap: () => snapOf(f), running: true }).client, { now: T0 + HOUR });
    expect(out).toMatchObject({ status: 'ok', stats: { messages_new: 2 } });
    const h = healthRow(db)!;
    expect(h).toMatchObject({ status: 'ok', last_error: null, newest_data_at: T0 + MIN });
    expect(JSON.parse(h.details!)).toEqual({ chats: 1, groups: 0, lid_mapped: 0, lid_unmapped: 0, app_running: true });
    expect(h.details).not.toMatch(/Alex|5550101|synthetic/);
  });

  it('an unchanged snapshot that was fully ingested is not read again', async () => {
    const { db, f } = world();
    await runWhatsapp(db, fakeClient({ snap: () => snapOf(f, { mtime: T0 }) }).client, { now: T0 + HOUR });
    // Same mtime, unchanged: the files aren't even opened (they are gone).
    const gone = { ...snapOf(f, { unchanged: true, mtime: T0 }), files: { chat: path.join(f.dir, 'missing.sqlite'), contacts: null, lid: null } };
    const out = await runWhatsapp(db, fakeClient({ snap: () => gone }).client, { now: T0 + 2 * HOUR });
    expect(out).toEqual({ status: 'ok', stats: { unchanged: 1 } });
    expect(healthRow(db)!.status).toBe('ok');
    // A changed mtime is read even when the collector reused the directory.
    const again = await runWhatsapp(db, fakeClient({ snap: () => snapOf(f, { unchanged: true, mtime: T0 + 5 }) }).client, { now: T0 + 3 * HOUR });
    expect(again?.stats?.unchanged).toBeUndefined();
  });

  it('stale: newest message older than 72 h while WhatsApp runs; or the app not running', async () => {
    const { db, f } = world();
    await runWhatsapp(db, fakeClient({ snap: () => snapOf(f), running: true }).client, { now: T0 + MIN + STALE_AFTER_MS + 1 });
    expect(healthRow(db)).toMatchObject({ status: 'stale', last_error: HEALTH_MESSAGES.stale });

    await runWhatsapp(db, fakeClient({ snap: () => snapOf(f, { mtime: T0 + 1 }), running: false }).client, { now: T0 + 2 * HOUR });
    expect(healthRow(db)).toMatchObject({ status: 'stale', last_error: HEALTH_MESSAGES.notRunning });

    // A failed health call leaves running unknown: only the 72 h rule applies.
    await runWhatsapp(db, fakeClient({ snap: () => snapOf(f, { mtime: T0 + 2 }), healthFails: true }).client, { now: T0 + 2 * HOUR });
    expect(healthRow(db)!.status).toBe('ok');
  });

  it('a schema change is contract_broken: the job fails and nothing is written', async () => {
    const db = memDb();
    const f = new WaFixture({ chatSchema: CHAT_SCHEMA.replace('ZMEMBERJID VARCHAR', 'ZMEMBERID VARCHAR') });
    fixtures.push(f);
    f.addSession(jid(ALEX), 0, null);
    const err = await runWhatsapp(db, fakeClient({ snap: () => snapOf(f) }).client, { now: T0 }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(WhatsAppSchemaError);
    expect((err as WhatsAppSchemaError).missing).toEqual(['main.ZWAGROUPMEMBER.ZMEMBERJID']);
    expect(healthRow(db)).toMatchObject({ status: 'contract_broken' });
    expect(healthRow(db)!.last_error).toContain('ZWAGROUPMEMBER.ZMEMBERJID');
    expect(db.prepare('SELECT count(*) FROM conversations').pluck().get()).toBe(0);
  });

  it('collector problems: unavailable is skipped, a contract break and FDA missing fail', async () => {
    const db = memDb();
    const skip = await runWhatsapp(db, fakeClient({ error: new CollectorUnavailableError('token_missing', 'collector token file does not exist yet') }).client, {
      now: T0,
    });
    expect(skip).toEqual({ status: 'skipped', stats: { collector_unavailable: 1 } });
    expect(healthRow(db)!.status).toBe('auth_required');

    const busy = await runWhatsapp(db, fakeClient({ error: new CollectorHttpError(503, 'snapshot_inconsistent') }).client, { now: T0 });
    expect(busy).toMatchObject({ status: 'skipped' });

    await expect(runWhatsapp(db, fakeClient({ error: new CollectorContractError('whatsapp_snapshot', 1, ['files']) }).client, { now: T0 })).rejects.toThrow(
      CollectorContractError,
    );
    expect(healthRow(db)!.status).toBe('contract_broken');
    await expect(runWhatsapp(db, fakeClient({ error: new CollectorHttpError(503, 'fda_missing') }).client, { now: T0 })).rejects.toThrow(CollectorHttpError);
    expect(healthRow(db)).toMatchObject({ status: 'error' });
  });

  it('runs through the scheduler job definition', async () => {
    const { db, f } = world();
    const [job] = whatsappJobs({ collectorUrl: BASE, collectorTokenFile: '/nonexistent', client: fakeClient({ snap: () => snapOf(f) }).client });
    const out = await job!.run({
      db,
      jobRunId: 1,
      trigger: 'manual',
      now: () => T0 + HOUR,
      log: { info() {}, warn() {}, error() {}, debug() {} } as never,
      signal: new AbortController().signal,
    });
    expect(out).toMatchObject({ status: 'ok' });
  });
});

describe('WhatsAppCollector (HTTP)', () => {
  function collector() {
    const t = tempDir('yb-wa-collector-');
    const tokenFile = path.join(t.dir, 'collector.token');
    fs.writeFileSync(tokenFile, 'synthetic-token\n', { mode: 0o600 });
    const agent = new MockAgent();
    agent.disableNetConnect();
    cleanups.push(async () => {
      await agent.close();
      t.cleanup();
    });
    return { agent, client: new WhatsAppCollector({ baseUrl: BASE, tokenFile, dispatcher: agent }) };
  }

  const okBody = {
    api: 'v1',
    generated_at: '2026-10-14T12:00:00Z',
    unchanged: false,
    snapshot_dir: '/tmp/yb-x/snapshots/whatsapp/20261014T120000.000Z',
    files: { chat: '/tmp/yb-x/s/ChatStorage.sqlite', contacts: '/tmp/yb-x/s/ContactsV2.sqlite', lid: null },
    source_mtime: '2026-10-14T11:59:00Z',
    max_pk: 42,
    bytes: 1024,
  };

  it('POSTs a JSON body with the Bearer token and parses the snapshot', async () => {
    const { agent, client } = collector();
    let seen: { headers: Record<string, string>; body: string } | null = null;
    agent
      .get(BASE)
      .intercept({ path: '/v1/whatsapp/snapshot', method: 'POST' })
      .reply((opts) => {
        seen = { headers: opts.headers as Record<string, string>, body: String(opts.body) };
        return { statusCode: 200, data: okBody };
      });
    const snap = await client.snapshot({ force: true });
    expect(snap).toMatchObject({ unchanged: false, max_pk: 42, files: { lid: null }, source_mtime: Date.parse('2026-10-14T11:59:00Z') });
    expect(seen!.headers.authorization).toBe('Bearer synthetic-token');
    expect(seen!.headers['content-type']).toBe('application/json');
    expect(JSON.parse(seen!.body)).toEqual({ force: true });
  });

  it('maps whatsapp_not_installed and contract breaks without echoing bodies', async () => {
    const { agent, client } = collector();
    const pool = agent.get(BASE);
    pool.intercept({ path: '/v1/whatsapp/snapshot', method: 'POST' }).reply(404, { error: { code: 'whatsapp_not_installed', message: 'WhatsApp for Mac data not found' } });
    pool.intercept({ path: '/v1/whatsapp/snapshot', method: 'POST' }).reply(200, { ...okBody, files: { chat: 7 } });
    const e1 = await client.snapshot().catch((e: Error) => e);
    expect(e1).toBeInstanceOf(CollectorHttpError);
    expect((e1 as CollectorHttpError).code).toBe('whatsapp_not_installed');
    const e2 = await client.snapshot().catch((e: Error) => e);
    expect(e2).toBeInstanceOf(CollectorContractError);
    expect((e2 as CollectorContractError).paths).toEqual(['files.chat']);
  });

  it('a missing token file is CollectorUnavailableError(token_missing)', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    cleanups.push(() => agent.close());
    const client = new WhatsAppCollector({ baseUrl: BASE, tokenFile: '/nonexistent/collector.token', dispatcher: agent });
    const e = await client.health().catch((x: Error) => x);
    expect(e).toBeInstanceOf(CollectorUnavailableError);
    expect((e as CollectorUnavailableError).reason).toBe('token_missing');
  });
});
