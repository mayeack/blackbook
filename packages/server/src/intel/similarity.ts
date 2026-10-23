/**
 * How alike two happenings are (tickets / met-at design §4 "event_invite suggestions"), so the brief can suggest
 * people the owner met at a *similar* event for one he holds tickets to (intel/eventInvites.ts).
 *
 * Features of a happening (an occasion, or a Partiful event no occasion covers):
 *   - category: the ticket's (ticket_events.category) when the occasion has a `ticket` source; 'party' for a
 *     Partiful event or an occasion linked to one; otherwise (a ticket's 'other' included) from the title
 *     (categoryFromTitle: festival, comedy, club, theater, sports, talk, concert, party). No match is null, and
 *     unknown is never "the same".
 *   - performers: the ticket's performers, folded (performerKey).
 *   - genres: the ticket's inferred genres, folded (genreKey).
 *   - venue_key: the ticket's, else the occasion's, else venueKey(venue text / Partiful location).
 *   - title tokens: distinctiveTokens of the titles (pipeline/occasions/text.ts): no stopwords or event-kind words.
 *
 * sim(M, U) = 1 with a shared performer (a performer of one also counts when the other's title names it as a whole
 *   phrase: "Example Band live" is that band's show), else
 *   0.35·Jaccard(genres) + 0.25·same category + 0.2·same venue + 0.2·IDF-weighted Jaccard(title tokens)
 * (intel/intros.ts idfJaccard; the IDF is over the owner's social happenings: titleCorpus → titleIdf).
 * Pure functions plus readers (featuresOf, titleCorpus, ticket chains); nothing here writes.
 */
import { normalizeNamePart } from '@yb/shared';
import type { DB } from '../db/connection';
import { occasionChain } from '../pipeline/occasions/build';
import { distinctiveTokens, venueKey } from '../pipeline/occasions/text';
import { DAY } from './common';
import { idfJaccard } from './intros';

export const TICKET_CATEGORIES = ['concert', 'club', 'festival', 'comedy', 'theater', 'sports', 'party', 'talk', 'member_event', 'other'] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

/** sim(M, U) weights (design §4). */
export const SIM = {
  performer: 1,
  genre: 0.35,
  category: 0.25,
  venue: 0.2,
  title: 0.2,
  /** A performer named inside the other's title counts only when its key is at least this long. */
  minPerformerInTitle: 4,
  /** Title-IDF corpus: the owner's happenings from this long ago (and up to a year ahead). */
  corpusDays: 3 * 365,
} as const;

/** Title words that say what kind of event it is, checked in this order (the first match wins). */
const CATEGORY_RULES: readonly [Exclude<TicketCategory, 'other' | 'member_event'>, RegExp][] = [
  ['festival', /\b(?:festival|fest)\b/i],
  ['comedy', /\b(?:comedy|comedian|stand[- ]?up|improv)\b/i],
  ['club', /\b(?:nightclub|club night|rave|dj|dj set|techno|afters|after[- ]?hours|boiler room|b2b|warehouse party|day party)\b/i],
  ['theater', /\b(?:theat(?:er|re)|broadway|musical|opera|ballet|playhouse|cabaret)\b/i],
  ['sports', /\b(?:vs|versus|baseball|basketball|football|soccer|hockey|tennis|ufc|boxing|playoffs?|marathon|grand prix|world cup|game day)\b/i],
  ['talk', /\b(?:talk|lecture|panel|conference|summit|keynote|fireside|book (?:launch|reading|signing)|seminar|workshop)\b/i],
  ['concert', /\b(?:concert|tour|live|gig|symphony|orchestra|philharmonic|recital|album release|listening party)\b/i],
  ['party', /\b(?:party|parties|birthday|bday|housewarming|bbq|barbecue|kickback|soir[ée]e|celebration|gala|game night)\b/i],
];

/** The kind of event a title names, or null when it says nothing (a dinner, "Sam's thing"). */
export function categoryFromTitle(title: string | null | undefined): TicketCategory | null {
  const t = title?.trim();
  if (!t) return null;
  for (const [c, re] of CATEGORY_RULES) if (re.test(t)) return c;
  return null;
}

/** 'other' (and anything unknown) is no category. */
const known = (c: string | null | undefined): TicketCategory | null =>
  c && c !== 'other' && (TICKET_CATEGORIES as readonly string[]).includes(c) ? (c as TicketCategory) : null;

/** A performer, folded: diacritics and case, "&" → "and", punctuation → space, no leading "the". */
export function performerKey(raw: string | null | undefined): string {
  return normalizeNamePart(raw)
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^the /, '');
}

/** A genre tag, folded ("Hip-Hop" = "hip hop", "R&B" = "r b"). */
export function genreKey(raw: string | null | undefined): string {
  return normalizeNamePart(raw)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export interface EventFeatures {
  category: TicketCategory | null;
  /** performerKey values. */
  performers: string[];
  /** genreKey values. */
  genres: string[];
  /** '' when unknown. */
  venueKey: string;
  /** distinctiveTokens of the titles. */
  titleTokens: string[];
  /** The titles folded like performers, space-joined with a space at each end (a performer named in the title). */
  titleText: string;
}

const uniq = (xs: Iterable<string>): string[] => [...new Set([...xs].filter(Boolean))];

/** Builds features from raw parts (folding everything); the readers below and the tests use it. */
export function features(o: {
  category?: string | null;
  performers?: readonly (string | null | undefined)[];
  genres?: readonly (string | null | undefined)[];
  venue?: string | null;
  venueKey?: string | null;
  titles?: readonly (string | null | undefined)[];
}): EventFeatures {
  const titles = (o.titles ?? []).filter((t): t is string => !!t?.trim());
  return {
    category: known(o.category) ?? categoryFromTitle(titles.join(' · ')),
    performers: uniq((o.performers ?? []).map(performerKey)),
    genres: uniq((o.genres ?? []).map(genreKey)),
    venueKey: o.venueKey?.trim() || venueKey(o.venue),
    titleTokens: distinctiveTokens(titles, [], 12),
    titleText: ` ${titles.map(performerKey).join(' ')} `,
  };
}

/** Plain Jaccard of two sets of strings (0 when both are empty). */
export function jaccard(a: readonly string[], b: readonly string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  const union = new Set([...A, ...B]).size;
  if (!union) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / union;
}

/** Words in titles that never identify a performer on their own ("Live", "DJ", "Tour"). */
const GENERIC_BILLING = new Set('live tour show shows band music dj djs presents present special guest guests tickets vip ga concert festival fest club tribute'.split(' '));

/** A performer of one is a performer of the other, or named as a whole phrase in its title. */
export function sharedPerformer(a: EventFeatures, b: EventFeatures): boolean {
  const named = (p: string, f: EventFeatures) =>
    p.length >= SIM.minPerformerInTitle && distinctiveTokens([p]).some((t) => !GENERIC_BILLING.has(t)) && f.titleText.includes(` ${p} `);
  return a.performers.some((p) => b.performers.includes(p) || named(p, b)) || b.performers.some((p) => named(p, a));
}

/** IDF of title tokens over a corpus of token lists: log((N + 1) / df), N ≥ 2. */
export function titleIdf(docs: Iterable<readonly string[]>): Map<string, number> {
  const df = new Map<string, number>();
  let n = 0;
  for (const d of docs) {
    n++;
    for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const N = Math.max(2, n);
  return new Map([...df].map(([t, c]) => [t, Math.log((N + 1) / c)]));
}

export interface SimParts {
  performer: boolean;
  genre: number;
  category: boolean;
  venue: boolean;
  title: number;
  score: number;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const asMap = (xs: readonly string[]) => new Map(xs.map((x) => [x, true]));

/** sim(M, U) with its parts (see the header). */
export function similarityParts(m: EventFeatures, u: EventFeatures, idf: ReadonlyMap<string, number> = new Map()): SimParts {
  const performer = sharedPerformer(m, u);
  const genre = jaccard(m.genres, u.genres);
  const category = m.category !== null && m.category === u.category;
  const venue = !!m.venueKey && m.venueKey === u.venueKey;
  const title = idfJaccard(asMap(m.titleTokens), asMap(u.titleTokens), idf).score;
  const score = performer ? SIM.performer : SIM.genre * genre + SIM.category * Number(category) + SIM.venue * Number(venue) + SIM.title * title;
  return { performer, genre: r3(genre), category, venue, title: r3(title), score: r3(score) };
}

export const similarity = (m: EventFeatures, u: EventFeatures, idf?: ReadonlyMap<string, number>): number => similarityParts(m, u, idf).score;

// ---------------------------------------------------------------------------------------------- readers

/** A happening a met-at link or a suggestion points at. */
export interface HappeningRef {
  type: 'occasion' | 'event';
  id: string;
}

/** The live occasion an id ended up as (following merged_into_id), or null when it is gone. */
export function survivorOccasion(db: DB, id: string): string | null {
  const get = db.prepare('SELECT merged_into_id FROM occasions WHERE id = ?');
  let cur = id;
  for (let i = 0; i < 50; i++) {
    const r = get.get(cur) as { merged_into_id: string | null } | undefined;
    if (!r) return null;
    if (!r.merged_into_id) return cur;
    cur = r.merged_into_id;
  }
  return null;
}

/** The ticket event an id ended up as (following merged_into_id), or null when it is gone. */
export function survivorTicket(db: DB, id: string): string | null {
  const get = db.prepare('SELECT merged_into_id FROM ticket_events WHERE id = ?');
  let cur = id;
  for (let i = 0; i < 50; i++) {
    const r = get.get(cur) as { merged_into_id: string | null } | undefined;
    if (!r) return null;
    if (!r.merged_into_id) return cur;
    cur = r.merged_into_id;
  }
  return null;
}

export interface TicketEventRow {
  id: string;
  title: string;
  title_key: string;
  performers: string;
  genres: string;
  category: string;
  venue: string | null;
  venue_key: string | null;
  starts_at: number;
  local_date: string;
  partiful_ids: string;
  status: string;
}

/** Surviving ticket events behind an occasion's merge chain (any status), in id order. */
export function ticketEventsOf(db: DB, occasionId: string): TicketEventRow[] {
  const refs = db
    .prepare(`SELECT source_ref FROM occasion_sources WHERE source = 'ticket' AND occasion_id IN (SELECT value FROM json_each(?))`)
    .pluck()
    .all(JSON.stringify(occasionChain(db, occasionId))) as string[];
  const ids = uniq(refs.map((r) => survivorTicket(db, r) ?? ''));
  if (!ids.length) return [];
  return db
    .prepare(
      `SELECT id, title, title_key, performers, genres, category, venue, venue_key, starts_at, local_date, partiful_ids, status
       FROM ticket_events WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id`,
    )
    .all(JSON.stringify(ids)) as TicketEventRow[];
}

const jsonStrings = (raw: string | null | undefined): string[] => {
  try {
    const v = JSON.parse(raw ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

/** Features of a happening (see the header); null when it no longer exists. Occasions resolve to their survivor. */
export function featuresOf(db: DB, ref: HappeningRef): EventFeatures | null {
  if (ref.type === 'event') {
    const e = db.prepare('SELECT source, title, location_text FROM events WHERE id = ?').get(ref.id) as
      | { source: string; title: string | null; location_text: string | null }
      | undefined;
    if (!e) return null;
    return features({ category: e.source === 'partiful' ? 'party' : null, venue: e.location_text, titles: [e.title] });
  }
  const id = survivorOccasion(db, ref.id);
  if (!id) return null;
  const o = db
    .prepare(`SELECT o.title, o.venue_text, o.venue_key, e.source AS event_source FROM occasions o LEFT JOIN events e ON e.id = o.event_id WHERE o.id = ?`)
    .get(id) as { title: string | null; venue_text: string | null; venue_key: string | null; event_source: string | null } | undefined;
  if (!o) return null;
  const tickets = ticketEventsOf(db, id);
  if (tickets.length) {
    return features({
      category: tickets.map((t) => known(t.category)).find((c) => c !== null) ?? null,
      performers: tickets.flatMap((t) => jsonStrings(t.performers)),
      genres: tickets.flatMap((t) => jsonStrings(t.genres)),
      venueKey: tickets.map((t) => t.venue_key?.trim() || venueKey(t.venue)).find(Boolean) || o.venue_key,
      venue: o.venue_text,
      titles: [o.title, ...tickets.map((t) => t.title), ...tickets.map((t) => t.title_key)],
    });
  }
  return features({ category: o.event_source === 'partiful' ? 'party' : null, venueKey: o.venue_key, venue: o.venue_text, titles: [o.title] });
}

/**
 * Title-token lists of the owner's social happenings around `now` (active, social, non-sensitive, unmerged
 * occasions and Partiful events no live occasion covers), the IDF corpus for titles.
 */
export function titleCorpus(db: DB, now: number): string[][] {
  const titles = db
    .prepare(
      `SELECT o.title FROM occasions o
       WHERE o.merged_into_id IS NULL AND o.status = 'active' AND o.is_social = 1 AND o.sensitive = 0 AND o.title IS NOT NULL
         AND o.starts_at >= @from AND o.starts_at < @to
       UNION ALL
       SELECT e.title FROM events e
       WHERE e.source = 'partiful' AND e.title IS NOT NULL AND e.starts_at >= @from AND e.starts_at < @to
         AND NOT EXISTS (SELECT 1 FROM occasions o WHERE o.event_id = e.id AND o.merged_into_id IS NULL AND o.status IN ('active','candidate'))`,
    )
    .pluck()
    .all({ from: now - SIM.corpusDays * DAY, to: now + 365 * DAY }) as string[];
  return titles.map((t) => distinctiveTokens([t], [], 12));
}
