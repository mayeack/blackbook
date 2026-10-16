/**
 * Deterministic links a guard held (intelligence §1.2: "the union is held and an alert is raised"). The pair is kept
 * next to the matcher's held pairs as a match_candidates row (status 'held', guards_failed, features.link =
 * {kind, reason, source}) and one deduped alert (source 'identity-link') counts the open ones. The nightly matcher
 * keeps these rows until the two are one person. Counts and kinds only: never handles, keys or names.
 */
import { uuidv7 } from '@yb/shared';
import type { DB } from '../db/connection';

export const LINK_ALERT_SOURCE = 'identity-link';

export type HeldLinkReason = 'co_presence' | 'distinct_cards' | 'priority_absorbed';
const GUARD: Record<HeldLinkReason, string> = { co_presence: 'G2', distinct_cards: 'G4', priority_absorbed: 'G7' };

/** SQL predicate (unqualified, on match_candidates): the row records a held deterministic link. */
export const IS_LINK_ROW = `json_extract(features, '$.link') IS NOT NULL`;

export function recordHeldLink(
  db: DB,
  x: string,
  y: string,
  o: { reason: HeldLinkReason; identityKind: string; source: string; confidence: number | null; now: number },
): void {
  if (x === y) return;
  const [a, b] = x < y ? [x, y] : [y, x];
  const link = JSON.stringify({ kind: o.identityKind, reason: o.reason, source: o.source });
  db.prepare(
    `INSERT INTO match_candidates (a_id, b_id, score_bits, p, families, guards_failed, status, features, scored_at, created_at, updated_at)
     VALUES (@a, @b, 0, @p, '["deterministic"]', @guards, 'held', json_object('link', json(@link)), @now, @now, @now)
     ON CONFLICT (a_id, b_id) DO UPDATE SET guards_failed = excluded.guards_failed,
       features = json_set(match_candidates.features, '$.link', json(@link)),
       status = CASE WHEN match_candidates.status = 'dismissed' THEN 'dismissed' ELSE 'held' END,
       updated_at = excluded.updated_at`,
  ).run({ a, b, p: Math.min(1, Math.max(0, o.confidence ?? 1)), guards: JSON.stringify([GUARD[o.reason]]), link, now: o.now });
  refreshLinkAlert(db, o.now);
}

/** Opens, updates or resolves the one 'identity-link' alert from the held link rows. */
export function refreshLinkAlert(db: DB, now: number): number {
  const held = db.prepare(`SELECT count(*) FROM match_candidates WHERE status = 'held' AND ${IS_LINK_ROW}`).pluck().get() as number;
  if (!held) {
    db.prepare('UPDATE alerts SET resolved_at = ? WHERE source = ? AND resolved_at IS NULL').run(now, LINK_ALERT_SOURCE);
    return 0;
  }
  const message = `${held} link${held === 1 ? '' : 's'} from your sources held by a safety check: the people stay separate until you review ${held === 1 ? 'it' : 'them'}`;
  db.prepare(`INSERT OR IGNORE INTO alerts (id, source, severity, message, opened_at) VALUES (?, ?, 'warning', ?, ?)`).run(uuidv7(now), LINK_ALERT_SOURCE, message, now);
  db.prepare('UPDATE alerts SET message = ? WHERE source = ? AND resolved_at IS NULL').run(message, LINK_ALERT_SOURCE);
  return held;
}
