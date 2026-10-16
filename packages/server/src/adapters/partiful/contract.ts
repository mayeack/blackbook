/**
 * Contract check against Partiful's own texts (PLAN "Tolerance"; research: "if chat.db shows an invite for an
 * event the API didn't return, the integration has probably broken"). partiful_text_signals (iMessage ingest)
 * holds the event ids Partiful texted about. An id first texted more than 24 h ago that no list returned is
 * probed once a week with getEventInfo (≤5 per run): found → it becomes a normal event; NOT_FOUND /
 * PERMISSION_DENIED explains it (deleted, or I was removed); anything left is a warning on the Sources card.
 */
import type { DB } from '../../db/connection';

const DAY = 86_400_000;
export const TEXT_GRACE_MS = DAY;
export const REPROBE_MS = 7 * DAY;
const ID_RE = /^[A-Za-z0-9_-]{1,200}$/;

export interface TextEventGap {
  eventId: string;
  firstTextAt: number;
  lastTextAt: number;
  probeStatus: string | null;
  probeAt: number | null;
}

/** Text-only event ids past the 24 h grace period, most recently texted first. */
export function textEventGaps(db: DB, now: number): TextEventGap[] {
  const rows = db
    .prepare(
      `SELECT t.event_id AS eventId, min(t.sent_at) AS firstTextAt, max(t.sent_at) AS lastTextAt, s.probe_status AS probeStatus, s.probe_at AS probeAt
       FROM partiful_text_signals t
       LEFT JOIN partiful_event_sync s ON s.event_id = t.event_id
       WHERE t.event_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM events e WHERE e.source = 'partiful' AND e.source_event_id = t.event_id)
       GROUP BY t.event_id
       HAVING min(t.sent_at) <= ?
       ORDER BY lastTextAt DESC`,
    )
    .all(now - TEXT_GRACE_MS) as TextEventGap[];
  return rows.filter((r) => ID_RE.test(r.eventId));
}

/** Gaps worth a getEventInfo call now. */
export const probeCandidates = (gaps: readonly TextEventGap[], now: number, limit: number): TextEventGap[] =>
  gaps.filter((g) => g.probeAt === null || g.probeAt < now - REPROBE_MS).slice(0, limit);

/** Gaps that remain unexplained (the warning count). */
export const unexplainedGaps = (gaps: readonly TextEventGap[]): TextEventGap[] =>
  gaps.filter((g) => g.probeStatus !== 'not_found' && g.probeStatus !== 'forbidden');

export function recordProbe(db: DB, eventId: string, now: number, status: 'found' | 'not_found' | 'forbidden' | 'error'): void {
  db.prepare(
    `INSERT INTO partiful_event_sync (event_id, probe_at, probe_status, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (event_id) DO UPDATE SET probe_at = excluded.probe_at, probe_status = excluded.probe_status, updated_at = excluded.updated_at`,
  ).run(eventId, now, status, now);
}
