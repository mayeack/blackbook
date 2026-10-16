/**
 * Fellegi–Sunter blocking and scoring (intelligence §1.5), pure over a loaded Book. Weights are in bits:
 * S = prior + Σ w, p = 2^S / (1 + 2^S).
 *
 * Name frequency: f = max(floor, in-book frequency of the name among *other* people). There is no SSA/Census
 * table here, so the floors stand in for the population: every first name counts as at least as common as "John"
 * (≈3%, +5 bits) and every surname as "Smith" (≈1%, +6.6 bits), which reproduces the spec's worked example
 * (two John Smiths: −10 + 5 + 6.6 ≈ 1.6, p ≈ 0.75) and keeps rare names from inflating name-only scores.
 * Names that recur in the book are weaker still; the in-book share is taken over at least MIN_FREQUENCY_BOOK
 * people, so a small or half-ingested book can't make three namesakes look like a third of humanity.
 */
import { compareFirst, compareLast, firstCanon, handleContainsName, type PersonName } from './matcherNames';
import { MAX_GRAPH_EVENT, MAX_GRAPH_GROUP, type Attendance, type Book, type Profile } from './matcherProfiles';

export type Family = 'name' | 'handle' | 'graph' | 'self_id' | 'context';

export const F_FIRST_FLOOR = 0.03;
export const F_LAST_FLOOR = 0.01;
/** The prior never gets weaker than −10 bits, so a small or half-ingested book never makes merging easier. */
export const PRIOR_MIN_BITS = 10;
/** The in-book name share is computed over at least this many named people. */
export const MIN_FREQUENCY_BOOK = 100;
/** Blocks are capped per person. */
export const MAX_PAIRS_PER_PERSON = 200;
const PHONE_WINDOW_DAYS = 30;

export const W = {
  firstMax: 6,
  firstDisagree: -5,
  lastMax: 9,
  lastConflict: -7,
  handle: 4,
  groupEach: 1.5,
  groupCap: 4.5,
  eventEach: 1,
  eventCap: 3,
  jaccardHigh: 2.5,
  jaccardLow: 1,
  selfId: 6,
  selfIdContradicts: -6,
  city: 1,
  coPresence: -20,
  twoPhones: -6,
} as const;

export interface PairCounts {
  shared_groups: number;
  shared_events: number;
  common_neighbors: number;
  jaccard: number;
}

export interface PairScore {
  /** Canonical person ids, a < b. */
  a: string;
  b: string;
  /** Feature → bits (the prior included). */
  bits: Record<string, number>;
  scoreBits: number;
  p: number;
  /** p without the co-presence veto (decides whether a vetoed pair is worth recording). */
  pRaw: number;
  families: Family[];
  coPresent: boolean;
  counts: PairCounts;
}

export const probability = (bits: number): number => 1 / (1 + 2 ** -bits);

/** −log2(pairs / people) ≈ −log2((n−1)/2), floored at −10 bits. */
export const priorBits = (people: number): number => -Math.max(PRIOR_MIN_BITS, Math.log2(Math.max(2, (people - 1) / 2)));

const lastInitial = (n: PersonName) => n.last[0] ?? '';
const nameBlockable = (x: PersonName | null, y: PersonName | null): boolean =>
  !!x && !!y && (!x.last || !y.last || lastInitial(x) === lastInitial(y));

/**
 * Candidate pairs (intelligence §1.5 "Blocking"): IG username ⊇ the other's name; ≥2 shared small groups or
 * events; a shared canonical first name with equal last initials (or a missing last name); the same surname with
 * the same first initial; a self-stated name. At most MAX_PAIRS_PER_PERSON per person, strongest blocks first.
 */
export function blockPairs(book: Book, cap = MAX_PAIRS_PER_PERSON): [string, string][] {
  const out = new Map<string, [string, string]>();
  const per = new Map<string, number>();
  const add = (x: string, y: string) => {
    if (x === y) return;
    const [a, b] = x < y ? [x, y] : [y, x];
    const k = `${a}|${b}`;
    if (out.has(k) || (per.get(a) ?? 0) >= cap || (per.get(b) ?? 0) >= cap) return;
    out.set(k, [a, b]);
    per.set(a, (per.get(a) ?? 0) + 1);
    per.set(b, (per.get(b) ?? 0) + 1);
  };
  const ps = [...book.profiles.values()].sort((x, y) => (x.id < y.id ? -1 : 1));

  // 1. The IG username contains the other person's first+last (or first+last-initial) tokens.
  const fullNamed = ps.filter((p) => p.name && p.name.first.length >= 2 && p.name.last.length >= 2);
  for (const h of ps) {
    if (!h.usernames.length) continue;
    for (const n of fullNamed) if (n !== h && h.usernames.some((u) => handleContainsName(u, n.name))) add(h.id, n.id);
  }

  // 2. ≥2 shared small group chats or events.
  const shared = new Map<string, number>();
  const countPairs = (groups: Map<string, string[]>, max: number) => {
    for (const ids of groups.values()) {
      if (ids.length > max) continue;
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const [a, b] = ids[i]! < ids[j]! ? [ids[i]!, ids[j]!] : [ids[j]!, ids[i]!];
          shared.set(`${a}|${b}`, (shared.get(`${a}|${b}`) ?? 0) + 1);
        }
      }
    }
  };
  const byConv = new Map<string, string[]>();
  const byEvent = new Map<string, string[]>();
  const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => {
    const list = m.get(k);
    if (list) list.push(v);
    else m.set(k, [v]);
  };
  for (const p of ps) {
    for (const c of p.convs.keys()) push(byConv, c, p.id);
    for (const e of p.events.keys()) push(byEvent, e, p.id);
  }
  countPairs(byConv, MAX_GRAPH_GROUP);
  countPairs(byEvent, MAX_GRAPH_EVENT);
  for (const [k, n] of [...shared].sort((x, y) => y[1] - x[1])) {
    if (n < 2) break;
    const [a, b] = k.split('|') as [string, string];
    add(a, b);
  }

  // 3. Canonical first names intersect, last initials agree or one side has none (self-stated names too).
  const byFirst = new Map<string, Profile[]>();
  const put = (c: string, p: Profile) => {
    const list = byFirst.get(c) ?? [];
    if (!list.includes(p)) list.push(p);
    byFirst.set(c, list);
  };
  for (const p of ps) {
    for (const c of p.firstCanon) put(c, p);
    for (const s of p.selfIds) for (const c of firstCanon(s.first)) put(c, p);
  }
  const namesOf = (p: Profile) => [p.name, ...p.selfIds].filter((n): n is PersonName => !!n);
  for (const list of byFirst.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const x = list[i]!;
        const y = list[j]!;
        if (namesOf(x).some((nx) => namesOf(y).some((ny) => nameBlockable(nx, ny)))) add(x.id, y.id);
      }
    }
  }

  // 4. Same surname, same first initial.
  const byLast = new Map<string, Profile[]>();
  for (const p of ps) if (p.name && p.name.last.length > 1) push(byLast, p.name.last, p);
  for (const list of byLast.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const x = list[i]!.name!;
        const y = list[j]!.name!;
        if (x.first && y.first && x.first[0] === y.first[0]) add(list[i]!.id, list[j]!.id);
      }
    }
  }
  return [...out.values()];
}

const nameCount = (counts: Map<string, number>, keys: string[]) => Math.max(0, ...keys.map((k) => counts.get(k) ?? 0));

/** min(cap, log2(0.95 / f)) with f = max(floor, frequency among the other people in the book). */
function nameWeight(count: number, named: number, floor: number, cap: number): number {
  const f = Math.max(floor, Math.max(0, count - 2) / Math.max(MIN_FREQUENCY_BOOK, named));
  return Math.min(cap, Math.log2(0.95 / f));
}

function intersects<T>(a: Set<T>, b: Set<T>): boolean {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

/** Two distinct identities of one kind on the same event, or two people on one explicit guest list. */
function eventCoPresent(xs: Attendance[], ys: Attendance[]): boolean {
  return xs.some((x) => ys.some((y) => (x.kind !== null && x.kind === y.kind && x.identityId !== y.identityId) || (x.explicit && y.explicit)));
}

/** Any two inbound 1:1 days, one per phone, within PHONE_WINDOW_DAYS of each other. */
function phonesOverlap(book: Book, xs: string[], ys: string[]): boolean {
  for (const x of xs) {
    const dx = book.phoneDays.get(x);
    if (!dx) continue;
    for (const y of ys) {
      const dy = book.phoneDays.get(y);
      if (!dy) continue;
      let i = 0;
      let j = 0;
      while (i < dx.length && j < dy.length) {
        if (Math.abs(dx[i]! - dy[j]!) <= PHONE_WINDOW_DAYS) return true;
        if (dx[i]! < dy[j]!) i++;
        else j++;
      }
    }
  }
  return false;
}

/** Self-stated names of one side against the other's name: +6 on a match, −6 when every stated name contradicts. */
function selfIdBits(stated: PersonName[], other: PersonName | null): number {
  if (!stated.length || !other?.first) return 0;
  const match = stated.some((s) => compareFirst(s.first, other.first) >= 0.9 && compareLast(s.last, other.last) !== 'conflict');
  if (match) return W.selfId;
  return stated.every((s) => s.first && compareFirst(s.first, other.first) === 0) ? W.selfIdContradicts : 0;
}

export function scorePair(book: Book, A: Profile, B: Profile, prior: number): PairScore {
  const bits: Record<string, number> = { prior };
  const na = A.name;
  const nb = B.name;

  // name
  if (na?.first && nb?.first) {
    const s = compareFirst(na.first, nb.first);
    const count = Math.max(nameCount(book.firstCount, firstCanon(na.first)), nameCount(book.firstCount, firstCanon(nb.first)));
    bits.first = s > 0 ? s * nameWeight(count, book.named, F_FIRST_FLOOR, W.firstMax) : W.firstDisagree;
  }
  if (na?.last && nb?.last) {
    const agreement = compareLast(na.last, nb.last);
    const count = Math.max(book.lastCount.get(na.last) ?? 0, book.lastCount.get(nb.last) ?? 0);
    const w = nameWeight(count, book.named, F_LAST_FLOOR, W.lastMax);
    if (agreement === 'agree') bits.last = w;
    else if (agreement === 'partial') bits.last = 0.5 * w;
    else if (agreement === 'conflict') bits.last = W.lastConflict;
  }

  // handle
  if (A.usernames.some((u) => handleContainsName(u, nb)) || B.usernames.some((u) => handleContainsName(u, na))) bits.handle = W.handle;

  // graph (and the co-presence veto)
  let coPresent = false;
  let groups = 0;
  for (const [conv, ma] of A.convs) {
    const mb = B.convs.get(conv);
    if (!mb) continue;
    if (intersects(ma.activeKinds, mb.activeKinds)) coPresent = true;
    else if ((book.convSize.get(conv) ?? 0) <= MAX_GRAPH_GROUP) groups++;
  }
  let events = 0;
  for (const [ek, ra] of A.events) {
    const rb = B.events.get(ek);
    if (!rb) continue;
    if (eventCoPresent(ra, rb)) coPresent = true;
    else if (ra.some((r) => r.going) && rb.some((r) => r.going) && (book.eventSize.get(ek) ?? 0) <= MAX_GRAPH_EVENT) events++;
  }
  if (groups) bits.groups = Math.min(W.groupCap, W.groupEach * groups);
  if (events) bits.events = Math.min(W.eventCap, W.eventEach * events);
  let common = 0;
  for (const n of A.neighbors) if (n !== B.id && B.neighbors.has(n)) common++;
  const union = A.neighbors.size - (A.neighbors.has(B.id) ? 1 : 0) + B.neighbors.size - (B.neighbors.has(A.id) ? 1 : 0) - common;
  const jaccard = union > 0 ? common / union : 0;
  if (common >= 2 && jaccard >= 0.3) bits.jaccard = W.jaccardHigh;
  else if (common >= 2 && jaccard >= 0.15) bits.jaccard = W.jaccardLow;

  // self_id
  const self = selfIdBits(A.selfIds, nb) || selfIdBits(B.selfIds, na);
  if (self) bits.self_id = self;

  // context
  if (A.cities.size && B.cities.size) bits.city = intersects(A.cities, B.cities) ? W.city : -W.city;

  // vetoes and penalties
  if (coPresent) bits.co_presence = W.coPresence;
  if (!A.newNumber && !B.newNumber && phonesOverlap(book, A.phones, B.phones)) bits.two_phones = W.twoPhones;

  const scoreBits = Object.values(bits).reduce((s, v) => s + v, 0);
  const families: Family[] = [];
  if ((bits.first ?? 0) + (bits.last ?? 0) > 0) families.push('name');
  if ((bits.handle ?? 0) > 0) families.push('handle');
  if ((bits.groups ?? 0) + (bits.events ?? 0) + (bits.jaccard ?? 0) > 0) families.push('graph');
  if ((bits.self_id ?? 0) > 0) families.push('self_id');
  if ((bits.city ?? 0) > 0) families.push('context');
  const [a, b] = A.id < B.id ? [A.id, B.id] : [B.id, A.id];
  return {
    a,
    b,
    bits,
    scoreBits,
    p: probability(scoreBits),
    pRaw: probability(scoreBits - (bits.co_presence ?? 0)),
    families,
    coPresent,
    counts: { shared_groups: groups, shared_events: events, common_neighbors: common, jaccard: Math.round(jaccard * 100) / 100 },
  };
}
