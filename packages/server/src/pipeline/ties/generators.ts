/**
 * Candidate generators for the cadence states the ties pass computed (intelligence §5 table):
 *   fading    base = fading severity sev = (H/100)·min(1, log2(F)/3)·(1 + 0.5·priority)
 *   cooling   base = 0.6·H/100
 *   dormant   S > dormant days and H was ≥ 50; base 0.3
 * plus the 🎲 wildcard 'dormant_close': a once-close person gone quiet (H ≥ 50, S > 180 d), drawn at random.
 * Pure readers over person_stats ⋈ person_visible (never ME, hidden, merged, roster-only or service people);
 * suppressed fading (WhatsApp/Instagram not ingesting yet) never surfaces. Cooldowns, mutes and fatigue are the
 * suggestions stage's job.
 */
import type { DB } from '../../db/connection';
import type { Candidate, CandidateGenerator, GeneratorContext, WildcardSource } from '../suggestions/types';

const H = 3_600_000;
/** Candidates are re-emitted nightly while the state holds; a stale one drops after this. */
const CANDIDATE_TTL_MS = 36 * H;
const WILDCARD_PICKS = 2;

interface StatRow {
  person_id: string;
  is_priority: number;
  last_at: number | null;
  silence_d: number | null;
  expected_gap_d: number | null;
  fading_ratio: number | null;
  historical_strength: number | null;
  tie_strength: number | null;
  momentum: number | null;
  rate90: number | null;
  rate365: number | null;
  fading_severity: number | null;
  contact_days_365: number | null;
}

const STAT_COLS = `ps.person_id, p.is_priority, ps.last_at, ps.silence_d, ps.expected_gap_d, ps.fading_ratio, ps.historical_strength,
  ps.tie_strength, ps.momentum, ps.rate90, ps.rate365, ps.fading_severity, ps.contact_days_365`;

function rows(db: DB, where: string, params: unknown[] = []): StatRow[] {
  return db
    .prepare(`SELECT ${STAT_COLS} FROM person_stats ps JOIN person_visible p ON p.id = ps.person_id WHERE ${where} ORDER BY ps.person_id`)
    .all(...params) as StatRow[];
}

/** The latest 1:1 message with a person ('m:<id>', 'conv:<id>'), for citations. */
export function lastDirectEvidence(db: DB, personId: string): string[] {
  const m = db
    .prepare(
      `SELECT m.id, m.conversation_id FROM messages m
       WHERE m.conversation_id IN (
         SELECT cm.conversation_id FROM conversation_members cm
         JOIN conversations c ON c.id = cm.conversation_id AND c.kind = 'direct'
         JOIN identities i ON i.id = cm.identity_id
         JOIN person_canon pc ON pc.person_id = i.person_id
         WHERE pc.canonical_id = ?)
       AND m.kind IN ('text','attachment','link') AND m.is_bot = 0
       ORDER BY m.sent_at DESC LIMIT 1`,
    )
    .get(personId) as { id: number; conversation_id: string } | undefined;
  return m ? [`m:${m.id}`, `conv:${m.conversation_id}`] : [];
}

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

function payload(r: StatRow) {
  return {
    silenceD: r.silence_d,
    expectedGapD: r.expected_gap_d,
    fadingRatio: r.fading_ratio,
    historicalStrength: r.historical_strength,
    tieStrength: r.tie_strength,
    momentum: r.momentum,
    lastAt: r.last_at,
    priority: r.is_priority === 1,
  };
}

function candidate(ctx: GeneratorContext, kind: Candidate['kind'], r: StatRow, base: number, subjectKey = r.person_id): Candidate {
  return {
    kind,
    personIds: [r.person_id],
    subjectKey,
    base: clamp01(base),
    evidenceIds: lastDirectEvidence(ctx.db, r.person_id),
    expiresAt: ctx.now + CANDIDATE_TTL_MS,
    payload: payload(r),
  };
}

export const fadingGenerator: CandidateGenerator = {
  kind: 'fading',
  generate(ctx) {
    return rows(ctx.db, `ps.state = 'fading' AND ps.fading_suppressed = 0`).map((r) => candidate(ctx, 'fading', r, r.fading_severity ?? 0));
  },
};

export const coolingGenerator: CandidateGenerator = {
  kind: 'cooling',
  generate(ctx) {
    return rows(ctx.db, `ps.state = 'cooling'`).map((r) => candidate(ctx, 'cooling', r, (0.6 * (r.historical_strength ?? 0)) / 100));
  },
};

export const dormantGenerator: CandidateGenerator = {
  kind: 'dormant',
  generate(ctx) {
    return rows(ctx.db, `ps.state = 'dormant' AND ps.historical_strength >= 50`).map((r) => candidate(ctx, 'dormant', r, 0.3));
  },
};

/** 🎲 a once-close person (H ≥ 50) quiet for more than 180 days. */
export const dormantCloseWildcard: WildcardSource = {
  generator: 'dormant_close',
  generate(ctx, rng) {
    const pool = rows(ctx.db, `ps.historical_strength >= 50 AND ps.silence_d > 180`);
    const out: Candidate[] = [];
    while (pool.length && out.length < WILDCARD_PICKS) {
      const [r] = pool.splice(Math.floor(rng() * pool.length) % pool.length, 1);
      out.push(candidate(ctx, 'dormant', r!, 0.3, `wild:${r!.person_id}`));
    }
    return out;
  },
};

export const generators: CandidateGenerator[] = [fadingGenerator, coolingGenerator, dormantGenerator];

export const wildcardSources: WildcardSource[] = [dormantCloseWildcard];
