/**
 * Ask retrieval: the data behind the six read-only tools (intelligence §7), returned as typed rows with the
 * server's own ids. tools.ts renders them for the model (pseudonym tokens, base36 citation ids, local dates) and
 * degraded.ts formats them locally when no LLM is available.
 *
 * Visibility, in every query:
 *   - people come through person_canon → person_visible (never hidden, merged-away, roster-only, service or ME);
 *   - messages: non-service only (direct and group chats, not the self-thread or business chats), not spam/bot/
 *     duplicate/retracted, not in an agent-excluded conversation; a hidden person's messages and DMs never appear;
 *   - facts: active (tentative/confirmed, not retracted or superseded) and never sensitive; edge labels likewise;
 *   - events: what the Events screen lists (social + trips, never sensitive occasions);
 *   - forModel (anything sent to Claude): the owner's llm.excluded_person_ids / llm.excluded_conversation_ids are
 *     left out too ("never sent to the model").
 * Titles and snippets have hidden people's names blanked (hiddenNameRedactor) — the same rule as /events.
 */
import { DAY_MS } from '@yb/shared';
import { dateToUtc } from '../adapters/calendar/time';
import type { DB } from '../db/connection';
import { collisionAware, ownerNames } from '../identity/ownerNames';
import { occasionChain } from '../pipeline/occasions/build';
import { COUNTED, POSSIBLE } from '../pipeline/occasions/signals';
import { hiddenNameRedactor } from '../routes/people';
import { readSetting, settingTimeZone } from '../settings/registry';
import { docNumber, EVENT_KINDS, ftsTerms, PARTIFUL_ATTENDING, trigramMatch, unicodeMatch } from './fts';

// ---------------------------------------------------------------------------------------------- scope

export interface PersonRow {
  id: string;
  display_name: string;
  first_name: string | null;
  last_name: string | null;
  nickname: string | null;
  company: string | null;
  job_title: string | null;
  status: string;
}

export interface AskScope {
  db: DB;
  now: number;
  tz: string;
  /** Results go to Claude: the owner's llm.excluded_* people and conversations are left out. */
  forModel: boolean;
  excludedPeople: ReadonlySet<string>;
  excludedConvs: ReadonlySet<string>;
  /** Blanks hidden people's names in titles/snippets. */
  redact: (s: string | null) => string | null;
  people: Map<string, PersonRow | null>;
  canon: Map<string, string>;
  identityPerson: Map<string, string | null>;
  convs: Map<string, ConvInfo | null>;
}

export function createScope(db: DB, o: { now?: number; forModel: boolean }): AskScope {
  const scope: AskScope = {
    db,
    now: o.now ?? Date.now(),
    tz: settingTimeZone(db),
    forModel: o.forModel,
    excludedPeople: new Set(),
    excludedConvs: new Set(),
    redact: hiddenNameRedactor(db),
    people: new Map(),
    canon: new Map(),
    identityPerson: new Map(),
    convs: new Map(),
  };
  if (o.forModel) {
    const people = new Set<string>();
    for (const id of readSetting(db, 'llm.excluded_person_ids')) {
      people.add(id);
      people.add(canonical(scope, id));
    }
    scope.excludedPeople = people;
    scope.excludedConvs = new Set(readSetting(db, 'llm.excluded_conversation_ids'));
  }
  return scope;
}

export function canonical(scope: AskScope, id: string): string {
  let c = scope.canon.get(id);
  if (c === undefined) {
    c = (scope.db.prepare('SELECT canonical_id FROM person_canon WHERE person_id = ?').pluck().get(id) as string | undefined) ?? id;
    scope.canon.set(id, c);
  }
  return c;
}

/** The visible canonical person behind any permanent id, or null (hidden, merged-away chain end invisible, excluded). */
export function visiblePerson(scope: AskScope, id: string): PersonRow | null {
  const cid = canonical(scope, id);
  if (scope.forModel && (scope.excludedPeople.has(cid) || scope.excludedPeople.has(id))) return null;
  let row = scope.people.get(cid);
  if (row === undefined) {
    row =
      (scope.db
        .prepare('SELECT id, display_name, first_name, last_name, nickname, company, job_title, status FROM person_visible WHERE id = ?')
        .get(cid) as PersonRow | undefined) ?? null;
    scope.people.set(cid, row);
  }
  return row;
}

export function personOfIdentity(scope: AskScope, identityId: string | null): PersonRow | null {
  if (!identityId) return null;
  let pid = scope.identityPerson.get(identityId);
  if (pid === undefined) {
    pid = (scope.db.prepare('SELECT person_id FROM identities WHERE id = ?').pluck().get(identityId) as string | undefined) ?? null;
    scope.identityPerson.set(identityId, pid);
  }
  return pid ? visiblePerson(scope, pid) : null;
}

/** Every permanent id that resolves to `canonicalId` (itself included). */
export function clusterOf(scope: AskScope, canonicalId: string): string[] {
  const ids = scope.db.prepare('SELECT person_id FROM person_canon WHERE canonical_id = ?').pluck().all(canonicalId) as string[];
  return ids.includes(canonicalId) ? ids : [canonicalId, ...ids];
}

function identityIdsOf(scope: AskScope, canonicalId: string): string[] {
  return scope.db
    .prepare(`SELECT id FROM identities WHERE person_id IN (SELECT value FROM json_each(?)) AND status <> 'detached'`)
    .pluck()
    .all(JSON.stringify(clusterOf(scope, canonicalId))) as string[];
}

/** "Sam R." — first name + last initial, else the display name's first two words. */
export function shortName(p: Pick<PersonRow, 'first_name' | 'last_name' | 'display_name'>): string {
  const first = p.first_name?.trim();
  const last = p.last_name?.trim();
  if (first) return last ? `${first} ${[...last][0]!.toUpperCase()}.` : first;
  const words = p.display_name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return `${words[0]} ${[...words[1]!][0]!.toUpperCase()}.`;
  return words[0] ?? 'someone';
}

/** "Sam Rivera" — first name + full last name, else the whole display name: for a short name that would be ambiguous. */
export function longName(p: Pick<PersonRow, 'first_name' | 'last_name' | 'display_name'>): string {
  const first = p.first_name?.trim();
  const last = p.last_name?.trim().replace(/\s+/g, ' ');
  if (first) return last ? `${first} ${last}` : first;
  return p.display_name.trim().replace(/\s+/g, ' ') || 'someone';
}

export interface AnswerNames {
  of: (p: PersonRow) => string;
  /** Ids of the people whose short name collides (named by longName). */
  colliding: ReadonlySet<string>;
}

/**
 * Names for the people one answer names together, as the owner reads them over iMessage: shortName, unless it reads
 * the same as the owner's own short name or another person's in the answer; then longName (identity/ownerNames.ts).
 * Local only: what the model sees keeps shortName and tokens (the egress cuts last names to an initial anyway).
 */
export function answerNames(db: DB, people: readonly PersonRow[]): AnswerNames {
  const owner = ownerNames(db).map((o) => (o.firstName ? shortName({ first_name: o.firstName, last_name: o.lastName, display_name: o.displayName }) : null));
  const named = collisionAware(people, owner, { short: shortName, long: longName });
  return { of: (p) => named.of(p) ?? shortName(p), colliding: named.colliding };
}

export const firstNameOf = (p: Pick<PersonRow, 'first_name' | 'display_name'>): string =>
  p.first_name?.trim() || p.display_name.trim().split(/\s+/)[0] || 'someone';

// ---------------------------------------------------------------------------------------------- dates

/** YYYY-MM-DD (local) → the start of that day; null when absent or malformed. */
export function dayStart(scope: AskScope, date: string | null | undefined): number | null {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return dateToUtc(date, scope.tz);
}

// ---------------------------------------------------------------------------------------------- facts

const ACTIVE_FACT = `f.status IN ('tentative','confirmed') AND f.retracted_at IS NULL AND f.superseded_at IS NULL AND f.sensitive = 0`;
const CURRENT = `(f.valid_to IS NULL OR f.valid_to >= @now)`;

export const LOCATION_TYPES = ['location_current', 'home_location', 'address'];
export const INTEREST_TYPES = ['interest', 'activity_pref', 'food_drink', 'preference'];
export const WORK_TYPES = ['employer', 'job', 'role', 'school', 'education'];
/** Category names the tools accept → fact types. */
export const FACT_CATEGORIES: Record<string, string[]> = {
  interest: ['interest'],
  activity_pref: ['activity_pref'],
  food_drink: ['food_drink'],
  location_current: ['location_current', 'home_location'],
  location_next: ['location_next'],
  hometown: ['hometown'],
  employer: ['employer', 'job'],
  role: ['role'],
  school: ['school', 'education'],
  pet: ['pet'],
  travel_plan: ['travel_plan'],
  family: ['family'],
  preference: ['preference'],
  other: ['other'],
};

export interface FactRow {
  seq: number;
  id: string;
  personId: string;
  type: string;
  value: string;
  validFrom: number | null;
  validTo: number | null;
  confidence: number;
  recordedAt: number;
}

interface RawFact {
  seq: number;
  id: string;
  person_id: string;
  type: string;
  value: string;
  valid_from: number | null;
  valid_to: number | null;
  confidence: number;
  recorded_at: number;
  rank?: number;
}

const toFact = (scope: AskScope, r: RawFact): FactRow => ({
  seq: r.seq,
  id: r.id,
  personId: canonical(scope, r.person_id),
  type: r.type,
  value: r.value.length > 200 ? `${r.value.slice(0, 199)}…` : r.value,
  validFrom: r.valid_from,
  validTo: r.valid_to,
  confidence: r.confidence,
  recordedAt: r.recorded_at,
});

/** One fact by its seq (active, non-sensitive, visible person), or null. */
export function factBySeq(scope: AskScope, seq: number): FactRow | null {
  const r = scope.db.prepare(`SELECT f.* FROM facts f WHERE f.seq = ? AND ${ACTIVE_FACT}`).get(seq) as RawFact | undefined;
  if (!r || !visiblePerson(scope, r.person_id)) return null;
  return toFact(scope, r);
}

/** Facts of several people (active, non-sensitive), best first. */
export function factsOf(scope: AskScope, personIds: string[], o: { types?: string[]; currentOnly?: boolean; perPerson?: number } = {}): Map<string, FactRow[]> {
  const out = new Map<string, FactRow[]>();
  if (!personIds.length) return out;
  const rows = scope.db
    .prepare(
      `SELECT f.seq, f.id, f.person_id, f.type, f.value, f.valid_from, f.valid_to, f.confidence, f.recorded_at
       FROM facts f LEFT JOIN person_canon pc ON pc.person_id = f.person_id
       WHERE coalesce(pc.canonical_id, f.person_id) IN (SELECT value FROM json_each(@ids)) AND ${ACTIVE_FACT}
         AND (@types IS NULL OR f.type IN (SELECT value FROM json_each(@types)))
         AND (@current = 0 OR ${CURRENT})
       ORDER BY f.confidence DESC, f.support DESC, f.recorded_at DESC`,
    )
    .all({ ids: JSON.stringify(personIds), types: o.types ? JSON.stringify(o.types) : null, current: o.currentOnly ? 1 : 0, now: scope.now }) as RawFact[];
  for (const r of rows) {
    const f = toFact(scope, r);
    const list = out.get(f.personId) ?? [];
    if (!o.perPerson || list.length < o.perPerson) list.push(f);
    out.set(f.personId, list);
  }
  return out;
}

export interface FactSearch {
  query: string | null;
  cat: string | null;
  limit: number;
}

/** search_facts: FTS over fact values (prefix terms, AND then OR), optional category; visible people only. */
export function searchFacts(scope: AskScope, s: FactSearch): FactRow[] {
  const types = s.cat ? (FACT_CATEGORIES[s.cat] ?? null) : null;
  if (s.cat && !types) return [];
  const terms = ftsTerms(s.query);
  const run = (match: string | null): RawFact[] =>
    match
      ? (scope.db
          .prepare(
            `SELECT f.seq, f.id, f.person_id, f.type, f.value, f.valid_from, f.valid_to, f.confidence, f.recorded_at, bm25(facts_fts) AS rank
             FROM facts_fts JOIN facts f ON f.seq = facts_fts.rowid
             WHERE facts_fts MATCH @match AND ${ACTIVE_FACT} AND (@types IS NULL OR f.type IN (SELECT value FROM json_each(@types)))
             ORDER BY rank LIMIT 400`,
          )
          .all({ match, types: types ? JSON.stringify(types) : null }) as RawFact[])
      : (scope.db
          .prepare(
            `SELECT f.seq, f.id, f.person_id, f.type, f.value, f.valid_from, f.valid_to, f.confidence, f.recorded_at
             FROM facts f LEFT JOIN person_stats s ON s.person_id = f.person_id
             WHERE ${ACTIVE_FACT} AND f.type IN (SELECT value FROM json_each(@types)) AND ${CURRENT}
             ORDER BY coalesce(s.tie_strength, 0) DESC, f.confidence DESC LIMIT 400`,
          )
          .all({ types: JSON.stringify(types ?? []), now: scope.now }) as RawFact[]);
  let rows = terms.length ? run(unicodeMatch(terms, 'and')) : types ? run(null) : [];
  if (!rows.length && terms.length > 1) rows = run(unicodeMatch(terms, 'or'));
  const out: FactRow[] = [];
  for (const r of rows) {
    if (!visiblePerson(scope, r.person_id)) continue;
    out.push(toFact(scope, r));
    if (out.length >= s.limit) break;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- places

interface Metro {
  names: string[];
  nearby: string[];
}

/** A small offline metro table: synonyms, plus nearby places used when the caller asks for a radius. */
const METROS: Metro[] = [
  { names: ['new york', 'new york city', 'nyc', 'manhattan'], nearby: ['brooklyn', 'queens', 'bronx', 'staten island', 'jersey city', 'hoboken', 'long island city'] },
  { names: ['san francisco', 'sf'], nearby: ['bay area', 'oakland', 'berkeley', 'san jose', 'palo alto', 'mountain view', 'menlo park', 'sausalito', 'daly city', 'san mateo'] },
  { names: ['los angeles', 'la'], nearby: ['santa monica', 'hollywood', 'west hollywood', 'pasadena', 'venice', 'culver city', 'burbank', 'long beach', 'silver lake', 'echo park', 'malibu'] },
  { names: ['washington dc', 'washington, dc', 'dc', 'd.c.'], nearby: ['arlington', 'alexandria', 'bethesda', 'silver spring'] },
  { names: ['chicago'], nearby: ['evanston', 'oak park'] },
  { names: ['boston'], nearby: ['cambridge', 'somerville', 'brookline'] },
  { names: ['seattle'], nearby: ['bellevue', 'redmond', 'kirkland', 'tacoma'] },
  { names: ['austin'], nearby: ['round rock', 'san marcos'] },
  { names: ['miami'], nearby: ['miami beach', 'fort lauderdale', 'coral gables'] },
  { names: ['denver'], nearby: ['boulder', 'aurora', 'lakewood'] },
  { names: ['philadelphia', 'philly'], nearby: ['camden'] },
  { names: ['portland'], nearby: ['beaverton', 'vancouver wa'] },
  { names: ['san diego'], nearby: ['la jolla', 'carlsbad'] },
  { names: ['london'], nearby: [] },
  { names: ['paris'], nearby: [] },
  { names: ['toronto'], nearby: ['mississauga'] },
];

const fold = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().trim();
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Place names a city query matches: the city, its metro synonyms, and (with a radius) nearby places. */
export function placeNames(city: string, nearKm: number | null): string[] {
  const c = fold(city).replace(/\s+/g, ' ');
  if (!c) return [];
  const metro = METROS.find((m) => m.names.includes(c) || (nearKm && m.nearby.includes(c)));
  if (!metro) return [c];
  return [...new Set([c, ...metro.names, ...(nearKm && nearKm > 0 ? metro.nearby : [])])];
}

export function placeMatcher(names: string[]): (text: string | null | undefined) => boolean {
  if (!names.length) return () => false;
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${names.map(escapeRe).join('|')})($|[^\\p{L}\\p{N}])`, 'u');
  return (text) => !!text && re.test(fold(text));
}

/** Canonical ids of people whose current location (facts, Locations collection) matches. */
export function peopleInPlace(scope: AskScope, city: string, nearKm: number | null): Set<string> {
  const names = placeNames(city, nearKm);
  const matches = placeMatcher(names);
  const out = new Set<string>();
  if (!names.length) return out;
  const like = names.map((n) => `%${n.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
  const facts = scope.db
    .prepare(
      `SELECT f.person_id, f.value FROM facts f
       WHERE ${ACTIVE_FACT} AND ${CURRENT} AND f.type IN (SELECT value FROM json_each(@types))
         AND EXISTS (SELECT 1 FROM json_each(@like) WHERE lower(f.value) LIKE json_each.value ESCAPE '\\')`,
    )
    .all({ types: JSON.stringify(LOCATION_TYPES), like: JSON.stringify(like), now: scope.now }) as { person_id: string; value: string }[];
  for (const f of facts) if (matches(f.value) && visiblePerson(scope, f.person_id)) out.add(canonical(scope, f.person_id));
  const locs = scope.db
    .prepare(
      `SELECT pl.person_id, l.name FROM person_locations pl JOIN locations l ON l.id = pl.location_id
       WHERE l.status = 'active' AND EXISTS (SELECT 1 FROM json_each(@like) WHERE lower(l.name) LIKE json_each.value ESCAPE '\\')`,
    )
    .all({ like: JSON.stringify(like) }) as { person_id: string; name: string }[];
  for (const l of locs) if (matches(l.name) && visiblePerson(scope, l.person_id)) out.add(canonical(scope, l.person_id));
  return out;
}

// ---------------------------------------------------------------------------------------------- people

export interface PersonSummary {
  id: string;
  person: PersonRow;
  /** Tie strength T (0–100), null before the first ties run. */
  strength: number | null;
  state: string | null;
  lastAt: number | null;
  city: string | null;
  circles: string[];
  facts: FactRow[];
  score: number;
}

/** Stats, city, circles and up to 3 facts (preferring `preferFacts`) for visible canonical people, in order. */
export function summarize(scope: AskScope, ids: string[], o: { preferFacts?: Map<string, number[]>; scores?: Map<string, number> } = {}): PersonSummary[] {
  const people = ids.map((id) => visiblePerson(scope, id)).filter((p): p is PersonRow => !!p);
  if (!people.length) return [];
  const idsJson = JSON.stringify(people.map((p) => p.id));
  const stats = new Map(
    (scope.db.prepare('SELECT person_id, tie_strength, state, last_at FROM person_stats WHERE person_id IN (SELECT value FROM json_each(?))').all(idsJson) as {
      person_id: string;
      tie_strength: number | null;
      state: string | null;
      last_at: number | null;
    }[]).map((r) => [r.person_id, r]),
  );
  const facts = factsOf(
    scope,
    people.map((p) => p.id),
    {},
  );
  const circles = new Map<string, string[]>();
  for (const r of scope.db
    .prepare(
      `SELECT coalesce(pc.canonical_id, cm.person_id) AS pid, c.name FROM circle_members cm
       JOIN circles c ON c.id = cm.circle_id LEFT JOIN person_canon pc ON pc.person_id = cm.person_id
       WHERE coalesce(pc.canonical_id, cm.person_id) IN (SELECT value FROM json_each(?)) AND cm.excluded = 0 AND c.status = 'active'
       ORDER BY coalesce(cm.score, 1) DESC, c.name`,
    )
    .all(idsJson) as { pid: string; name: string }[]) {
    const list = circles.get(r.pid) ?? [];
    if (list.length < 3 && !list.includes(r.name)) list.push(r.name);
    circles.set(r.pid, list);
  }
  const locs = new Map<string, string>();
  for (const r of scope.db
    .prepare(
      `SELECT coalesce(pc.canonical_id, pl.person_id) AS pid, l.name FROM person_locations pl JOIN locations l ON l.id = pl.location_id
       LEFT JOIN person_canon pc ON pc.person_id = pl.person_id
       WHERE coalesce(pc.canonical_id, pl.person_id) IN (SELECT value FROM json_each(?)) AND l.status = 'active' ORDER BY l.name`,
    )
    .all(idsJson) as { pid: string; name: string }[]) {
    if (!locs.has(r.pid)) locs.set(r.pid, r.name);
  }
  return people.map((p) => {
    const all = facts.get(p.id) ?? [];
    const current = (f: FactRow) => f.validTo === null || f.validTo >= scope.now;
    const loc = all.find((f) => (f.type === 'location_current' || f.type === 'home_location') && current(f));
    const prefer = new Set(o.preferFacts?.get(p.id) ?? []);
    const ordered = [...all.filter((f) => prefer.has(f.seq)), ...all.filter((f) => !prefer.has(f.seq) && f.type !== 'address')];
    const s = stats.get(p.id);
    return {
      id: p.id,
      person: p,
      strength: s?.tie_strength ?? null,
      state: s?.state ?? null,
      lastAt: s?.last_at ?? null,
      city: loc?.value ?? locs.get(p.id) ?? null,
      circles: circles.get(p.id) ?? [],
      facts: ordered.slice(0, 3),
      score: o.scores?.get(p.id) ?? 0,
    };
  });
}

export interface PeopleSearch {
  query: string | null;
  city: string | null;
  nearKm: number | null;
  circle: string | null;
  interest: string | null;
  employer: string | null;
  /** T (0–100); values ≤ 1 are read as a fraction. */
  minStrength: number | null;
  limit: number;
}

type ScoreSet = Map<string, number>;

const normalizeScores = (rows: { pid: string; rank: number }[]): ScoreSet => {
  const out: ScoreSet = new Map();
  let max = 0;
  for (const r of rows) max = Math.max(max, -r.rank);
  for (const r of rows) {
    const s = max > 0 ? -r.rank / max : 1;
    out.set(r.pid, Math.max(out.get(r.pid) ?? 0, s));
  }
  return out;
};

function factMatches(scope: AskScope, text: string, types: string[] | null): { scores: ScoreSet; seqs: Map<string, number[]> } {
  const scores: ScoreSet = new Map();
  const seqs = new Map<string, number[]>();
  const terms = ftsTerms(text);
  const go = (mode: 'and' | 'or') => {
    const match = unicodeMatch(terms, mode);
    if (!match) return [];
    return scope.db
      .prepare(
        `SELECT f.seq, f.person_id, bm25(facts_fts) AS rank FROM facts_fts JOIN facts f ON f.seq = facts_fts.rowid
         WHERE facts_fts MATCH @match AND ${ACTIVE_FACT} AND (@types IS NULL OR f.type IN (SELECT value FROM json_each(@types)))
         ORDER BY rank LIMIT 500`,
      )
      .all({ match, types: types ? JSON.stringify(types) : null }) as { seq: number; person_id: string; rank: number }[];
  };
  let rows = go('and');
  if (!rows.length && terms.length > 1) rows = go('or');
  const visible = rows.filter((r) => visiblePerson(scope, r.person_id)).map((r) => ({ ...r, pid: canonical(scope, r.person_id) }));
  for (const [k, v] of normalizeScores(visible)) scores.set(k, v);
  for (const r of visible) seqs.set(r.pid, [...(seqs.get(r.pid) ?? []), r.seq]);
  return { scores, seqs };
}

function nameMatches(scope: AskScope, text: string): ScoreSet {
  const terms = ftsTerms(text);
  const out: ScoreSet = new Map();
  const match = trigramMatch(terms, 'and') ?? null;
  const run = (m: string) =>
    scope.db
      .prepare(`SELECT person_id AS pid, bm25(people_fts, 0, 10.0, 4.0, 2.0, 2.0) AS rank FROM people_fts WHERE people_fts MATCH ? ORDER BY rank LIMIT 300`)
      .all(m) as { pid: string; rank: number }[];
  let rows = match ? run(match) : [];
  if (!rows.length && terms.filter((t) => t.length >= 3).length > 1) rows = run(trigramMatch(terms, 'or')!);
  for (const [k, v] of normalizeScores(rows.filter((r) => visiblePerson(scope, r.pid)))) out.set(k, v);
  // Names shorter than a trigram ("Al", "Jo"): exact first name / nickname.
  for (const t of terms.filter((t) => [...t].length < 3)) {
    const ids = scope.db
      .prepare(`SELECT id FROM person_visible WHERE lower(first_name) = ? OR lower(nickname) = ? OR lower(display_name) LIKE ? ESCAPE '\\'`)
      .pluck()
      .all(t, t, `${t.replace(/[\\%_]/g, (c) => `\\${c}`)} %`) as string[];
    for (const id of ids) if (visiblePerson(scope, id)) out.set(id, Math.max(out.get(id) ?? 0, 0.8));
  }
  return out;
}

function circleMembers(scope: AskScope, circle: string): ScoreSet {
  const like = `%${circle.trim().toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const ids = scope.db
    .prepare(
      `SELECT DISTINCT cm.person_id FROM circle_members cm JOIN circles c ON c.id = cm.circle_id
       WHERE c.status = 'active' AND cm.excluded = 0 AND (lower(c.name) LIKE ? ESCAPE '\\' OR c.id = ?)`,
    )
    .pluck()
    .all(like, circle.trim()) as string[];
  const out: ScoreSet = new Map();
  for (const id of ids) if (visiblePerson(scope, id)) out.set(canonical(scope, id), 1);
  return out;
}

function employerMatches(scope: AskScope, employer: string): { scores: ScoreSet; seqs: Map<string, number[]> } {
  const f = factMatches(scope, employer, WORK_TYPES);
  const like = `%${employer.trim().toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const ids = scope.db
    .prepare(`SELECT id FROM person_visible WHERE lower(coalesce(company, '')) LIKE ? ESCAPE '\\' OR lower(coalesce(job_title, '')) LIKE ? ESCAPE '\\'`)
    .pluck()
    .all(like, like) as string[];
  for (const id of ids) if (visiblePerson(scope, id)) f.scores.set(id, Math.max(f.scores.get(id) ?? 0, 1));
  return f;
}

/** search_people: every given filter must match (AND); relevance × (0.5 + T/200), as intelligence §7 ranks people. */
export function searchPeople(scope: AskScope, s: PeopleSearch): PersonSummary[] {
  const sets: ScoreSet[] = [];
  const preferFacts = new Map<string, number[]>();
  const addPrefer = (seqs: Map<string, number[]>) => {
    for (const [k, v] of seqs) preferFacts.set(k, [...(preferFacts.get(k) ?? []), ...v]);
  };
  if (s.query?.trim()) {
    const byName = nameMatches(scope, s.query);
    const byFact = factMatches(scope, s.query, null);
    addPrefer(byFact.seqs);
    const merged: ScoreSet = new Map(byName);
    for (const [k, v] of byFact.scores) merged.set(k, Math.max(merged.get(k) ?? 0, v * 0.7));
    sets.push(merged);
  }
  if (s.city?.trim()) sets.push(new Map([...peopleInPlace(scope, s.city, s.nearKm)].map((id) => [id, 1])));
  if (s.interest?.trim()) {
    const f = factMatches(scope, s.interest, [...INTEREST_TYPES, 'other']);
    addPrefer(f.seqs);
    sets.push(f.scores);
  }
  if (s.employer?.trim()) {
    const f = employerMatches(scope, s.employer);
    addPrefer(f.seqs);
    sets.push(f.scores);
  }
  if (s.circle?.trim()) sets.push(circleMembers(scope, s.circle));

  let candidates: ScoreSet;
  if (!sets.length) {
    // No filter: the strongest ties.
    const ids = scope.db
      .prepare(`SELECT p.id FROM person_visible p JOIN person_stats s ON s.person_id = p.id ORDER BY s.tie_strength DESC LIMIT 200`)
      .pluck()
      .all() as string[];
    candidates = new Map(ids.filter((id) => visiblePerson(scope, id)).map((id) => [id, 1]));
  } else {
    const [first, ...rest] = sets;
    candidates = new Map();
    for (const [id, score] of first!) {
      if (rest.every((r) => r.has(id))) candidates.set(id, score + rest.reduce((a, r) => a + r.get(id)!, 0));
    }
  }
  if (!candidates.size) return [];
  const ids = [...candidates.keys()];
  const strength = new Map(
    (scope.db.prepare('SELECT person_id, tie_strength FROM person_stats WHERE person_id IN (SELECT value FROM json_each(?))').all(JSON.stringify(ids)) as {
      person_id: string;
      tie_strength: number | null;
    }[]).map((r) => [r.person_id, r.tie_strength ?? 0]),
  );
  const min = s.minStrength === null ? null : s.minStrength <= 1 ? s.minStrength * 100 : s.minStrength;
  const ranked = ids
    .filter((id) => min === null || (strength.get(id) ?? 0) >= min)
    .map((id) => ({ id, score: candidates.get(id)! * (0.5 + (strength.get(id) ?? 0) / 200) }))
    .sort((a, b) => b.score - a.score || (strength.get(b.id) ?? 0) - (strength.get(a.id) ?? 0) || (a.id < b.id ? -1 : 1))
    .slice(0, s.limit);
  return summarize(
    scope,
    ranked.map((r) => r.id),
    { preferFacts, scores: new Map(ranked.map((r) => [r.id, r.score])) },
  );
}

/** People a question names ("Sam", "Sam Rivera", a nickname): full-name hits first, then unique first names. */
export function mentionedPeople(scope: AskScope, question: string, max = 5): PersonRow[] {
  const words = [...question.matchAll(/[\p{Lu}][\p{L}'’-]{1,30}/gu)].map((m) => m[0].replace(/['’]s$/u, ''));
  if (!words.length) return [];
  const found: PersonRow[] = [];
  const add = (p: PersonRow | null) => {
    if (p && !found.some((f) => f.id === p.id) && found.length < max) found.push(p);
  };
  const byFirst = scope.db.prepare(
    `SELECT p.id FROM person_visible p LEFT JOIN person_stats s ON s.person_id = p.id
     WHERE lower(p.first_name) = @w OR lower(p.nickname) = @w ORDER BY coalesce(s.tie_strength, 0) DESC LIMIT 4`,
  );
  const byFull = scope.db.prepare(`SELECT id FROM person_visible WHERE lower(first_name) = ? AND lower(last_name) = ? LIMIT 2`);
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!.toLowerCase();
    const next = words[i + 1]?.toLowerCase();
    if (next) for (const id of byFull.pluck().all(w, next) as string[]) add(visiblePerson(scope, id));
    for (const id of byFirst.pluck().all({ w }) as string[]) add(visiblePerson(scope, id));
  }
  return found;
}

// ---------------------------------------------------------------------------------------------- conversations & messages

export interface ConvInfo {
  id: string;
  kind: 'direct' | 'group';
  source: string;
  title: string | null;
  memberCount: number | null;
  /** DMs: the other person (canonical). */
  counterpart: string | null;
}

/** A conversation Ask may read (direct or group, not excluded, a DM's counterpart visible), or null. */
export function conversation(scope: AskScope, id: string): ConvInfo | null {
  let c = scope.convs.get(id);
  if (c !== undefined) return c;
  c = null;
  const r = scope.db.prepare('SELECT id, kind, source, title, member_count, agent_excluded FROM conversations WHERE id = ?').get(id) as
    | { id: string; kind: string; source: string; title: string | null; member_count: number | null; agent_excluded: number }
    | undefined;
  if (r && r.agent_excluded === 0 && (r.kind === 'direct' || r.kind === 'group') && !(scope.forModel && scope.excludedConvs.has(r.id))) {
    let counterpart: string | null = null;
    let ok = true;
    if (r.kind === 'direct') {
      const ident =
        (scope.db.prepare('SELECT identity_id FROM conversation_members WHERE conversation_id = ? ORDER BY first_seen_at LIMIT 1').pluck().get(r.id) as string | undefined) ??
        (scope.db.prepare('SELECT sender_identity_id FROM messages WHERE conversation_id = ? AND is_from_me = 0 AND sender_identity_id IS NOT NULL LIMIT 1').pluck().get(r.id) as
          | string
          | undefined);
      const p = ident ? personOfIdentity(scope, ident) : null;
      counterpart = p?.id ?? null;
      ok = !!p;
    }
    if (ok) c = { id: r.id, kind: r.kind as 'direct' | 'group', source: r.source, title: scope.redact(r.title), memberCount: r.member_count, counterpart };
  }
  scope.convs.set(id, c);
  return c;
}

export interface MessageRow {
  id: number;
  sentAt: number;
  conv: ConvInfo;
  source: string;
  /** null = the owner. */
  sender: PersonRow | null;
  fromMe: boolean;
  snippet: string;
}

interface RawMsg {
  id: number;
  sent_at: number;
  conversation_id: string;
  is_from_me: number;
  sender_identity_id: string | null;
  source: string;
  snip: string | null;
}

const MESSAGE_OK = `c.agent_excluded = 0 AND c.kind IN ('direct','group') AND m.is_spam = 0 AND m.is_bot = 0 AND m.dup_of IS NULL
  AND m.retracted_at IS NULL AND m.text IS NOT NULL AND m.kind NOT IN ('system','group_event','sticker')`;

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

function toMessage(scope: AskScope, r: RawMsg, max = 240): MessageRow | null {
  const conv = conversation(scope, r.conversation_id);
  if (!conv) return null;
  const fromMe = r.is_from_me === 1;
  const sender = fromMe ? null : personOfIdentity(scope, r.sender_identity_id);
  if (!fromMe && !sender) return null;
  return { id: r.id, sentAt: r.sent_at, conv, source: r.source, sender, fromMe, snippet: clip(scope.redact(r.snip ?? '') ?? '', max) };
}

/** One message (visible), or null. */
export function messageById(scope: AskScope, id: number): MessageRow | null {
  const r = scope.db
    .prepare(
      `SELECT m.id, m.sent_at, m.conversation_id, m.is_from_me, m.sender_identity_id, m.source, m.text AS snip
       FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.id = ? AND ${MESSAGE_OK}`,
    )
    .get(id) as RawMsg | undefined;
  return r ? toMessage(scope, r) : null;
}

export interface MessageSearch {
  query: string | null;
  personId: string | null;
  convId: string | null;
  after: number | null;
  before: number | null;
  limit: number;
}

/** DMs with a person, and the identities they post from (for "messages with/from X"). */
function personMessageScope(scope: AskScope, personId: string): { identities: string[]; dms: string[] } {
  const identities = identityIdsOf(scope, personId);
  const dms = scope.db
    .prepare(
      `SELECT DISTINCT cm.conversation_id FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id
       WHERE c.kind = 'direct' AND cm.identity_id IN (SELECT value FROM json_each(?))`,
    )
    .pluck()
    .all(JSON.stringify(identities)) as string[];
  return { identities, dms };
}

/** search_messages: FTS (prefix terms; AND, then OR) or, without a query, the newest messages in scope. */
export function searchMessages(scope: AskScope, s: MessageSearch): MessageRow[] {
  const terms = ftsTerms(s.query);
  const ps = s.personId ? personMessageScope(scope, s.personId) : null;
  const params = {
    after: s.after,
    before: s.before,
    conv: s.convId,
    pIds: ps ? JSON.stringify(ps.identities) : null,
    pDms: ps ? JSON.stringify(ps.dms) : null,
    xconv: JSON.stringify(scope.forModel ? [...scope.excludedConvs] : []),
  };
  const base = `${MESSAGE_OK}
    AND (@after IS NULL OR m.sent_at >= @after) AND (@before IS NULL OR m.sent_at < @before)
    AND (@conv IS NULL OR m.conversation_id = @conv)
    AND m.conversation_id NOT IN (SELECT value FROM json_each(@xconv))`;
  const where = `${base}
    AND (@pIds IS NULL OR m.sender_identity_id IN (SELECT value FROM json_each(@pIds)) OR m.conversation_id IN (SELECT value FROM json_each(@pDms)))`;
  const COLS = 'm.id, m.sent_at, m.conversation_id, m.is_from_me, m.sender_identity_id, m.source, m.text AS snip';
  const newest = (): RawMsg[] => {
    if (!ps) {
      return scope.db.prepare(`SELECT ${COLS} FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE ${where} ORDER BY m.sent_at DESC LIMIT 300`).all(params) as RawMsg[];
    }
    // Two index-friendly halves (msg_sender_time, msg_conv_time) instead of one OR that scans every message.
    const bySender = scope.db
      .prepare(
        `SELECT ${COLS} FROM messages m JOIN conversations c ON c.id = m.conversation_id
         WHERE m.sender_identity_id IN (SELECT value FROM json_each(@pIds)) AND ${base} ORDER BY m.sent_at DESC LIMIT 300`,
      )
      .all(params) as RawMsg[];
    const inDms = scope.db
      .prepare(
        `SELECT ${COLS} FROM messages m JOIN conversations c ON c.id = m.conversation_id
         WHERE m.conversation_id IN (SELECT value FROM json_each(@pDms)) AND ${base} ORDER BY m.sent_at DESC LIMIT 300`,
      )
      .all(params) as RawMsg[];
    const seen = new Set<number>();
    return [...bySender, ...inDms]
      .filter((r) => !seen.has(r.id) && (seen.add(r.id), true))
      .sort((a, b) => b.sent_at - a.sent_at || b.id - a.id)
      .slice(0, 300);
  };
  const run = (match: string | null): RawMsg[] =>
    match
      ? (scope.db
          .prepare(
            `SELECT m.id, m.sent_at, m.conversation_id, m.is_from_me, m.sender_identity_id, m.source,
                    snippet(messages_fts, 0, '', '', '…', 40) AS snip
             FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid JOIN conversations c ON c.id = m.conversation_id
             WHERE messages_fts MATCH @match AND ${where}
             ORDER BY bm25(messages_fts) LIMIT 300`,
          )
          .all({ ...params, match }) as RawMsg[])
      : newest();
  if (!terms.length && !s.personId && !s.convId) return [];
  let rows = terms.length ? run(unicodeMatch(terms, 'and')) : run(null);
  if (!rows.length && terms.length > 1) rows = run(unicodeMatch(terms, 'or'));
  const out: MessageRow[] = [];
  for (const r of rows) {
    const m = toMessage(scope, r);
    if (m) out.push(m);
    if (out.length >= s.limit) break;
  }
  return out;
}

/** Recent messages with a person (their DMs and what they posted in groups), newest first. */
export function recentWith(scope: AskScope, personId: string, limit: number): MessageRow[] {
  return searchMessages(scope, { query: null, personId, convId: null, after: null, before: null, limit }).map((m) => ({ ...m, snippet: clip(m.snippet, 160) }));
}

// ---------------------------------------------------------------------------------------------- person detail

export interface PersonDetail {
  summary: PersonSummary;
  identityKinds: { kind: string; count: number }[];
  facts: FactRow[];
  relations: { label: string; other: PersonRow; confidence: number }[];
  stats: {
    strength: number | null;
    state: string | null;
    lastAt: number | null;
    expectedGapDays: number | null;
    silenceDays: number | null;
    reciprocity: number | null;
    contactDays365: number | null;
  } | null;
  commitments: { kind: string; owner: string; what: string; dueAt: number | null; status: string }[];
  replyDebt: { since: number } | null;
  tags: string[];
  locations: string[];
  recent: MessageRow[];
}

const IDENTITY_LABEL: Record<string, string> = {
  phone: 'phone',
  email: 'email',
  whatsapp_jid: 'WhatsApp',
  whatsapp_lid: 'WhatsApp',
  instagram_id: 'Instagram',
  instagram_username: 'Instagram',
  instagram_name: 'Instagram',
  partiful_user: 'Partiful',
  addressbook_id: 'Contacts card',
  beeper_user: 'Instagram (Beeper)',
  x_username: 'X',
  linkedin_url: 'LinkedIn',
  legacy_id: 'Blackbook record',
};

/** get_person: identity KINDS only (never values), facts, relations, tie stats, open loops, recent snippets. */
export function personDetail(scope: AskScope, personId: string): PersonDetail | null {
  const p = visiblePerson(scope, personId);
  if (!p) return null;
  const db = scope.db;
  const [summary] = summarize(scope, [p.id]);
  const clusterJson = JSON.stringify(clusterOf(scope, p.id));
  const kinds = new Map<string, number>();
  for (const r of db
    .prepare(`SELECT kind, count(*) AS n FROM identities WHERE person_id IN (SELECT value FROM json_each(?)) AND status <> 'detached' GROUP BY kind`)
    .all(clusterJson) as { kind: string; n: number }[]) {
    const label = IDENTITY_LABEL[r.kind];
    if (label) kinds.set(label, (kinds.get(label) ?? 0) + r.n);
  }
  const facts = (factsOf(scope, [p.id]).get(p.id) ?? []).filter((f) => f.type !== 'address').slice(0, 25);
  const relations: PersonDetail['relations'] = [];
  for (const r of db
    .prepare(
      `SELECT a_id, b_id, label, confidence FROM edge_labels
       WHERE status = 'active' AND sensitive = 0 AND label <> 'ex'
         AND (a_id IN (SELECT value FROM json_each(@c)) OR b_id IN (SELECT value FROM json_each(@c)))
       ORDER BY confidence DESC LIMIT 20`,
    )
    .all({ c: clusterJson }) as { a_id: string; b_id: string; label: string; confidence: number }[]) {
    const otherId = canonical(scope, r.a_id) === p.id ? r.b_id : r.a_id;
    const other = visiblePerson(scope, otherId);
    if (other && other.id !== p.id) relations.push({ label: r.label, other, confidence: r.confidence });
  }
  const st = db
    .prepare('SELECT tie_strength, state, last_at, expected_gap_d, silence_d, reciprocity, contact_days_365 FROM person_stats WHERE person_id = ?')
    .get(p.id) as
    | {
        tie_strength: number | null;
        state: string | null;
        last_at: number | null;
        expected_gap_d: number | null;
        silence_d: number | null;
        reciprocity: number | null;
        contact_days_365: number | null;
      }
    | undefined;
  const commitments = (db
    .prepare(
      `SELECT kind, owner, what, coalesce(due_at, due_end, due_start) AS due, status FROM commitments
       WHERE person_id IN (SELECT value FROM json_each(?)) AND status IN ('open','due','snoozed') AND sensitive = 0
       ORDER BY coalesce(due_at, due_end, due_start, created_at) LIMIT 8`,
    )
    .all(clusterJson) as { kind: string; owner: string; what: string; due: number | null; status: string }[]).map((c) => ({
    kind: c.kind,
    owner: c.owner,
    what: clip(scope.redact(c.what) ?? '', 140),
    dueAt: c.due,
    status: c.status,
  }));
  const debt = db
    .prepare(`SELECT min(asked_at) FROM reply_debts WHERE person_id IN (SELECT value FROM json_each(?)) AND status = 'open'`)
    .pluck()
    .get(clusterJson) as number | null;
  const tags = db
    .prepare(
      `SELECT DISTINCT t.name FROM person_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.person_id IN (SELECT value FROM json_each(?)) AND t.status = 'active' ORDER BY t.name LIMIT 10`,
    )
    .pluck()
    .all(clusterJson) as string[];
  const locations = db
    .prepare(
      `SELECT DISTINCT l.name FROM person_locations pl JOIN locations l ON l.id = pl.location_id WHERE pl.person_id IN (SELECT value FROM json_each(?)) AND l.status = 'active' ORDER BY l.name LIMIT 10`,
    )
    .pluck()
    .all(clusterJson) as string[];
  return {
    summary: summary!,
    identityKinds: [...kinds].map(([kind, count]) => ({ kind, count })),
    facts,
    relations,
    stats: st
      ? {
          strength: st.tie_strength,
          state: st.state,
          lastAt: st.last_at,
          expectedGapDays: st.expected_gap_d,
          silenceDays: st.silence_d,
          reciprocity: st.reciprocity,
          contactDays365: st.contact_days_365,
        }
      : null,
    commitments,
    replyDebt: debt ? { since: debt } : null,
    tags,
    locations,
    recent: recentWith(scope, p.id, 10),
  };
}

// ---------------------------------------------------------------------------------------------- graph

export interface NeighborEvidence {
  type: string;
  count: number;
  lastAt: number | null;
  conversations: string[];
  events: EventRow[];
  messages: number[];
}

export interface Neighbor {
  person: PersonRow;
  strength: number;
  tier: string;
  labels: string[];
  evidence: NeighborEvidence[];
}

const tierOf = (s: number) => (s >= 0.75 ? 'close' : s >= 0.4 ? 'know' : s >= 0.15 ? 'acquainted' : 'faint');

/** graph_neighbors: pair strength from edge_stats (or straight from edge_evidence before the first graph run). */
export function graphNeighbors(scope: AskScope, personId: string, o: { minStrength: number; types: string[] | null; limit: number }): Neighbor[] | null {
  const p = visiblePerson(scope, personId);
  if (!p) return null;
  const db = scope.db;
  const cluster = clusterOf(scope, p.id);
  const clusterJson = JSON.stringify(cluster);
  const pairs = new Map<string, { strength: number; tier: string }>();
  const stats = db
    .prepare(
      `SELECT CASE WHEN a_id = @id THEN b_id ELSE a_id END AS other, strength, tier FROM edge_stats
       WHERE (a_id = @id OR b_id = @id) ORDER BY strength DESC LIMIT 400`,
    )
    .all({ id: p.id }) as { other: string; strength: number; tier: string }[];
  if (stats.length) {
    for (const s of stats) {
      const other = visiblePerson(scope, s.other);
      if (other && other.id !== p.id && !pairs.has(other.id)) pairs.set(other.id, { strength: s.strength, tier: s.tier });
    }
  } else {
    const w = new Map<string, number>();
    for (const r of db
      .prepare(
        `SELECT CASE WHEN a_id IN (SELECT value FROM json_each(@c)) THEN b_id ELSE a_id END AS other, sum(w_raw) AS w FROM edge_evidence
         WHERE a_id IN (SELECT value FROM json_each(@c)) OR b_id IN (SELECT value FROM json_each(@c)) GROUP BY other`,
      )
      .all({ c: clusterJson }) as { other: string; w: number }[]) {
      const other = visiblePerson(scope, r.other);
      if (other && other.id !== p.id) w.set(other.id, (w.get(other.id) ?? 0) + r.w);
    }
    for (const [id, W] of w) {
      const strength = 1 - Math.exp(-W / 2);
      pairs.set(id, { strength, tier: tierOf(strength) });
    }
  }
  const ranked = [...pairs].filter(([, v]) => v.strength >= o.minStrength).sort((a, b) => b[1].strength - a[1].strength);
  const out: Neighbor[] = [];
  const evStmt = db.prepare(
    `SELECT type, ref, at FROM edge_evidence
     WHERE (a_id IN (SELECT value FROM json_each(@a)) AND b_id IN (SELECT value FROM json_each(@b)))
        OR (a_id IN (SELECT value FROM json_each(@b)) AND b_id IN (SELECT value FROM json_each(@a)))
     ORDER BY at DESC`,
  );
  const labelStmt = db.prepare(
    `SELECT label FROM edge_labels WHERE status = 'active' AND sensitive = 0 AND label <> 'ex'
       AND ((a_id IN (SELECT value FROM json_each(@a)) AND b_id IN (SELECT value FROM json_each(@b)))
         OR (a_id IN (SELECT value FROM json_each(@b)) AND b_id IN (SELECT value FROM json_each(@a))))`,
  );
  for (const [otherId, v] of ranked) {
    if (out.length >= o.limit) break;
    const other = visiblePerson(scope, otherId)!;
    const b = JSON.stringify(clusterOf(scope, other.id));
    const rows = evStmt.all({ a: clusterJson, b }) as { type: string; ref: string; at: number | null }[];
    if (o.types?.length && !rows.some((r) => o.types!.includes(r.type))) continue;
    const byType = new Map<string, NeighborEvidence>();
    for (const r of rows) {
      let e = byType.get(r.type);
      if (!e) byType.set(r.type, (e = { type: r.type, count: 0, lastAt: r.at, conversations: [], events: [], messages: [] }));
      e.count++;
      const [kind, id] = [r.ref.slice(0, r.ref.indexOf(':')), r.ref.slice(r.ref.indexOf(':') + 1)];
      if (kind === 'conv' && e.conversations.length < 2) {
        const c = conversation(scope, id);
        if (c?.title && !e.conversations.includes(c.title)) e.conversations.push(c.title);
      } else if ((kind === 'event' || kind === 'occ') && e.events.length < 2) {
        const ev = eventById(scope, kind === 'occ' ? 'occasion' : 'event', id);
        if (ev && !e.events.some((x) => x.n === ev.n)) e.events.push(ev);
      } else if (kind === 'm' && e.messages.length < 2) {
        const mid = Number(id);
        if (Number.isSafeInteger(mid) && messageById(scope, mid)) e.messages.push(mid);
      }
    }
    const labels = [...new Set(labelStmt.pluck().all({ a: clusterJson, b }) as string[])];
    out.push({ person: other, strength: v.strength, tier: v.tier, labels, evidence: [...byType.values()].sort((x, y) => y.count - x.count).slice(0, 5) });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- events

export interface EventRow {
  /** ask_fts_docs.n: the stable E id. */
  n: number;
  kind: 'occasion' | 'event';
  id: string;
  title: string | null;
  startsAt: number;
  endsAt: number | null;
  venue: string | null;
  /** Counted attendees (visible, canonical), best first. */
  attendees: PersonRow[];
  possibleCount: number;
}

interface RawEvent {
  kind: 'occasion' | 'event';
  id: string;
  title: string | null;
  starts_at: number;
  ends_at: number | null;
  venue: string | null;
}

const COUNTED_STATUSES = ['going', 'attended', 'approved', 'checked_in', 'host'];
const HIDDEN_STATUSES = ['rejected', 'withdrawn', 'declined', 'invited', 'waitlist'];

function attendeesOf(scope: AskScope, e: { kind: 'occasion' | 'event'; id: string }): { counted: PersonRow[]; possible: number } {
  const rows = scope.db
    .prepare(
      `SELECT person_id, status, confidence, source FROM event_attendees
       WHERE ${e.kind === 'occasion' ? 'occasion_id IN (SELECT value FROM json_each(@ids))' : 'event_id = @id'}
       ORDER BY CASE source WHEN 'user' THEN 0 ELSE 1 END, confidence DESC`,
    )
    .all({ ids: JSON.stringify(e.kind === 'occasion' ? occasionChain(scope.db, e.id) : []), id: e.id }) as {
    person_id: string;
    status: string;
    confidence: number;
    source: string;
  }[];
  const best = new Map<string, { status: string; confidence: number }>();
  for (const r of rows) {
    const p = visiblePerson(scope, r.person_id);
    if (!p || best.has(p.id)) continue;
    best.set(p.id, { status: r.status.toLowerCase(), confidence: r.confidence });
  }
  const counted: PersonRow[] = [];
  let possible = 0;
  for (const [id, r] of best) {
    if (HIDDEN_STATUSES.includes(r.status) || r.confidence < POSSIBLE) continue;
    if (COUNTED_STATUSES.includes(r.status) && r.confidence >= COUNTED) counted.push(visiblePerson(scope, id)!);
    else possible++;
  }
  return { counted, possible };
}

const EVENT_SELECT = `
  SELECT 'occasion' AS kind, o.id, o.title, o.starts_at, o.ends_at, o.venue_text AS venue
  FROM occasions o
  WHERE o.merged_into_id IS NULL AND o.status = 'active' AND o.sensitive = 0 AND o.kind IN (SELECT value FROM json_each(@kinds))
  UNION ALL
  SELECT 'event', e.id, e.title, e.starts_at, e.ends_at, e.location_text
  FROM events e
  WHERE e.source = 'partiful' AND e.starts_at IS NOT NULL AND ${PARTIFUL_ATTENDING}
    AND NOT EXISTS (SELECT 1 FROM occasions o WHERE o.event_id = e.id AND o.merged_into_id IS NULL AND o.status IN ('active','candidate'))`;

function toEvent(scope: AskScope, r: RawEvent): EventRow {
  const att = attendeesOf(scope, r);
  return {
    n: docNumber(scope.db, r.kind, r.id, scope.now),
    kind: r.kind,
    id: r.id,
    title: scope.redact(r.title),
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    venue: scope.redact(r.venue),
    attendees: att.counted,
    possibleCount: att.possible,
  };
}

/** An event Ask may show (by kind + id), or null. */
export function eventById(scope: AskScope, kind: 'occasion' | 'event', id: string): EventRow | null {
  const r = scope.db.prepare(`SELECT * FROM (${EVENT_SELECT}) WHERE kind = @kind AND id = @id`).get({ kinds: JSON.stringify(EVENT_KINDS), kind, id }) as RawEvent | undefined;
  return r ? toEvent(scope, r) : null;
}

export interface EventSearch {
  query: string | null;
  personId: string | null;
  after: number | null;
  before: number | null;
  limit: number;
}

/** list_events: occasions + uncovered Partiful events, filtered by text (trigram), attendee and dates. */
export function listEvents(scope: AskScope, s: EventSearch): EventRow[] {
  const terms = ftsTerms(s.query);
  let docs: Set<number> | null = null;
  if (terms.length) {
    const match = trigramMatch(terms, 'and');
    const hits = new Set<number>();
    if (match) {
      for (const n of scope.db.prepare('SELECT rowid FROM ask_events_fts WHERE ask_events_fts MATCH ? ORDER BY rank LIMIT 300').pluck().all(match) as number[]) hits.add(n);
      if (!hits.size && terms.length > 1) {
        for (const n of scope.db.prepare('SELECT rowid FROM ask_events_fts WHERE ask_events_fts MATCH ? ORDER BY rank LIMIT 300').pluck().all(trigramMatch(terms, 'or')!) as number[])
          hits.add(n);
      }
    }
    docs = hits;
  }
  let attendeeEvents: Set<string> | null = null;
  if (s.personId) {
    const p = visiblePerson(scope, s.personId);
    if (!p) return [];
    attendeeEvents = new Set();
    for (const r of scope.db
      .prepare(
        `SELECT a.event_id, a.occasion_id, a.status, a.confidence FROM event_attendees a
         WHERE a.person_id IN (SELECT value FROM json_each(?)) AND a.confidence >= ?`,
      )
      .all(JSON.stringify(clusterOf(scope, p.id)), POSSIBLE) as { event_id: string | null; occasion_id: string | null; status: string; confidence: number }[]) {
      if (HIDDEN_STATUSES.includes(r.status.toLowerCase())) continue;
      if (r.event_id) attendeeEvents.add(`event:${r.event_id}`);
      if (r.occasion_id) {
        let cur = r.occasion_id;
        for (let i = 0; i < 20; i++) {
          const next = scope.db.prepare('SELECT merged_into_id FROM occasions WHERE id = ?').pluck().get(cur) as string | null | undefined;
          if (!next) break;
          cur = next;
        }
        attendeeEvents.add(`occasion:${cur}`);
      }
    }
  }
  const ascending = s.after !== null && s.before === null;
  const rows = scope.db
    .prepare(
      `SELECT * FROM (${EVENT_SELECT})
       WHERE (@after IS NULL OR coalesce(ends_at, starts_at) >= @after) AND (@before IS NULL OR starts_at < @before)
       ORDER BY starts_at ${ascending ? 'ASC' : 'DESC'} LIMIT 2000`,
    )
    .all({ kinds: JSON.stringify(EVENT_KINDS), after: s.after, before: s.before }) as RawEvent[];
  const out: EventRow[] = [];
  const docOf = scope.db.prepare('SELECT n FROM ask_fts_docs WHERE kind = ? AND ref_id = ?').pluck();
  for (const r of rows) {
    if (attendeeEvents && !attendeeEvents.has(`${r.kind}:${r.id}`)) continue;
    if (docs) {
      const n = docOf.get(r.kind, r.id) as number | undefined;
      if (n === undefined || !docs.has(n)) continue;
    }
    out.push(toEvent(scope, r));
    if (out.length >= s.limit) break;
  }
  return out;
}

/** Default horizon for "recent" helpers. */
export const RECENT_MS = 90 * DAY_MS;
