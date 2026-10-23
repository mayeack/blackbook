/**
 * The Mac's call log (collector GET /v1/calls → calls + call_handles, migration 025). Class (S): plain upserts by
 * CallHistory unique id, never journaled. Paged by CallHistory rowid from the 'calls' cursor; a store whose
 * max rowid is below the cursor was rebuilt, so the cursor restarts at 0 (upserts make the re-read harmless).
 * Handles are normalized like identities.key (phone E.164 / email); short codes and other ids are dropped. After
 * every run the derived 'call' interactions are rebuilt (interactions.ts), which also links calls from numbers that
 * became contacts since. Nothing here is logged but counts.
 */
import { uuidv7 } from '@yb/shared';
import type { CallRecord, CallsQuery, CallsResponse } from '@yb/shared/collector/v1';
import type { DB } from '../../db/connection';
import { tx } from '../../db/tx';
import { handleKey } from '../../identity/resolver';
import { readCursor, recordSourceHealth, writeCursor } from '../common/cursors';
import { rebuildCallInteractions } from './interactions';

export const SOURCE = 'calls';
const PAGE = 500;

export interface CallsSource {
  calls(q: CallsQuery): Promise<CallsResponse>;
}

export type CallService = 'phone' | 'facetime_audio' | 'facetime_video' | 'other';

/** ZCALLTYPE 1 phone, 8 FaceTime video, 16 FaceTime audio; the provider decides when the type is unknown. */
export function callService(r: Pick<CallRecord, 'call_type' | 'provider'>): CallService {
  const facetime = r.provider === 'com.apple.FaceTime';
  if (r.call_type === 8) return 'facetime_video';
  if (r.call_type === 16 || facetime) return 'facetime_audio';
  if (r.call_type === 1 || r.provider === 'com.apple.Telephony') return 'phone';
  return 'other';
}

/** The timeline channel: FaceTime or phone (a third-party call app shows as a phone call). */
export const callChannel = (s: CallService): 'phone' | 'facetime' => (s.startsWith('facetime') ? 'facetime' : 'phone');

/** Raw handles → distinct identity keys a person can have (phone / email). */
export function callHandleKeys(raw: readonly string[]): { kind: 'phone' | 'email'; key: string }[] {
  const out = new Map<string, { kind: 'phone' | 'email'; key: string }>();
  for (const h of raw) {
    const k = handleKey(h);
    if (k && (k.kind === 'phone' || k.kind === 'email')) out.set(`${k.kind}:${k.key}`, { kind: k.kind, key: k.key });
  }
  return [...out.values()];
}

export interface CallsIngestStats {
  fetched: number;
  inserted: number;
  updated: number;
  cursorReset: number;
  interactionsUpserted: number;
  interactionsDeleted: number;
}

export async function ingestCalls(db: DB, client: CallsSource, o: { now: number }): Promise<CallsIngestStats> {
  const stats: CallsIngestStats = { fetched: 0, inserted: 0, updated: 0, cursorReset: 0, interactionsUpserted: 0, interactionsDeleted: 0 };
  let after = Number(readCursor(db, SOURCE)?.cursor ?? 0) || 0;

  const find = db.prepare('SELECT id FROM calls WHERE source_uid = ?').pluck();
  const insert = db.prepare(
    `INSERT INTO calls (id, source_uid, source_rowid, started_at, duration_ms, service, outgoing, answered, created_at, updated_at)
     VALUES (@id, @uid, @rowid, @started_at, @duration_ms, @service, @outgoing, @answered, @now, @now)`,
  );
  const update = db.prepare(
    `UPDATE calls SET source_rowid = @rowid, started_at = @started_at, duration_ms = @duration_ms, service = @service,
       outgoing = @outgoing, answered = @answered, updated_at = @now
     WHERE id = @id AND (source_rowid IS NOT @rowid OR started_at IS NOT @started_at OR duration_ms IS NOT @duration_ms
       OR service IS NOT @service OR outgoing IS NOT @outgoing OR answered IS NOT @answered)`,
  );
  const clearHandles = db.prepare('DELETE FROM call_handles WHERE call_id = ?');
  const addHandle = db.prepare('INSERT OR IGNORE INTO call_handles (call_id, kind, key) VALUES (?, ?, ?)');

  for (;;) {
    const from = after;
    const page = await client.calls({ after_rowid: after, limit: PAGE });
    if (page.max_rowid !== null && page.max_rowid < after) {
      // The call log was rebuilt (or restored): read it again from the start.
      stats.cursorReset++;
      after = 0;
      writeCursor(db, SOURCE, '', '0', o.now);
      continue;
    }
    tx(db, () => {
      for (const r of page.items) {
        stats.fetched++;
        const row = {
          uid: r.unique_id,
          rowid: r.rowid,
          started_at: r.date,
          duration_ms: Math.round(r.duration_s * 1000),
          service: callService(r),
          outgoing: r.originated ? 1 : 0,
          answered: r.answered ? 1 : 0,
          now: o.now,
        };
        const existing = find.get(r.unique_id) as string | undefined;
        const id = existing ?? uuidv7(r.date);
        if (existing) stats.updated += update.run({ ...row, id }).changes;
        else stats.inserted += insert.run({ ...row, id }).changes;
        clearHandles.run(id);
        for (const k of callHandleKeys(r.handles)) addHandle.run(id, k.kind, k.key);
      }
      after = page.next_after_rowid ?? after;
      writeCursor(db, SOURCE, '', String(after), o.now);
    });
    if (!page.has_more || after <= from) break;
  }

  const derived = rebuildCallInteractions(db, o.now);
  stats.interactionsUpserted = derived.upserted;
  stats.interactionsDeleted = derived.deleted;
  const totals = db.prepare('SELECT count(*) AS n, max(started_at) AS newest FROM calls').get() as { n: number; newest: number | null };
  recordSourceHealth(db, SOURCE, o.now, 'ok', { newestDataAt: totals.newest, details: { calls: totals.n, linked: derived.linked } });
  return stats;
}
