/**
 * Person lookups for the suggestions stage: canonical ids, visibility (THE person_visible chokepoint: never ME,
 * hidden, merged, roster-only or service people), tie stats, tie tiers and circles. Reads only.
 */
import type { PersonChip, TieState } from '@yb/shared';
import type { DB } from '../../db/connection';

export interface TieStats {
  tie: number | null;
  historical: number | null;
  silenceD: number | null;
  expectedGapD: number | null;
  fadingRatio: number | null;
  momentum: number | null;
  rate90: number | null;
  rate365: number | null;
  reciprocity: number | null;
  contactDays365: number | null;
  lastAt: number | null;
  state: TieState | null;
  fadingSuppressed: boolean;
}

export interface PersonInfo {
  id: string;
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  isPriority: boolean;
  status: string;
  stats: TieStats | null;
  /** Tie tier from T (tie strength to me): the learner's kind × tier bucket. */
  tier: TieTier;
  /** Active circles the person is a (non-excluded) member of. */
  circleIds: string[];
}

export const TIE_TIERS = ['close', 'steady', 'light', 'faint', 'unknown'] as const;
export type TieTier = (typeof TIE_TIERS)[number];

export const TIER_LABEL: Readonly<Record<TieTier, string>> = {
  close: 'close ties',
  steady: 'steady ties',
  light: 'light ties',
  faint: 'faint ties',
  unknown: 'new people',
};

/** T ≥70 close (the "Strong" label), 40–70 steady, 15–40 light, <15 faint; no stats → unknown. */
export function tieTier(t: number | null | undefined): TieTier {
  if (t === null || t === undefined || !Number.isFinite(t)) return 'unknown';
  if (t >= 70) return 'close';
  if (t >= 40) return 'steady';
  if (t >= 15) return 'light';
  return 'faint';
}

interface StatsRow {
  person_id: string;
  tie_strength: number | null;
  historical_strength: number | null;
  silence_d: number | null;
  expected_gap_d: number | null;
  fading_ratio: number | null;
  momentum: number | null;
  rate90: number | null;
  rate365: number | null;
  reciprocity: number | null;
  contact_days_365: number | null;
  last_at: number | null;
  state: TieState | null;
  fading_suppressed: number;
}

export function statsFromRow(r: StatsRow): TieStats {
  return {
    tie: r.tie_strength,
    historical: r.historical_strength,
    silenceD: r.silence_d,
    expectedGapD: r.expected_gap_d,
    fadingRatio: r.fading_ratio,
    momentum: r.momentum,
    rate90: r.rate90,
    rate365: r.rate365,
    reciprocity: r.reciprocity,
    contactDays365: r.contact_days_365,
    lastAt: r.last_at,
    state: r.state,
    fadingSuppressed: r.fading_suppressed === 1,
  };
}

/** The canonical id of a (possibly merged-away) person; the id itself when person_canon has no row. */
export function canonOf(db: DB, personId: string): string {
  return (db.prepare('SELECT canonical_id FROM person_canon WHERE person_id = ?').pluck().get(personId) as string | undefined) ?? personId;
}

/** Canonical, deduplicated ids in order. */
export function canonAll(db: DB, ids: readonly string[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    const c = canonOf(db, id);
    if (!out.includes(c)) out.push(c);
  }
  return out;
}

/** Ids (canonical) that pass person_visible. */
export function visibleSet(db: DB, ids: readonly string[]): Set<string> {
  if (!ids.length) return new Set();
  const out = new Set<string>();
  const stmt = db.prepare('SELECT 1 FROM person_visible WHERE id = ?').pluck();
  for (const id of new Set(ids)) if (stmt.get(id)) out.add(id);
  return out;
}

export const isVisible = (db: DB, id: string): boolean => visibleSet(db, [id]).has(id);

interface PersonRow {
  id: string;
  display_name: string;
  first_name: string | null;
  last_name: string | null;
  is_priority: number;
  status: string;
}

/** Loads visible people (canonical ids only; invisible ones are simply absent from the map). */
export class PeopleCache {
  private readonly cache = new Map<string, PersonInfo | null>();
  private readonly personStmt;
  private readonly statsStmt;
  private readonly circlesStmt;

  constructor(private readonly db: DB) {
    this.personStmt = db.prepare('SELECT id, display_name, first_name, last_name, is_priority, status FROM person_visible WHERE id = ?');
    this.statsStmt = db.prepare('SELECT * FROM person_stats WHERE person_id = ?');
    this.circlesStmt = db
      .prepare(
        `SELECT cm.circle_id FROM circle_members cm JOIN circles c ON c.id = cm.circle_id
         WHERE cm.person_id = ? AND cm.excluded = 0 AND c.status = 'active' ORDER BY cm.circle_id`,
      )
      .pluck();
  }

  get(id: string): PersonInfo | null {
    if (this.cache.has(id)) return this.cache.get(id)!;
    const p = this.personStmt.get(id) as PersonRow | undefined;
    let info: PersonInfo | null = null;
    if (p) {
      const s = this.statsStmt.get(id) as StatsRow | undefined;
      const stats = s ? statsFromRow(s) : null;
      info = {
        id: p.id,
        displayName: p.display_name,
        firstName: p.first_name,
        lastName: p.last_name,
        isPriority: p.is_priority === 1,
        status: p.status,
        stats,
        tier: tieTier(stats?.tie),
        circleIds: this.circlesStmt.all(id) as string[],
      };
    }
    this.cache.set(id, info);
    return info;
  }

  chip(id: string): PersonChip | null {
    const p = this.get(id);
    return p ? { id: p.id, displayName: p.displayName, firstName: p.firstName, state: p.stats?.state ?? null } : null;
  }
}

/** "Sam R." — first name + last initial (the digest's name rule); falls back to the display name's first word. */
export function shortName(p: Pick<PersonInfo, 'firstName' | 'lastName' | 'displayName'>): string {
  const first = (p.firstName ?? '').trim() || (p.displayName ?? '').trim().split(/\s+/)[0] || 'Someone';
  const last = (p.lastName ?? '').trim();
  return last ? `${first} ${[...last][0]!.toUpperCase()}.` : first;
}

/** Active circles with their visible member ids (3–60 members), for circle-level generators. */
export function circlesWithMembers(db: DB): { id: string; name: string; members: string[] }[] {
  const circles = db.prepare(`SELECT id, name FROM circles WHERE status = 'active' ORDER BY id`).all() as { id: string; name: string }[];
  const membersStmt = db
    .prepare(
      `SELECT DISTINCT pv.id FROM circle_members cm
       JOIN person_canon pc ON pc.person_id = cm.person_id
       JOIN person_visible pv ON pv.id = pc.canonical_id
       WHERE cm.circle_id = ? AND cm.excluded = 0 ORDER BY pv.id`,
    )
    .pluck();
  return circles.map((c) => ({ ...c, members: membersStmt.all(c.id) as string[] })).filter((c) => c.members.length >= 3 && c.members.length <= 60);
}

/** Conversation ids the person (canonical) is a member of, with the conversation kind and size. */
export function personConversations(db: DB, personId: string): { id: string; kind: string; memberCount: number | null }[] {
  return db
    .prepare(
      `SELECT DISTINCT c.id, c.kind, c.member_count AS memberCount FROM identities i
       JOIN person_canon pc ON pc.person_id = i.person_id
       JOIN conversation_members cm ON cm.identity_id = i.id
       JOIN conversations c ON c.id = cm.conversation_id
       WHERE pc.canonical_id = ? AND c.kind IN ('direct','group')`,
    )
    .all(personId) as { id: string; kind: string; memberCount: number | null }[];
}
