/**
 * Intro suggestions (intelligence §5 "Intro suggestions"; PLAN "Circles and intros"). Never auto-sent: the item's
 * opener is a double-opt-in DRAFT to one person only (the closer of the two), copied by hand if at all.
 *
 * Eligible pairs (nightly, job 'intel', after ties and graph):
 *   - both people are strong ties: T ≥ 40 or H ≥ 50 (person_stats);
 *   - they don't already know each other: pair strength < 0.05 (edge_stats), no shared group chat (≤ 40 members) and
 *     no event / occasion both attended, no relation label between them (ex, family, partner, …);
 *   - neither opted out: `people.custom.no_intros = true` or a "no intros" tag.
 * Score = 0.4·IDF-weighted Jaccard(interests) + 0.3·same metro + 0.2·min(T_a, T_b)/100 + 0.1·need match, where a
 * need match is a fact like "looking for a climbing partner" / "hiring a designer" naming the other's interest or role.
 * Pairs ≥ INTRO.keepFrom are stored (intro_pairs); ≥ INTRO.threshold become 'intro' candidates (top few, each person
 * once), 0.3–0.45 feed the 🎲 intro_pair wildcard. Rate limits (≤ 1 per 3 days, ≤ 4 per month) and the 30-day pair /
 * 7-day person cooldowns are the suggestions stage's (pipeline/suggestions/stage.ts, store.ts).
 */
import type { DB } from '../db/connection';
import { tx } from '../db/tx';
import type { Candidate } from '../pipeline/suggestions/types';
import { factsByPerson, livesIn, locationFacts } from './trips';

export const INTRO = {
  minTie: 40,
  minHistorical: 50,
  maxPairStrength: 0.05,
  maxSharedGroupSize: 40,
  threshold: 0.45,
  keepFrom: 0.3,
  /** Candidates emitted per night (each person in at most one). */
  emitTop: 3,
  /** Most people considered (strongest ties first). */
  maxPeople: 400,
  maxStoredPairs: 300,
} as const;

const NEED_RE = /\b(?:looking for|searching for|seeking|hiring|needs? (?:a|an|some)|wants? to (?:meet|find)|could use (?:a|an))\s+(.{3,80})/i;
const STOP = new Set('a an the for to of and or with in on at some new good my his her their our partner partners someone people person friend friends buddy'.split(' '));
const OPT_OUT_TAGS = new Set(['no intros', 'no intro', 'no-intros', 'no_intros', 'nointros']);

const tokens = (s: string): string[] =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter((w) => w.length >= 3 && !STOP.has(w))
    .map((w) => (w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w));

export interface IntroPerson {
  id: string;
  tie: number;
  historical: number;
  /** value_norm → fact id */
  interests: Map<string, string>;
  /** Interest + role/employer/job tokens (what a need can match). */
  offers: Set<string>;
  /** Need phrases' tokens. */
  needs: string[][];
  metro: string | null;
  groups: Set<string>;
  events: Set<string>;
}

export interface PairScore {
  a: string;
  b: string;
  score: number;
  interest: number;
  sameMetro: boolean;
  needMatch: boolean;
  /** Fact ids of the shared interests (≤ 6). */
  shared: string[];
}

/** People eligible for intros (strong ties, visible, not opted out), with what scoring needs. */
export function introPeople(db: DB, now: number): IntroPerson[] {
  const rows = db
    .prepare(
      `SELECT pv.id, coalesce(ps.tie_strength, 0) AS tie, coalesce(ps.historical_strength, 0) AS historical, pv.custom, pv.company, pv.job_title
       FROM person_visible pv JOIN person_stats ps ON ps.person_id = pv.id
       WHERE coalesce(ps.tie_strength, 0) >= @tie OR coalesce(ps.historical_strength, 0) >= @hist
       ORDER BY coalesce(ps.tie_strength, 0) DESC, pv.id LIMIT @limit`,
    )
    .all({ tie: INTRO.minTie, hist: INTRO.minHistorical, limit: INTRO.maxPeople }) as {
    id: string;
    tie: number;
    historical: number;
    custom: string | null;
    company: string | null;
    job_title: string | null;
  }[];
  const optedOutByTag = new Set(
    (
      db
        .prepare(
          `SELECT DISTINCT pc.canonical_id, t.name FROM person_tags pt JOIN tags t ON t.id = pt.tag_id AND t.status = 'active'
           JOIN person_canon pc ON pc.person_id = pt.person_id`,
        )
        .all() as { canonical_id: string; name: string }[]
    )
      .filter((r) => OPT_OUT_TAGS.has(r.name.trim().toLowerCase()))
      .map((r) => r.canonical_id),
  );
  const optedOut = (r: { id: string; custom: string | null }) => {
    if (optedOutByTag.has(r.id)) return true;
    if (!r.custom) return false;
    try {
      const c = JSON.parse(r.custom) as Record<string, unknown> | null;
      return !!c && typeof c === 'object' && (c.no_intros === true || c.noIntros === true);
    } catch {
      return false;
    }
  };
  const people = rows.filter((r) => !optedOut(r));
  if (!people.length) return [];
  const ids = JSON.stringify(people.map((p) => p.id));

  const factRows = db
    .prepare(
      `SELECT f.id, pc.canonical_id AS person_id, f.type, f.value, f.value_norm FROM facts f JOIN person_canon pc ON pc.person_id = f.person_id
       WHERE pc.canonical_id IN (SELECT value FROM json_each(?)) AND f.status IN ('tentative','confirmed') AND f.sensitive = 0 AND f.retracted_at IS NULL
         AND f.type IN ('interest','activity_pref','employer','role','job','other','preference')
       ORDER BY f.recorded_at, f.id`,
    )
    .all(ids) as { id: string; person_id: string; type: string; value: string; value_norm: string }[];
  const groupRows = db
    .prepare(
      `SELECT DISTINCT pc.canonical_id AS person_id, c.id AS conv FROM conversation_members cm
       JOIN identities i ON i.id = cm.identity_id JOIN person_canon pc ON pc.person_id = i.person_id
       JOIN conversations c ON c.id = cm.conversation_id
       WHERE c.kind = 'group' AND coalesce(c.member_count, 0) <= ? AND pc.canonical_id IN (SELECT value FROM json_each(?))`,
    )
    .all(INTRO.maxSharedGroupSize, ids) as { person_id: string; conv: string }[];
  const eventRows = db
    .prepare(
      `SELECT DISTINCT pc.canonical_id AS person_id, coalesce('e:' || a.event_id, 'o:' || a.occasion_id) AS ev FROM event_attendees a
       JOIN person_canon pc ON pc.person_id = a.person_id
       WHERE lower(a.status) IN ('going','approved','checked_in','attended','host','maybe') AND pc.canonical_id IN (SELECT value FROM json_each(?))`,
    )
    .all(ids) as { person_id: string; ev: string }[];
  const loc = factsByPerson(locationFacts(db));

  const byId = new Map<string, IntroPerson>();
  for (const p of people) {
    const offers = new Set<string>([...tokens(p.company ?? ''), ...tokens(p.job_title ?? '')]);
    byId.set(p.id, {
      id: p.id,
      tie: p.tie,
      historical: p.historical,
      interests: new Map(),
      offers,
      needs: [],
      metro: livesIn(loc.get(p.id), now)?.place.key ?? null,
      groups: new Set(),
      events: new Set(),
    });
  }
  for (const f of factRows) {
    const p = byId.get(f.person_id);
    if (!p) continue;
    const need = NEED_RE.exec(f.value);
    if (need) {
      const t = tokens(need[1]!);
      if (t.length) p.needs.push(t);
      continue;
    }
    if (f.type === 'interest' || f.type === 'activity_pref') {
      if (!p.interests.has(f.value_norm)) p.interests.set(f.value_norm, f.id);
      for (const t of tokens(f.value)) p.offers.add(t);
    } else if (f.type === 'employer' || f.type === 'role' || f.type === 'job') {
      for (const t of tokens(f.value)) p.offers.add(t);
    }
  }
  for (const g of groupRows) byId.get(g.person_id)?.groups.add(g.conv);
  for (const e of eventRows) byId.get(e.person_id)?.events.add(e.ev);
  return [...byId.values()];
}

/** IDF of every interest value_norm over visible people (log(N / df), N = people with any interest). */
export function interestIdf(db: DB): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT f.value_norm AS v, count(DISTINCT pv.id) AS df FROM facts f JOIN person_canon pc ON pc.person_id = f.person_id
       JOIN person_visible pv ON pv.id = pc.canonical_id
       WHERE f.type IN ('interest','activity_pref') AND f.status IN ('tentative','confirmed') AND f.sensitive = 0 AND f.retracted_at IS NULL
       GROUP BY f.value_norm`,
    )
    .all() as { v: string; df: number }[];
  const n = db
    .prepare(
      `SELECT count(DISTINCT pv.id) FROM facts f JOIN person_canon pc ON pc.person_id = f.person_id JOIN person_visible pv ON pv.id = pc.canonical_id
       WHERE f.type IN ('interest','activity_pref') AND f.status IN ('tentative','confirmed') AND f.sensitive = 0 AND f.retracted_at IS NULL`,
    )
    .pluck()
    .get() as number;
  const N = Math.max(2, n);
  return new Map(rows.map((r) => [r.v, Math.log((N + 1) / r.df)]));
}

/** IDF-weighted Jaccard of two interest sets, in [0, 1]. */
export function idfJaccard(a: ReadonlyMap<string, unknown>, b: ReadonlyMap<string, unknown>, idf: ReadonlyMap<string, number>): { score: number; shared: string[] } {
  let inter = 0;
  let union = 0;
  const shared: string[] = [];
  const w = (v: string) => idf.get(v) ?? Math.log(3);
  for (const v of new Set([...a.keys(), ...b.keys()])) {
    const x = w(v);
    union += x;
    if (a.has(v) && b.has(v)) {
      inter += x;
      shared.push(v);
    }
  }
  return { score: union > 0 ? inter / union : 0, shared };
}

const needMatches = (needs: string[][], offers: Set<string>): boolean => needs.some((n) => n.some((t) => offers.has(t)));

/** Pairs that already know each other (strength, labels). Keys `a|b` with a < b. */
export function knownPairs(db: DB, ids: readonly string[]): Set<string> {
  const json = JSON.stringify(ids);
  const out = new Set<string>();
  for (const r of db
    .prepare(
      `SELECT a_id, b_id FROM edge_stats WHERE strength >= ? AND a_id IN (SELECT value FROM json_each(?)) AND b_id IN (SELECT value FROM json_each(?))`,
    )
    .all(INTRO.maxPairStrength, json, json) as { a_id: string; b_id: string }[]) {
    out.add(`${r.a_id}|${r.b_id}`);
  }
  for (const r of db
    .prepare(
      `SELECT pa.canonical_id AS a, pb.canonical_id AS b FROM edge_labels l
       JOIN person_canon pa ON pa.person_id = l.a_id JOIN person_canon pb ON pb.person_id = l.b_id
       WHERE l.status = 'active'`,
    )
    .all() as { a: string; b: string }[]) {
    out.add(r.a < r.b ? `${r.a}|${r.b}` : `${r.b}|${r.a}`);
  }
  return out;
}

const intersects = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => {
  const [s, l] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of s) if (l.has(x)) return true;
  return false;
};

const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** Scores every eligible pair (≥ keepFrom), as small steps (the job yields between them). */
export function* scorePairsSteps(db: DB, now: number): Generator<void, PairScore[]> {
  const people = introPeople(db, now);
  yield;
  const idf = interestIdf(db);
  const known = knownPairs(
    db,
    people.map((p) => p.id),
  );
  yield;
  const out: PairScore[] = [];
  for (let i = 0; i < people.length; i++) {
    const p = people[i]!;
    for (let j = i + 1; j < people.length; j++) {
      const q = people[j]!;
      const [a, b] = p.id < q.id ? [p, q] : [q, p];
      if (known.has(`${a.id}|${b.id}`)) continue;
      if (intersects(a.groups, b.groups) || intersects(a.events, b.events)) continue;
      const j1 = idfJaccard(a.interests, b.interests, idf);
      const sameMetro = !!a.metro && a.metro === b.metro;
      const need = needMatches(a.needs, b.offers) || needMatches(b.needs, a.offers);
      const tie = Math.min(a.tie, b.tie) / 100;
      const score = 0.4 * j1.score + 0.3 * (sameMetro ? 1 : 0) + 0.2 * tie + 0.1 * (need ? 1 : 0);
      if (score < INTRO.keepFrom) continue;
      const shared = j1.shared
        .flatMap((v) => [a.interests.get(v), b.interests.get(v)])
        .filter((x): x is string => !!x)
        .slice(0, 6);
      out.push({ a: a.id, b: b.id, score: r3(Math.min(1, score)), interest: r3(j1.score), sameMetro, needMatch: need, shared });
    }
    if (i % 20 === 19) yield;
  }
  return out.sort((x, y) => y.score - x.score || (x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : 1));
}

/** Replaces intro_pairs with the best pairs. */
export function storePairs(db: DB, pairs: readonly PairScore[], now: number): number {
  const top = pairs.slice(0, INTRO.maxStoredPairs);
  tx(db, () => {
    db.prepare('DELETE FROM intro_pairs').run();
    const ins = db.prepare(
      `INSERT INTO intro_pairs (a_id, b_id, score, interest, same_metro, need_match, shared, computed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const p of top) ins.run(p.a, p.b, p.score, p.interest, p.sameMetro ? 1 : 0, p.needMatch ? 1 : 0, JSON.stringify(p.shared), now);
  });
  return top.length;
}

interface PairRow {
  a_id: string;
  b_id: string;
  score: number;
  interest: number;
  same_metro: number;
  need_match: number;
  shared: string;
}

const tieOf = (db: DB, id: string): number => (db.prepare('SELECT coalesce(tie_strength, 0) FROM person_stats WHERE person_id = ?').pluck().get(id) as number | undefined) ?? 0;
const visible = (db: DB, id: string): boolean => !!db.prepare('SELECT 1 FROM person_visible WHERE id = ?').get(id);

/** One intro candidate from a stored pair: the closer person first (the draft goes to them only). */
export function pairCandidate(db: DB, r: PairRow): Candidate | null {
  if (!visible(db, r.a_id) || !visible(db, r.b_id)) return null;
  const [first, second] = tieOf(db, r.a_id) >= tieOf(db, r.b_id) ? [r.a_id, r.b_id] : [r.b_id, r.a_id];
  const shared = JSON.parse(r.shared) as string[];
  return {
    kind: 'intro',
    personIds: [first, second],
    subjectKey: `${r.a_id}|${r.b_id}`,
    base: Math.min(1, Math.max(0, r.score)),
    evidenceIds: shared.map((id) => `F${id}`),
    expiresAt: null,
    links: { relatedPersonId: second },
    payload: {
      pairScore: r.score,
      interestOverlap: r.interest,
      sameMetro: r.same_metro === 1,
      needMatch: r.need_match === 1,
      sharedInterests: shared.length,
      /** The double-opt-in draft is addressed to this person only. */
      draftTo: first,
    },
  };
}

/** Tonight's intro candidates: the best pairs ≥ threshold, each person in at most one. */
export function introCandidates(db: DB): Candidate[] {
  const rows = db.prepare('SELECT * FROM intro_pairs WHERE score >= ? ORDER BY score DESC, a_id, b_id LIMIT 50').all(INTRO.threshold) as PairRow[];
  const used = new Set<string>();
  const out: Candidate[] = [];
  for (const r of rows) {
    if (out.length >= INTRO.emitTop) break;
    if (used.has(r.a_id) || used.has(r.b_id)) continue;
    const c = pairCandidate(db, r);
    if (!c) continue;
    used.add(r.a_id);
    used.add(r.b_id);
    out.push(c);
  }
  return out;
}

/** 🎲 intro_pair: one mid-score pair (keepFrom ≤ score < threshold), drawn uniformly. */
export function midScorePair(db: DB, rng: () => number): Candidate[] {
  const rows = db.prepare('SELECT * FROM intro_pairs WHERE score >= ? AND score < ? ORDER BY a_id, b_id').all(INTRO.keepFrom, INTRO.threshold) as PairRow[];
  const live = rows.filter((r) => visible(db, r.a_id) && visible(db, r.b_id));
  if (!live.length) return [];
  const pick = live[Math.min(live.length - 1, Math.floor(rng() * live.length))]!;
  const c = pairCandidate(db, pick);
  return c ? [c] : [];
}
