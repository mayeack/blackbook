/**
 * Read model of one person's tie (the TieStats DTO of GET /people/:id/ties, @yb/shared api/person.ts), for the
 * person page and anything else that shows "usually every ~9d · last 41d ago". `personId` must already be the
 * visible canonical id (callers resolve and 404 first). Sparkline: the trailing weekly tie_stats_snapshot rows.
 */
import type { TieStats } from '@yb/shared';
import type { DB } from '../../db/connection';
import { closenessScore } from './closeness';
import { SPARK_WEEKS, stateLabel, type TieStateName } from './stats';

interface Row {
  state: TieStateName | null;
  tie_strength: number | null;
  historical_strength: number | null;
  expected_gap_d: number | null;
  silence_d: number | null;
  fading_ratio: number | null;
  momentum: number | null;
  reciprocity: number | null;
  i_start_share: number | null;
  contact_days_365: number | null;
  last_at: number | null;
  fading_suppressed: number;
  computed_at: number;
}

export function readTieStats(db: DB, personId: string): TieStats {
  const r = db
    .prepare(
      `SELECT state, tie_strength, historical_strength, expected_gap_d, silence_d, fading_ratio, momentum, reciprocity, i_start_share,
              contact_days_365, last_at, fading_suppressed, computed_at FROM person_stats WHERE person_id = ?`,
    )
    .get(personId) as Row | undefined;
  const spark = db
    .prepare(`SELECT week, tie_strength, units FROM tie_stats_snapshot WHERE person_id = ? ORDER BY week DESC LIMIT ?`)
    .all(personId, SPARK_WEEKS) as { week: string; tie_strength: number; units: number }[];
  return {
    personId,
    state: r?.state ?? null,
    label: stateLabel(r?.state ?? null),
    tieStrength: r?.tie_strength ?? null,
    historicalStrength: r?.historical_strength ?? null,
    closeness: closenessScore({ tie: r?.tie_strength, historical: r?.historical_strength, shown: true }),
    expectedGapD: r?.expected_gap_d ?? null,
    silenceD: r?.silence_d ?? null,
    fadingRatio: r?.fading_ratio ?? null,
    momentum: r?.momentum ?? null,
    reciprocity: r?.reciprocity ?? null,
    iStartShare: r?.i_start_share ?? null,
    contactDays365: r?.contact_days_365 ?? null,
    lastAt: r?.last_at ?? null,
    fadingSuppressed: r?.fading_suppressed === 1,
    sparkline: spark.reverse().map((s) => ({ date: s.week, t: s.tie_strength, units: s.units })),
    computedAt: r?.computed_at ?? null,
  };
}
