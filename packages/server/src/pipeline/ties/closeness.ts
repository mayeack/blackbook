/**
 * Closeness: one 1–10 number per person, from acquaintance (1) to closest friend (10), shown on the person page and
 * the People list and used by features that need "close enough" (intelligence §3 "Closeness").
 *
 *   1      in the background: seen only (a guest-list or group-roster name, one text), never shown or suggested —
 *          today's roster-only people, plus hidden, merged and service rows
 *   2–10   shown people, from C = max(T, H/2): how close you are now (T) or, for an old friend gone quiet, half of how
 *          much you were in touch over a year (H anchored at the last contact, so silence doesn't erode it):
 *            10 ≥ 80 · 9 ≥ 65 · 8 ≥ 50 · 7 ≥ 40 · 6 ≥ 30 · 5 ≥ 22 · 4 ≥ 15 · 3 ≥ 7 · 2 below 7, or no stats yet
 *
 * Computed from person_stats on read (T and H are recomputed nightly by the ties job), so it never drifts from them.
 * Exceptions belong to the features: something the owner asked for by name, or a priority person, isn't held to a
 * minimum closeness (see meetsCloseness).
 */
import type { DB } from '../../db/connection';

export const CLOSENESS_STEPS: readonly { score: number; min: number }[] = [
  { score: 10, min: 80 },
  { score: 9, min: 65 },
  { score: 8, min: 50 },
  { score: 7, min: 40 },
  { score: 6, min: 30 },
  { score: 5, min: 22 },
  { score: 4, min: 15 },
  { score: 3, min: 7 },
];
/** The lowest score of a shown person (no stats, or barely any contact). */
export const SHOWN_FLOOR = 2;
/** The background: seen, never shown or suggested. */
export const BACKGROUND = 1;

const num = (v: number | null | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** 1–10 from tie strength T and historical strength H (both 0–100); `shown` false means the background (1). */
export function closenessScore(o: { tie: number | null | undefined; historical: number | null | undefined; shown: boolean }): number {
  if (!o.shown) return BACKGROUND;
  const c = Math.max(num(o.tie), num(o.historical) / 2);
  return CLOSENESS_STEPS.find((s) => c >= s.min)?.score ?? SHOWN_FLOOR;
}

/** A person's closeness (any id: merged-away ids resolve to their canonical person). */
export function closenessOf(db: DB, personId: string): number {
  const r = db
    .prepare(
      `SELECT pv.id IS NOT NULL AS shown, s.tie_strength AS tie, s.historical_strength AS historical
       FROM person_canon pc LEFT JOIN person_visible pv ON pv.id = pc.canonical_id LEFT JOIN person_stats s ON s.person_id = pc.canonical_id
       WHERE pc.person_id = ?`,
    )
    .get(personId) as { shown: number; tie: number | null; historical: number | null } | undefined;
  return r ? closenessScore({ tie: r.tie, historical: r.historical, shown: r.shown === 1 }) : BACKGROUND;
}

/**
 * Whether a person clears a feature's minimum closeness. The owner's own asks win over the rule: a priority person,
 * or someone he requested by name (e.g. by text), always does.
 */
export function meetsCloseness(score: number, min: number, o: { priority?: boolean; requested?: boolean } = {}): boolean {
  return score >= min || !!o.priority || !!o.requested;
}
