/**
 * Per-source bookkeeping shared by every adapter: source_cursors (one row per source + scope, e.g. a Beeper chat
 * id or a WhatsApp table watermark) and source_health (the Sources screen card). Both are class (S): plain writes,
 * never journaled. Error text stored here is shown on the Sources screen after redact(); pass error classes and
 * counts, never message text, names or tokens.
 */
import type { DB } from '../../db/connection';

export interface CursorRow {
  cursor: string;
  high_water_at: number | null;
  meta: string | null;
  updated_at: number;
}

export function readCursor(db: DB, source: string, scope = ''): CursorRow | undefined {
  return db.prepare('SELECT cursor, high_water_at, meta, updated_at FROM source_cursors WHERE source = ? AND scope = ?').get(source, scope) as
    | CursorRow
    | undefined;
}

/** Parsed `meta` JSON of a cursor ({} when absent or unreadable). */
export function cursorMeta<T extends object = Record<string, unknown>>(row: CursorRow | undefined): Partial<T> {
  if (!row?.meta) return {};
  try {
    return JSON.parse(row.meta) as Partial<T>;
  } catch {
    return {};
  }
}

/** Upserts a cursor. high_water_at only moves forward; meta is replaced when given, kept otherwise. */
export function writeCursor(
  db: DB,
  source: string,
  scope: string,
  cursor: string,
  now: number,
  o: { highWaterAt?: number | null; meta?: Record<string, unknown> } = {},
): void {
  db.prepare(
    `INSERT INTO source_cursors (source, scope, cursor, high_water_at, meta, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (source, scope) DO UPDATE SET cursor = excluded.cursor,
       high_water_at = CASE WHEN excluded.high_water_at IS NULL THEN source_cursors.high_water_at
         ELSE max(coalesce(source_cursors.high_water_at, excluded.high_water_at), excluded.high_water_at) END,
       meta = coalesce(excluded.meta, source_cursors.meta), updated_at = excluded.updated_at`,
  ).run(source, scope, cursor, o.highWaterAt ?? null, o.meta ? JSON.stringify(o.meta) : null, now);
}

export function deleteCursor(db: DB, source: string, scope: string): boolean {
  return db.prepare('DELETE FROM source_cursors WHERE source = ? AND scope = ?').run(source, scope).changes > 0;
}

export type SourceHealthStatus = 'ok' | 'stale' | 'error' | 'auth_required' | 'contract_broken' | 'disabled' | 'unknown';

export interface HealthUpdate {
  /** Short, scrubbed reason (an error class or a fixed sentence). Cleared on 'ok'. */
  error?: string | null;
  /** Freshness of the source's data; defaults to its newest message. */
  newestDataAt?: number | null;
  /** Counts / flags for the Sources card (no handles, names or text). */
  details?: Record<string, unknown> | null;
}

/** Records a source's status for the Sources screen; last_ok_at advances only on 'ok'. */
export function recordSourceHealth(db: DB, source: string, now: number, status: SourceHealthStatus, o: HealthUpdate = {}): void {
  const newest =
    o.newestDataAt !== undefined
      ? o.newestDataAt
      : ((db.prepare('SELECT max(sent_at) FROM messages WHERE source = ?').pluck().get(source) as number | null) ?? null);
  db.prepare(
    `INSERT INTO source_health (source, status, last_ok_at, newest_data_at, last_error, details, checked_at)
     VALUES (@source, @status, @ok, @newest, @error, @details, @now)
     ON CONFLICT (source) DO UPDATE SET status = excluded.status, last_ok_at = coalesce(excluded.last_ok_at, source_health.last_ok_at),
       newest_data_at = coalesce(excluded.newest_data_at, source_health.newest_data_at), last_error = excluded.last_error,
       details = coalesce(excluded.details, source_health.details), checked_at = excluded.checked_at`,
  ).run({
    source,
    status,
    ok: status === 'ok' ? now : null,
    newest,
    error: status === 'ok' ? null : (o.error ?? null),
    details: o.details ? JSON.stringify(o.details) : null,
    now,
  });
}
