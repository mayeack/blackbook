/**
 * Met-at scoring (design docs/design/tickets-met-at.md §2 + the [met] review amendments), pure and synchronous:
 *   - a signal at time t scores every candidate happening whose window [start − 2 h, end + 36 h] holds t as
 *     base × gap × source weight, and takes the max;
 *   - a tie goes to the shortest happening that contains t;
 *   - the pick is ambiguous (× 0.6) only when the runner-up scores ≥ 0.9 × the best AND sits at a different venue;
 *   - several signals on one happening combine as a noisy-OR, capped at 0.95; a link is written at ≥ 0.5;
 *   - a signal is dropped for a happening when the person's name or handle IS the happening (a performer, the venue,
 *     the title), or the person is any ticket performer at all (their name, or it with an artist word around it).
 * Nothing here reads the database or logs.
 */
import { normalizeNamePart } from '@yb/shared';
import { words } from '../../pipeline/occasions/text';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export type SignalKind = 'contact_screenshot' | 'contact_added' | 'instagram_follow' | 'instagram_dm';

/** How much one signal alone says "met at the event around t". */
export const BASE: Readonly<Record<SignalKind, number>> = {
  contact_screenshot: 0.85,
  contact_added: 0.8,
  instagram_follow: 0.75,
  instagram_dm: 0.65,
};

export const MET_AT = {
  /** Window around a happening a signal may fall in. */
  beforeMs: 2 * HOUR,
  afterMs: 36 * HOUR,
  /** Known before E: evidence earlier than E.start − 12 h. */
  knownCutoffMs: 12 * HOUR,
  /** Default lengths when the source has no end. */
  defaultLenMs: { club: 6 * HOUR, festival: 10 * HOUR, other: 4 * HOUR },
  /** Weights: ticket / Partiful-going happenings, everything else social (and a 'maybe' RSVP). */
  weightConfirmed: 1,
  weightOther: 0.85,
  /** Runner-up rule: ≥ this share of the best, at a different venue → × ambiguity. */
  runnerUpShare: 0.9,
  ambiguity: 0.6,
  cap: 0.95,
  /** Written at or above. */
  minWrite: 0.5,
  /** A roster-only person with an active link at or above this is brought forward (provisional). */
  bringForward: 0.6,
  /** contact_added: ≥ bulkCount creation times within bulkWindowMs is a bulk (an import or a device setup). */
  bulkCount: 5,
  bulkWindowMs: 2 * MINUTE,
  /** Cards first seen within this of the very first address-book pass are the first dump. */
  firstDumpMs: 10 * MINUTE,
  /** instagram_follow: ≥ burstCount follows within burstWindowMs are dropped. */
  burstCount: 10,
  burstWindowMs: 30 * MINUTE,
  /** instagram_dm: the chat was born while watched when its row was created ≤ this after its first message. */
  bornWatchedMs: DAY,
  /** Screenshots of an IG profile with at least this many followers are not contact info. */
  maxFollowers: 5000,
  /** Known-before: group sessions only in groups of ≤ this; attendance only at events of ≤ this many counted people. */
  maxGroupSession: 50,
  maxAttendance: 50,
  /** Known-before: co-membership of a group chat of ≤ this many members. */
  maxCoMemberGroup: 12,
} as const;

/** Gap factor of t against [start, end]: 1 inside, 0.8 up to 2 h before, 0.9/0.8/0.7 up to 12/24/36 h after, else 0. */
export function gapFactor(t: number, start: number, end: number): number {
  if (t >= start && t <= end) return 1;
  if (t < start) return start - t <= MET_AT.beforeMs ? 0.8 : 0;
  const after = t - end;
  if (after <= 12 * HOUR) return 0.9;
  if (after <= 24 * HOUR) return 0.8;
  if (after <= MET_AT.afterMs) return 0.7;
  return 0;
}

/** Several signals on one happening: 1 − Π(1 − c), capped. */
export function combine(cs: readonly number[]): number {
  let miss = 1;
  for (const c of cs) miss *= 1 - Math.min(1, Math.max(0, c));
  return Math.min(MET_AT.cap, 1 - miss);
}

export const round3 = (x: number): number => Math.round(x * 1000) / 1000;

// ---------------------------------------------------------------------------------------------- choice

/** One scored candidate for a signal (a happening, or one member of it). */
export interface Scored<T> {
  item: T;
  score: number;
  start: number;
  end: number;
  /** Venue keys of the candidate ('' never counts). */
  venues: ReadonlySet<string>;
}

export interface Choice<T> {
  item: T;
  score: number;
  /** The runner-up was close and somewhere else: the score already carries × 0.6. */
  ambiguous: boolean;
}

const contains = (t: number, s: { start: number; end: number }) => t >= s.start && t <= s.end;
const sameVenue = (a: ReadonlySet<string>, b: ReadonlySet<string>) => [...a].some((v) => v !== '' && b.has(v));

/**
 * The best candidate for a signal at t: max score; a tie goes to the shortest candidate containing t (then the
 * earlier start). × 0.6 when the runner-up scores ≥ 0.9 × the best and shares no venue key with it.
 */
export function choose<T>(t: number, cands: readonly Scored<T>[]): Choice<T> | null {
  const live = cands.filter((c) => c.score > 0);
  if (!live.length) return null;
  const sorted = [...live].sort(
    (a, b) =>
      b.score - a.score ||
      Number(contains(t, b)) - Number(contains(t, a)) ||
      a.end - a.start - (b.end - b.start) ||
      a.start - b.start,
  );
  const best = sorted[0]!;
  const runner = sorted[1];
  const ambiguous = !!runner && runner.score >= MET_AT.runnerUpShare * best.score && !sameVenue(best.venues, runner.venues);
  return { item: best.item, score: ambiguous ? best.score * MET_AT.ambiguity : best.score, ambiguous };
}

// ---------------------------------------------------------------------------------------------- self-references

/** Letters and digits only, diacritics folded ("Fred again.." → "fredagain"). */
export const compact = (s: string | null | undefined): string => normalizeNamePart(s ?? '').replace(/[^\p{L}\p{N}]+/gu, '');

/** What a happening calls itself: performers, venues and title tokens, compacted. */
export interface HappeningLabels {
  performers: ReadonlySet<string>;
  venues: ReadonlySet<string>;
  /** Distinctive title tokens (≥ 3 chars) and the whole compacted titles. */
  titleTokens: ReadonlySet<string>;
  titles: ReadonlySet<string>;
}

/** What a person is called: full names (compacted + their words) and Instagram handles (compacted). */
export interface PersonLabels {
  names: readonly { compact: string; words: readonly string[] }[];
  handles: readonly string[];
}

export function personLabels(names: readonly (string | null | undefined)[], handles: readonly (string | null | undefined)[]): PersonLabels {
  const seen = new Set<string>();
  const outNames: { compact: string; words: string[] }[] = [];
  for (const n of names) {
    const c = compact(n);
    if (!c || seen.has(c)) continue;
    seen.add(c);
    outNames.push({ compact: c, words: words(n ?? '') });
  }
  return { names: outNames, handles: [...new Set(handles.map((h) => compact(h)).filter((h) => h.length >= 3))] };
}

const overlaps = (a: string, b: string, min: number) => a.length >= min && b.length >= min && (a === b || a.includes(b) || b.includes(a));

/** What artists put around their name on Instagram ("neonharbor.official", "itsneonharbor", "neonharbormusic2"). */
const ARTIST_AFFIX = /^(?:the|its|iam|im|real|official|ofc|music|band|dj|live|tv|hq|mgmt|records|tour|team|fans?|x|\d)*$/;
/** Of those, the ones only an artist uses: a year, an x or "its" around a name is just as often a person's own handle. */
const ARTIST_WORD = /official|ofc|music|band|dj|live|tv|hq|mgmt|records|tour/;

/**
 * A (compacted) handle is the performer's account: the performer's name alone, or with only the usual artist affixes
 * around it. A person's own handle that merely contains a performer's name ("marina.sample" for the artist
 * "Marina") is not. `strict` (any ticket performer, not this happening's): the affixes must hold an artist word, so
 * "dixon1994" or "imjordan" stays a person while "dixon.official" or "dixonmusic2" is the artist.
 */
export function handleIsPerformer(handle: string, performer: string, strict = false): boolean {
  if (handle === performer) return true;
  if (performer.length < 4) return false;
  const at = handle.indexOf(performer);
  if (at < 0) return false;
  const before = handle.slice(0, at);
  const after = handle.slice(at + performer.length);
  return ARTIST_AFFIX.test(before) && ARTIST_AFFIX.test(after) && (!strict || ARTIST_WORD.test(before) || ARTIST_WORD.test(after));
}

/**
 * The person's name or handle IS this happening: a name equal to a performer, the venue or the title; a full name
 * whose every word is a title token; a handle equal to a title token or the title, that is a performer's account
 * (handleIsPerformer) or a ≥ 5-letter part of a performer's name, or that contains / is contained in the venue.
 */
export function namesHappening(p: PersonLabels, h: HappeningLabels): boolean {
  for (const n of p.names) {
    if (n.compact.length >= 4 && (h.performers.has(n.compact) || h.venues.has(n.compact) || h.titles.has(n.compact))) return true;
    if (n.words.length >= 2 && n.words.every((w) => h.titleTokens.has(w))) return true;
  }
  for (const c of p.handles) {
    if (h.titleTokens.has(c) || h.titles.has(c)) return true;
    for (const x of h.performers) if (handleIsPerformer(c, x) || (c.length >= 5 && x.includes(c))) return true;
    for (const x of h.venues) if (overlaps(c, x, 5)) return true;
  }
  return false;
}

/**
 * The person is a performer on any ticket the owner ever had (an artist's account, never someone he met): the name
 * itself, or the handle with an artist word around it (handleIsPerformer strict; at any show, years apart).
 */
export function isPerformer(p: PersonLabels, performers: ReadonlySet<string>): boolean {
  if (!performers.size) return false;
  for (const n of p.names) if (n.compact.length >= 4 && performers.has(n.compact)) return true;
  for (const c of p.handles) {
    if (performers.has(c)) return true;
    for (const x of performers) if (handleIsPerformer(c, x, true)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------- bursts

/**
 * Marks every time that sits in some window of `windowMs` holding ≥ `count` times (inclusive), over all `times`.
 * Returns the set of indexes (into the input) that are part of a burst.
 */
export function burstIndexes(times: readonly number[], count: number, windowMs: number): Set<number> {
  const order = times.map((t, i) => [t, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Set<number>();
  let j = 0;
  let markedTo = -1;
  for (let i = 0; i < order.length; i++) {
    if (j < i) j = i;
    while (j + 1 < order.length && order[j + 1]![0] - order[i]![0] <= windowMs) j++;
    if (j - i + 1 >= count) {
      for (let k = Math.max(i, markedTo + 1); k <= j; k++) out.add(order[k]![1]);
      markedTo = Math.max(markedTo, j);
    }
  }
  return out;
}
