/**
 * Candidate generators for circles (intelligence §5 table: circle_neglect, base 0.4, w_kind 0.4, 30-day cooldown)
 * plus the 🎲 wildcard 'circle_checkin' (a random circle check-in).
 *
 * A circle (auto or the owner's own, ≥ 3 visible members) is neglected when the owner's last contact with ANY of its
 * members is at least max(30 days, 3 × the members' median usual gap) ago, it was active within the last year, and
 * at least two members were real ties (H ≥ 30). Circle-level items carry no personIds (contract): the circle id is in
 * links.circleId and the top members by tie strength in payload.memberIds (never a record of mine: identity/self.ts).
 * Pure readers; cooldowns are the suggestions stage's job.
 */
import type { DB } from '../../db/connection';
import { selfPeople } from '../../identity/self';
import type { Candidate, CandidateGenerator, GeneratorContext, WildcardSource } from '../suggestions/types';

const DAY = 86_400_000;
const CANDIDATE_TTL_MS = 36 * 3_600_000;
const MIN_MEMBERS = 3;
const NEGLECT_MIN_DAYS = 30;
const NEGLECT_GAP_MULTIPLE = 3;
const KNOWN_H = 30;
const CHECKIN_MIN_SILENCE_DAYS = 14;

export interface CircleActivity {
  circleId: string;
  kind: 'auto' | 'user';
  memberCount: number;
  lastActivityAt: number | null;
  medianGapD: number | null;
  knownMembers: number;
  /** Top members by tie strength (≤ 3). */
  topMemberIds: string[];
}

export function circleActivity(db: DB): CircleActivity[] {
  const rows = db
    .prepare(
      `SELECT c.id AS circle_id, c.kind, pc.canonical_id AS person_id, ps.last_at, ps.expected_gap_d, ps.historical_strength, ps.tie_strength
       FROM circles c
       JOIN circle_members cm ON cm.circle_id = c.id AND cm.excluded = 0
       JOIN person_canon pc ON pc.person_id = cm.person_id
       JOIN person_visible v ON v.id = pc.canonical_id
       LEFT JOIN person_stats ps ON ps.person_id = pc.canonical_id
       WHERE c.status = 'active'
       ORDER BY c.id, pc.canonical_id`,
    )
    .all() as {
    circle_id: string;
    kind: 'auto' | 'user';
    person_id: string;
    last_at: number | null;
    expected_gap_d: number | null;
    historical_strength: number | null;
    tie_strength: number | null;
  }[];
  const by = new Map<string, { kind: 'auto' | 'user'; members: Map<string, (typeof rows)[number]> }>();
  const self = selfPeople(db);
  for (const r of rows) {
    if (self.has(r.person_id)) continue;
    let c = by.get(r.circle_id);
    if (!c) by.set(r.circle_id, (c = { kind: r.kind, members: new Map() }));
    c.members.set(r.person_id, r);
  }
  const out: CircleActivity[] = [];
  for (const [circleId, c] of by) {
    const ms = [...c.members.values()];
    const gaps = ms.map((m) => m.expected_gap_d).filter((g): g is number => g !== null).sort((a, b) => a - b);
    const last = ms.reduce<number | null>((acc, m) => (m.last_at !== null && (acc === null || m.last_at > acc) ? m.last_at : acc), null);
    out.push({
      circleId,
      kind: c.kind,
      memberCount: ms.length,
      lastActivityAt: last,
      medianGapD: gaps.length ? gaps[Math.floor((gaps.length - 1) / 2)]! : null,
      knownMembers: ms.filter((m) => (m.historical_strength ?? 0) >= KNOWN_H).length,
      topMemberIds: ms
        .sort((a, b) => (b.tie_strength ?? 0) - (a.tie_strength ?? 0) || (a.person_id < b.person_id ? -1 : 1))
        .slice(0, 3)
        .map((m) => m.person_id),
    });
  }
  return out;
}

function candidate(ctx: GeneratorContext, a: CircleActivity, subjectKey: string, silenceD: number): Candidate {
  return {
    kind: 'circle_neglect',
    personIds: [],
    subjectKey,
    base: 0.4,
    evidenceIds: [],
    expiresAt: ctx.now + CANDIDATE_TTL_MS,
    links: { circleId: a.circleId },
    payload: {
      silenceD: Math.round(silenceD),
      expectedGapD: a.medianGapD === null ? null : Math.round(a.medianGapD * 10) / 10,
      memberCount: a.memberCount,
      memberIds: a.topMemberIds,
      circleKind: a.kind,
    },
  };
}

export const circleNeglectGenerator: CandidateGenerator = {
  kind: 'circle_neglect',
  generate(ctx) {
    const out: Candidate[] = [];
    for (const a of circleActivity(ctx.db)) {
      if (a.memberCount < MIN_MEMBERS || a.lastActivityAt === null || a.medianGapD === null || a.knownMembers < 2) continue;
      const silence = (ctx.now - a.lastActivityAt) / DAY;
      if (silence > 365 || silence < Math.max(NEGLECT_MIN_DAYS, NEGLECT_GAP_MULTIPLE * a.medianGapD)) continue;
      out.push(candidate(ctx, a, a.circleId, silence));
    }
    return out;
  },
};

/** 🎲 a random circle check-in (any active circle with ≥ 3 members, quiet for two weeks or more). */
export const circleCheckinWildcard: WildcardSource = {
  generator: 'circle_checkin',
  generate(ctx, rng) {
    const pool = circleActivity(ctx.db).filter(
      (a) => a.memberCount >= MIN_MEMBERS && a.lastActivityAt !== null && ctx.now - a.lastActivityAt >= CHECKIN_MIN_SILENCE_DAYS * DAY,
    );
    if (!pool.length) return [];
    const a = pool[Math.floor(rng() * pool.length) % pool.length]!;
    return [candidate(ctx, a, `checkin:${a.circleId}`, (ctx.now - a.lastActivityAt!) / DAY)];
  },
};

export const generators: CandidateGenerator[] = [circleNeglectGenerator];

export const wildcardSources: WildcardSource[] = [circleCheckinWildcard];
