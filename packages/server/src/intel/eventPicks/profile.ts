/**
 * The owner's taste in public events (design docs/design/event-picks.md §3), from what he actually went to:
 *
 *   tickets   ticket_events (Gmail ticket mail): holding / unconfirmed weigh 1, gave_away 0.5, sold 0.3 —
 *             performers, genres, category, venue;
 *   calendar  social calendar occasions with a public-event title (concert, club night, festival, comedy, theater,
 *             sports, talk: intel/similarity.ts categoryFromTitle), weight 0.6 — category, venue, title words;
 *   partiful  Partiful events he went to as a guest, weight 0.2 — the 'party' category only (they're private:
 *             no title or place is ever used);
 *   picks     earlier picks he went to (weight 1, the pick's own features); picks he marked "not for me" are the
 *             dislikes.
 * Each weight decays with age (half-life PROFILE.halfLifeDays; upcoming tickets count as today), over the last
 * PROFILE.historyDays.
 *
 * What may leave the Mac (profilePrompt, through the egress choke point): category shares, performer and genre
 * names from tickets and picks, venue names, and titles of public events. A calendar title or venue that contains
 * any word that is a first or last name of someone in his people is never used in the prompt ("Comedy with Sam"),
 * nor anything that looks like an address. The full happening list (titles included) stays local for scoring.
 * Pure reader.
 */
import type { DB } from '../../db/connection';
import { DAY } from '../common';
import { categoryFromTitle, features, performerKey, genreKey, type EventFeatures, type TicketCategory } from '../similarity';

export const PROFILE = {
  historyDays: 540,
  halfLifeDays: 180,
  /** Upcoming ticket events within this many days count too (he bought them, so they're his taste). */
  aheadDays: 120,
  weights: { ticket: 1, gaveAway: 0.5, sold: 0.3, calendar: 0.6, partiful: 0.2, pick: 1 },
  /** Prompt list sizes. */
  maxPerformers: 15,
  maxGenres: 10,
  maxVenues: 10,
  maxTitles: 12,
} as const;

/** Categories a public event can have (a Partiful party or a dinner is never one). */
export const PUBLIC_CATEGORIES: ReadonlySet<TicketCategory> = new Set(['concert', 'club', 'festival', 'comedy', 'theater', 'sports', 'talk']);

export type HappeningSource = 'ticket' | 'calendar' | 'partiful' | 'pick';

export interface Happening {
  source: HappeningSource;
  features: EventFeatures;
  /** Recency-decayed weight. */
  weight: number;
}

export interface Weighted {
  label: string;
  weight: number;
}

export interface TasteProfile {
  happenings: Happening[];
  /** Category → share of the weight (sums to 1 over categories with any weight). */
  categoryShare: Map<TicketCategory, number>;
  performers: Weighted[];
  genres: Weighted[];
  venues: Weighted[];
  /** Titles of public events he went to, safe to send (newest / heaviest first). */
  titles: string[];
  /** Pick titles he marked "not for me" (public web events). */
  disliked: string[];
  counts: Record<HappeningSource, number>;
}

const decay = (at: number, now: number): number => Math.pow(0.5, Math.max(0, now - at) / DAY / PROFILE.halfLifeDays);

const jsonStrings = (raw: string | null | undefined): string[] => {
  try {
    const v = JSON.parse(raw ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()) : [];
  } catch {
    return [];
  }
};

/** First and last names of everyone in his people (folded), for keeping friends' names out of the prompt. */
export function personNameWords(db: DB): Set<string> {
  const out = new Set<string>();
  const rows = db.prepare(`SELECT first_name, last_name FROM people WHERE kind IN ('person','me') AND merged_into_id IS NULL`).all() as {
    first_name: string | null;
    last_name: string | null;
  }[];
  for (const r of rows) for (const n of [r.first_name, r.last_name]) for (const w of nameWords(n)) out.add(w);
  return out;
}

const nameWords = (s: string | null | undefined): string[] =>
  (s ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .filter((w) => w.length >= 3);

const ADDRESSY = /\d{2,}|\b(?:st|ave|rd|blvd|dr|ln|way|ct|pl|pkwy|hwy|street|avenue|road|boulevard|drive|lane|suite|apt|unit)\b\.?/i;

/** A calendar title / venue that may be sent: no name of anyone he knows, no address, not too long. */
export function promptSafe(text: string | null | undefined, names: ReadonlySet<string>): string | null {
  const t = text?.replace(/\s+/g, ' ').trim();
  if (!t || t.length > 80 || ADDRESSY.test(t) || /[@#]|:\/\/|https?:|www\.|\.(?:com|net|org|io)\b/i.test(t) || !/^[\p{L}\p{N}"'“(]/u.test(t)) return null;
  if (/['’]s\b/i.test(t)) return null; // "Sam's birthday", "at Jo's"
  return nameWords(t).some((w) => names.has(w)) ? null : t;
}

function bump(m: Map<string, { label: string; weight: number }>, key: string, label: string, w: number): void {
  if (!key) return;
  const cur = m.get(key);
  if (cur) cur.weight += w;
  else m.set(key, { label, weight: w });
}

const top = (m: Map<string, Weighted>, n: number): Weighted[] =>
  [...m.values()].sort((a, b) => b.weight - a.weight || a.label.localeCompare(b.label)).slice(0, n).map((x) => ({ label: x.label, weight: Math.round(x.weight * 100) / 100 }));

export function tasteProfile(db: DB, now: number, names: ReadonlySet<string> = personNameWords(db)): TasteProfile {
  const from = now - PROFILE.historyDays * DAY;
  const happenings: Happening[] = [];
  const cats = new Map<TicketCategory, number>();
  const performers = new Map<string, Weighted>();
  const genres = new Map<string, Weighted>();
  const venues = new Map<string, Weighted>();
  const titles: { title: string; weight: number }[] = [];
  const counts: Record<HappeningSource, number> = { ticket: 0, calendar: 0, partiful: 0, pick: 0 };
  const add = (source: HappeningSource, f: EventFeatures, weight: number) => {
    happenings.push({ source, features: f, weight });
    counts[source]++;
    if (f.category) cats.set(f.category, (cats.get(f.category) ?? 0) + weight);
  };

  const tickets = db
    .prepare(
      `SELECT title, performers, genres, category, venue, venue_key, starts_at, status FROM ticket_events
       WHERE merged_into_id IS NULL AND status IN ('holding','unconfirmed','gave_away','sold') AND starts_at >= ? AND starts_at < ?`,
    )
    .all(from, now + PROFILE.aheadDays * DAY) as {
    title: string;
    performers: string;
    genres: string;
    category: string;
    venue: string | null;
    venue_key: string | null;
    starts_at: number;
    status: string;
  }[];
  for (const t of tickets) {
    const base = t.status === 'gave_away' ? PROFILE.weights.gaveAway : t.status === 'sold' ? PROFILE.weights.sold : PROFILE.weights.ticket;
    const w = base * decay(t.starts_at, now);
    const ps = jsonStrings(t.performers);
    const gs = jsonStrings(t.genres);
    add('ticket', features({ category: t.category, performers: ps, genres: gs, venue: t.venue, venueKey: t.venue_key, titles: [t.title] }), w);
    for (const p of ps) bump(performers, performerKey(p), p.trim().slice(0, 60), w);
    for (const g of gs) bump(genres, genreKey(g), g.trim().toLowerCase().slice(0, 40), w);
    const v = promptSafe(t.venue, new Set());
    if (v) bump(venues, t.venue_key || performerKey(v), v, w);
    const title = promptSafe(t.title, new Set());
    if (title) titles.push({ title, weight: w });
  }

  // Calendar get-togethers with a public-event title, not already counted through a ticket, not a Partiful event.
  const occasions = db
    .prepare(
      `SELECT o.title, o.venue_text, o.venue_key, o.starts_at FROM occasions o
       WHERE o.merged_into_id IS NULL AND o.status = 'active' AND o.is_social = 1 AND o.sensitive = 0 AND o.title IS NOT NULL
         AND o.event_id IS NULL AND o.starts_at >= ? AND o.starts_at < ?
         AND NOT EXISTS (SELECT 1 FROM occasion_sources s WHERE s.occasion_id = o.id AND s.source = 'ticket')`,
    )
    .all(from, now) as { title: string; venue_text: string | null; venue_key: string | null; starts_at: number }[];
  for (const o of occasions) {
    const category = categoryFromTitle(o.title);
    if (!category || !PUBLIC_CATEGORIES.has(category)) continue;
    const w = PROFILE.weights.calendar * decay(o.starts_at, now);
    add('calendar', features({ category, venue: o.venue_text, venueKey: o.venue_key, titles: [o.title] }), w);
    const v = promptSafe(o.venue_text?.split(/[\n,;|]/)[0], names);
    if (v) bump(venues, o.venue_key || performerKey(v), v, w);
    const title = promptSafe(o.title, names);
    if (title) titles.push({ title, weight: w });
  }

  // Partiful parties he went to as a guest: the category only.
  const parties = db
    .prepare(
      `SELECT e.starts_at FROM events e WHERE e.source = 'partiful' AND lower(coalesce(e.my_rsvp, '')) IN ('going','approved','checked_in','attended')
         AND lower(coalesce(e.my_role, '')) NOT IN ('host','co_host','cohost') AND e.starts_at >= ? AND e.starts_at < ?`,
    )
    .pluck()
    .all(from, now) as number[];
  for (const at of parties) add('partiful', features({ category: 'party' }), PROFILE.weights.partiful * decay(at, now));

  const picks = db
    .prepare(`SELECT title, performers, genres, category, venue, venue_key, starts_at, status FROM event_picks WHERE status IN ('going','not_for_me') AND starts_at >= ?`)
    .all(from) as { title: string; performers: string; genres: string; category: string; venue: string; venue_key: string; starts_at: number; status: string }[];
  const disliked: string[] = [];
  for (const p of picks) {
    if (p.status === 'not_for_me') {
      disliked.push(p.title.slice(0, 80));
      continue;
    }
    const w = PROFILE.weights.pick * decay(p.starts_at, now);
    const ps = jsonStrings(p.performers);
    const gs = jsonStrings(p.genres);
    add('pick', features({ category: p.category, performers: ps, genres: gs, venue: p.venue, venueKey: p.venue_key, titles: [p.title] }), w);
    for (const x of ps) bump(performers, performerKey(x), x.trim().slice(0, 60), w);
    for (const g of gs) bump(genres, genreKey(g), g.trim().toLowerCase().slice(0, 40), w);
    bump(venues, p.venue_key || performerKey(p.venue), p.venue.slice(0, 60), w);
    titles.push({ title: p.title.slice(0, 80), weight: w });
  }

  const total = [...cats.values()].reduce((a, b) => a + b, 0);
  const categoryShare = new Map<TicketCategory, number>();
  for (const [c, w] of cats) categoryShare.set(c, total > 0 ? w / total : 0);
  const seen = new Set<string>();
  const titleList = titles
    .sort((a, b) => b.weight - a.weight)
    .map((t) => t.title)
    .filter((t) => {
      const k = t.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, PROFILE.maxTitles);
  return {
    happenings,
    categoryShare,
    performers: top(performers, PROFILE.maxPerformers),
    genres: top(genres, PROFILE.maxGenres),
    venues: top(venues, PROFILE.maxVenues),
    titles: titleList,
    disliked: [...new Set(disliked)].slice(0, 10),
    counts,
  };
}
