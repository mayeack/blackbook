/**
 * Cadence generators over person_stats (intelligence §3 states, §5 base scores): fading, cooling, dormant, plus the
 * 🎲 dormant_close wildcard (a once-close friend, H ≥ 50, quiet > 180 days). The ties pass owns the states; these
 * only read them (canonical, visible people; fading stays off while fading_suppressed is set, e.g. a WhatsApp/IG
 * friend before those sources are live).
 */
import type { DB } from '../../../db/connection';
import type { Candidate, CandidateGenerator, GeneratorContext, WildcardSource } from '../types';
import { clamp01, lastDirectMessageRef, round } from './common';

interface Row {
  person_id: string;
  is_priority: number;
  tie_strength: number | null;
  historical_strength: number | null;
  silence_d: number | null;
  expected_gap_d: number | null;
  fading_ratio: number | null;
  momentum: number | null;
  rate90: number | null;
  rate365: number | null;
  contact_days_365: number | null;
  last_at: number | null;
  state: string | null;
  fading_suppressed: number;
  /** 011 (ties) adds it; read defensively. */
  fading_severity?: number | null;
}

function rows(db: DB, where: string, ...params: unknown[]): Row[] {
  return db
    .prepare(
      `SELECT ps.*, pv.is_priority FROM person_stats ps JOIN person_visible pv ON pv.id = ps.person_id
       WHERE ${where} ORDER BY ps.person_id`,
    )
    .all(...params) as Row[];
}

const stats = (r: Row) => ({
  silenceD: round(r.silence_d, 0),
  expectedGapD: round(r.expected_gap_d, 0),
  fadingRatio: round(r.fading_ratio, 1),
  historical: round(r.historical_strength, 0),
  tie: round(r.tie_strength, 0),
  momentum: round(r.momentum, 2),
  lastAt: r.last_at,
});

function evidence(db: DB, personId: string): string[] {
  const m = lastDirectMessageRef(db, personId);
  return m ? [m] : [];
}

/** sev = (H/100) · min(1, log2(F)/3) · (1 + 0.5·priority), or the ties pass's own severity when present. */
export function fadingSeverity(r: Pick<Row, 'historical_strength' | 'fading_ratio' | 'is_priority' | 'fading_severity'>): number {
  if (typeof r.fading_severity === 'number' && Number.isFinite(r.fading_severity)) return clamp01(r.fading_severity);
  const h = r.historical_strength ?? 0;
  const f = r.fading_ratio ?? 0;
  if (f <= 1 || h <= 0) return 0;
  return clamp01((h / 100) * Math.min(1, Math.log2(f) / 3) * (1 + 0.5 * r.is_priority));
}

export const fadingGenerator: CandidateGenerator = {
  kind: 'fading',
  generate(ctx: GeneratorContext): Candidate[] {
    const out: Candidate[] = [];
    for (const r of rows(ctx.db, `ps.state = 'fading' AND ps.fading_suppressed = 0`)) {
      const base = fadingSeverity(r);
      if (base <= 0) continue;
      out.push({
        kind: 'fading',
        personIds: [r.person_id],
        subjectKey: r.person_id,
        base,
        evidenceIds: evidence(ctx.db, r.person_id),
        expiresAt: null,
        payload: { ...stats(r), priority: r.is_priority === 1 },
      });
    }
    return out;
  },
};

export const coolingGenerator: CandidateGenerator = {
  kind: 'cooling',
  generate(ctx: GeneratorContext): Candidate[] {
    return rows(ctx.db, `ps.state = 'cooling'`).map((r) => ({
      kind: 'cooling' as const,
      personIds: [r.person_id],
      subjectKey: r.person_id,
      base: clamp01((0.6 * (r.historical_strength ?? 0)) / 100),
      evidenceIds: evidence(ctx.db, r.person_id),
      expiresAt: null,
      payload: { ...stats(r), rate90: round(r.rate90, 3), rate365: round(r.rate365, 3) },
    }));
  },
};

/** Dormant (S > 365) people who used to matter (H ≥ 50); the 90-day cooldown makes it "quarterly". */
export const dormantGenerator: CandidateGenerator = {
  kind: 'dormant',
  generate(ctx: GeneratorContext): Candidate[] {
    return rows(ctx.db, `ps.state = 'dormant' AND coalesce(ps.historical_strength, 0) >= 50`).map((r) => ({
      kind: 'dormant' as const,
      personIds: [r.person_id],
      subjectKey: r.person_id,
      base: 0.3,
      evidenceIds: evidence(ctx.db, r.person_id),
      expiresAt: null,
      payload: stats(r),
    }));
  },
};

/** 🎲 A once-close friend gone quiet: H ≥ 50 and silent more than 180 days (dormant or not yet). */
export const dormantCloseWildcard: WildcardSource = {
  generator: 'dormant_close',
  generate(ctx: GeneratorContext): Candidate[] {
    return rows(ctx.db, `coalesce(ps.historical_strength, 0) >= 50 AND coalesce(ps.silence_d, 0) > 180`).map((r) => ({
      kind: 'dormant' as const,
      personIds: [r.person_id],
      subjectKey: r.person_id,
      base: 0.3,
      evidenceIds: evidence(ctx.db, r.person_id),
      expiresAt: null,
      payload: { ...stats(r), onceClose: true },
    }));
  },
};
