/**
 * What counted attendance does (PLAN step 5), both derived (D) and rebuilt from the attendee rows on every run, so
 * undoing an attendee (its row becomes 'rejected') takes its effects away on the next pass:
 *   - interactions(kind 'occasion', origin 'derived', units 1.5) for each counted attendee of a social occasion
 *     that has started; skipped when the linked Partiful event already gave that person an 'event' interaction;
 *   - edge_evidence(type 'co_attend', ref 'occ:<id>') between every pair of counted attendees:
 *     w_raw = s_a·s_b / log2(1 + n), s = attendee confidence, n = counted attendees + the owner (or the Partiful
 *     going count when larger). Age decay is the aggregator's job (it reads `at`). A pair the Partiful event
 *     already links (ref 'event:<id>') is not counted twice.
 * Counted = confidence ≥ 0.75, a going/attended status, a visible (canonical) person, an active, social,
 * non-sensitive occasion.
 */
import { uuidv7 } from '@yb/shared';
import type { DB } from '../../db/connection';
import { tx } from '../../db/tx';
import { COUNTED } from './signals';

export const OCCASION_UNITS = 1.5;
const COUNTED_STATUSES = ['going', 'attended', 'approved', 'checked_in', 'host'];
const PARTIFUL_GOING = ['going', 'approved', 'checked_in', 'attended', 'host'];

export interface EffectStats {
  interactionsUpserted: number;
  interactionsDeleted: number;
  edgesUpserted: number;
  edgesDeleted: number;
}

interface CountedRow {
  occasion_id: string;
  person_id: string;
  confidence: number;
  source: string;
  starts_at: number;
  ends_at: number | null;
  event_id: string | null;
}

/** Counted attendees of started, active, social, unmerged occasions: one row per (occasion, visible canonical person). */
export function countedAttendees(db: DB, now: number): CountedRow[] {
  return db
    .prepare(
      `SELECT a.occasion_id, pc.canonical_id AS person_id, max(a.confidence) AS confidence,
              CASE WHEN max(a.source = 'partiful') = 1 THEN 'partiful' ELSE 'calendar' END AS source,
              o.starts_at, o.ends_at, o.event_id
       FROM event_attendees a
       JOIN occasions o ON o.id = a.occasion_id
       JOIN person_canon pc ON pc.person_id = a.person_id
       JOIN person_visible pv ON pv.id = pc.canonical_id
       WHERE a.occasion_id IS NOT NULL AND a.confidence >= @counted AND a.status IN (SELECT value FROM json_each(@statuses))
         AND o.merged_into_id IS NULL AND o.status = 'active' AND o.is_social = 1 AND o.sensitive = 0 AND o.starts_at <= @now
       GROUP BY a.occasion_id, pc.canonical_id
       ORDER BY a.occasion_id, pc.canonical_id`,
    )
    .all({ counted: COUNTED, statuses: JSON.stringify(COUNTED_STATUSES), now }) as CountedRow[];
}

const r4 = (n: number) => Math.round(n * 10_000) / 10_000;

export function deriveOccasionEffects(db: DB, now: number): EffectStats {
  return tx(db, () => {
    const stats: EffectStats = { interactionsUpserted: 0, interactionsDeleted: 0, edgesUpserted: 0, edgesDeleted: 0 };
    const counted = countedAttendees(db, now);

    // ---------------------------------------------------------------- interactions
    const partifulTouch = db.prepare(
      `SELECT 1 FROM interactions i JOIN person_canon pc ON pc.person_id = i.person_id
       WHERE pc.canonical_id = ? AND i.kind = 'event' AND i.event_id = ? AND i.retracted_at IS NULL LIMIT 1`,
    );
    const want = new Map<string, CountedRow>();
    for (const r of counted) {
      if (r.event_id && partifulTouch.get(r.person_id, r.event_id)) continue;
      want.set(`${r.person_id}|${r.occasion_id}`, r);
    }
    const existing = db
      .prepare(`SELECT id, person_id, occasion_id, started_at, ended_at, units, channel, retracted_at FROM interactions WHERE origin = 'derived' AND kind = 'occasion'`)
      .all() as { id: string; person_id: string; occasion_id: string; started_at: number; ended_at: number | null; units: number | null; channel: string | null; retracted_at: number | null }[];
    const del = db.prepare('DELETE FROM interactions WHERE id = ?');
    const seen = new Set<string>();
    for (const e of existing) {
      const k = `${e.person_id}|${e.occasion_id}`;
      if (!want.has(k) || seen.has(k)) {
        stats.interactionsDeleted += del.run(e.id).changes;
        continue;
      }
      seen.add(k);
    }
    const upsert = db.prepare(
      `INSERT INTO interactions (id, person_id, kind, channel, occasion_id, started_at, ended_at, units, origin, created_at, updated_at)
       VALUES (@id, @person_id, 'occasion', @channel, @occasion_id, @started_at, @ended_at, @units, 'derived', @now, @now)
       ON CONFLICT (dedupe_key) WHERE origin = 'derived' DO UPDATE SET started_at = excluded.started_at, ended_at = excluded.ended_at,
         units = excluded.units, channel = excluded.channel, retracted_at = NULL, updated_at = excluded.updated_at
       WHERE started_at IS NOT excluded.started_at OR ended_at IS NOT excluded.ended_at OR units IS NOT excluded.units
         OR channel IS NOT excluded.channel OR retracted_at IS NOT NULL`,
    );
    for (const r of want.values()) {
      stats.interactionsUpserted += upsert.run({
        id: uuidv7(now),
        person_id: r.person_id,
        channel: r.source === 'partiful' ? 'partiful' : 'calendar',
        occasion_id: r.occasion_id,
        started_at: r.starts_at,
        ended_at: r.ends_at,
        units: OCCASION_UNITS,
        now,
      }).changes;
    }

    // ---------------------------------------------------------------- co_attend edges
    const goingCount = db
      .prepare(`SELECT count(DISTINCT person_id) FROM event_attendees WHERE event_id = ? AND lower(status) IN (SELECT value FROM json_each(?))`)
      .pluck();
    const partifulPair = db.prepare(`SELECT 1 FROM edge_evidence WHERE a_id = ? AND b_id = ? AND type = 'co_attend' AND ref = ? LIMIT 1`);
    const byOcc = new Map<string, CountedRow[]>();
    for (const r of counted) byOcc.set(r.occasion_id, [...(byOcc.get(r.occasion_id) ?? []), r]);
    const edges = new Map<string, { a: string; b: string; ref: string; at: number; w: number }>();
    for (const [occ, list] of byOcc) {
      if (list.length < 2) continue;
      const eventId = list[0]!.event_id;
      const n = Math.max(list.length + 1, eventId ? ((goingCount.get(eventId, JSON.stringify(PARTIFUL_GOING)) as number) ?? 0) : 0);
      const scale = 1 / Math.log2(1 + n);
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const [x, y] = list[i]!.person_id < list[j]!.person_id ? [list[i]!, list[j]!] : [list[j]!, list[i]!];
          if (eventId && partifulPair.get(x.person_id, y.person_id, `event:${eventId}`)) continue;
          const ref = `occ:${occ}`;
          edges.set(`${x.person_id}|${y.person_id}|${ref}`, {
            a: x.person_id,
            b: y.person_id,
            ref,
            at: x.starts_at,
            w: r4(Math.min(1, x.confidence) * Math.min(1, y.confidence) * scale),
          });
        }
      }
    }
    const current = db
      .prepare(`SELECT id, a_id, b_id, ref, at, w_raw FROM edge_evidence WHERE type = 'co_attend' AND ref LIKE 'occ:%'`)
      .all() as { id: number; a_id: string; b_id: string; ref: string; at: number | null; w_raw: number }[];
    const delEdge = db.prepare('DELETE FROM edge_evidence WHERE id = ?');
    const updEdge = db.prepare('UPDATE edge_evidence SET at = ?, w_raw = ? WHERE id = ?');
    for (const e of current) {
      const k = `${e.a_id}|${e.b_id}|${e.ref}`;
      const w = edges.get(k);
      if (!w) {
        stats.edgesDeleted += delEdge.run(e.id).changes;
        continue;
      }
      edges.delete(k);
      if (e.at !== w.at || Math.abs(e.w_raw - w.w) > 1e-9) stats.edgesUpserted += updEdge.run(w.at, w.w, e.id).changes;
    }
    const insEdge = db.prepare(
      `INSERT INTO edge_evidence (a_id, b_id, type, directed, ref, at, w_raw, created_at) VALUES (?, ?, 'co_attend', 0, ?, ?, ?, ?)`,
    );
    for (const e of edges.values()) stats.edgesUpserted += insEdge.run(e.a, e.b, e.ref, e.at, e.w, now).changes;
    return stats;
  });
}
