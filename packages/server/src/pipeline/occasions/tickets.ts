/**
 * Ticket copies for the occasions build (design docs/design/tickets-met-at.md §1 "Occasions integration" and its
 * review amendments [occ]). Every live ticket_events row (merged_into_id NULL) the owner is `holding` and whose start
 * falls in the pass's [from, to] window becomes one more copy of a happening, next to the calendar copies: treatment
 * 'attending', social, never a reservation, no notes, no invitees. Rows he no longer holds (sold, gave_away,
 * refunded, cancelled) are loaded too, only to retire the Gmail-made calendar copy of a show he didn't go to;
 * 'unconfirmed' rows are never read.
 *
 * Attaching runs AFTER the calendar copies cluster (build.ts clusterEvents), without union-find chaining:
 *   - a ticket copy matches a calendar copy when they share a Partiful id (±36 h), a venue_key within ±3 h, title
 *     tokens (Jaccard ≥ 0.5) or a performer named in its title (a social or unknown copy only) on the same local day
 *     (the venue's date; an all-day copy's own date on the owner's calendar), or the calendar copy is a Gmail-made
 *     event (eventType fromGmail) within ±3 h that is not a table reservation, a trip or an appointment and is not at
 *     another venue. Trips, lodging, appointments, multi-day all-day copies and invites the owner declined match by
 *     a shared Partiful id only (the same happening, as clusterEvents has it). A guessed zone (ticket_events.tz NULL)
 *     never uses the ±3 h rules;
 *   - each ticket copy attaches to at most ONE calendar cluster, its best match; a cluster takes at most one ticket
 *     copy (the better match wins, the other stands alone). Two ticket copies never join: an unmatched one is a
 *     ticket-only occasion. A ticket copy drops a Partiful id another cluster already carries, so one occasion
 *     holds each Partiful event;
 *   - a cluster made only of fromGmail copies whose best-matching ticket is no longer held is `released`: the
 *     occasion becomes 'excluded' (he sold or gave away the tickets Gmail put on his calendar).
 * Ids: a copy's id is the surviving ticket_events.id; `aliases` are the rows merged into it, so occasion_sources
 * rows written before a ledger merge still claim their occasion. Pure, except the loader and the lookups at the end.
 */
import { localDate } from '@yb/shared';
import { z } from 'zod';
import type { DB } from '../../db/connection';
import { occasionDays, survivingOccasion, type CalEvent } from './build';
import { distinctiveTokens, reservationVenue, VENUE_WORDS, venueKey, words } from './text';

export { SHOW_CATEGORIES } from './classify';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** A known-zone ticket and a calendar copy this close in start time can be the same show. */
const MATCH_WINDOW = 3 * HOUR;
const PARTIFUL_WINDOW = 36 * HOUR;
/** ticketMatch's score for a shared Partiful id (the best there is). */
const PARTIFUL_SCORE = 4;

/** Ticket statuses that mean the owner no longer goes (the 'unconfirmed' ones never become occasions at all). */
export const RELEASED_STATUSES: ReadonlySet<string> = new Set(['gave_away', 'sold', 'refunded', 'cancelled']);
/** Default length when the ledger has no end (it always writes one; older rows may not). */
const LENGTH: Record<string, number> = { club: 6 * HOUR, festival: 10 * HOUR };
const DEFAULT_LENGTH = 4 * HOUR;
/** A calendar copy of these kinds is never the same happening as a show. */
const NEVER_A_SHOW = new Set(['travel', 'lodging', 'appointment']);
/** A Gmail-made copy matched on time alone must at least not be something else. */
const MAYBE_A_SHOW = new Set(['social', 'unknown']);

export interface TicketCopy {
  /** The surviving ticket_events.id. */
  id: string;
  /** Ticket rows merged into it (occasion_sources may still name them). */
  aliases: string[];
  status: string;
  category: string;
  performers: string[];
  /** The venue's local date (YYYY-MM-DD). */
  localDate: string;
  /** The venue's IANA zone; null = guessed from the owner's, so the hour is not trusted for joins. */
  tz: string | null;
  /** bought + received − sold − refunded (tickets he sent friends still mean his party); null when unknown. */
  count: number | null;
}

export interface TicketCopies {
  /** Holding rows, as copies ready to attach. */
  live: CalEvent[];
  /** Rows he no longer holds (only for retiring a fromGmail-only cluster). */
  released: CalEvent[];
}

interface TicketRow {
  id: string;
  title: string;
  performers: string;
  category: string;
  venue: string | null;
  venue_key: string | null;
  city: string | null;
  starts_at: number;
  ends_at: number | null;
  tz: string | null;
  local_date: string;
  partiful_ids: string;
  qty_bought: number;
  qty_received: number;
  qty_sold: number;
  qty_refunded: number;
  held: number | null;
  status: string;
}

const StringList = z.array(z.string().max(300)).max(50);
const PARTIFUL_ID = /^[A-Za-z0-9_-]{6,64}$/;

function stringList(raw: string): string[] {
  try {
    const parsed = StringList.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.map((s) => s.trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function validZone(tz: string | null): string | null {
  if (!tz) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

/** Every ticket id merged (directly or through a chain) into each surviving row. */
function aliasesBySurvivor(db: DB): Map<string, string[]> {
  const next = new Map(
    (db.prepare('SELECT id, merged_into_id FROM ticket_events WHERE merged_into_id IS NOT NULL').all() as { id: string; merged_into_id: string }[]).map(
      (r) => [r.id, r.merged_into_id],
    ),
  );
  const out = new Map<string, string[]>();
  for (const id of [...next.keys()].sort()) {
    const seen = new Set([id]);
    let cur = next.get(id)!;
    while (next.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = next.get(cur)!;
    }
    out.set(cur, [...(out.get(cur) ?? []), id]);
  }
  return out;
}

/** The ticket count an occasion gets from its ledger row (see TicketCopy.count). */
export function ticketCopyCount(r: Pick<TicketRow, 'qty_bought' | 'qty_received' | 'qty_sold' | 'qty_refunded' | 'held'>): number | null {
  if (r.held === null) return null;
  const n = r.qty_bought + r.qty_received - r.qty_sold - r.qty_refunded;
  return n >= 1 ? n : null;
}

/** Live ticket rows starting in [from, to]: holding ones as copies, released ones for the fromGmail rule. */
export function loadTicketEvents(db: DB, from: number, to: number): TicketCopies {
  const rows = db
    .prepare(
      `SELECT id, title, performers, category, venue, venue_key, city, starts_at, ends_at, tz, local_date, partiful_ids,
              qty_bought, qty_received, qty_sold, qty_refunded, held, status
       FROM ticket_events
       WHERE merged_into_id IS NULL AND starts_at BETWEEN ? AND ? AND status <> 'unconfirmed'
       ORDER BY starts_at, id`,
    )
    .all(from, to) as TicketRow[];
  const out: TicketCopies = { live: [], released: [] };
  if (!rows.length) return out;
  const aliases = aliasesBySurvivor(db);
  for (const r of rows) {
    const holding = r.status === 'holding';
    if (!holding && !RELEASED_STATUSES.has(r.status)) continue;
    const title = r.title.trim();
    const venue = (r.venue ?? '').trim();
    const location = [venue, (r.city ?? '').trim()].filter(Boolean).join(', ');
    const endsAt = r.ends_at && r.ends_at > r.starts_at ? r.ends_at : r.starts_at + (LENGTH[r.category] ?? DEFAULT_LENGTH);
    const copy: CalEvent = {
      id: r.id,
      source: 'ticket',
      calendarId: '',
      treatment: 'attending',
      title,
      notes: '',
      location,
      venue,
      venueKey: venueKey(venue) || (r.venue_key ?? ''),
      titleKey: words(title).join(' '),
      startsAt: r.starts_at,
      endsAt,
      allDay: false,
      icalUid: null,
      dates: null,
      partifulIds: [...new Set(stringList(r.partiful_ids).filter((p) => PARTIFUL_ID.test(p)))],
      reservation: false,
      fromGmail: false,
      selfDeclined: false,
      attendees: [],
      social: true,
      kind: 'social',
      ticket: {
        id: r.id,
        aliases: aliases.get(r.id) ?? [],
        status: r.status,
        category: r.category,
        performers: stringList(r.performers),
        localDate: r.local_date,
        tz: validZone(r.tz),
        count: ticketCopyCount(r),
      },
    };
    (holding ? out.live : out.released).push(copy);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ matching

const titleTokens = (t: string): string[] => distinctiveTokens([t], [], 32);

function jaccard(a: readonly string[], b: readonly string[]): number {
  if (!a.length || !b.length) return 0;
  const sb = new Set(b);
  const inter = a.filter((w) => sb.has(w)).length;
  return inter / new Set([...a, ...b]).size;
}

/** Venue words that name the place (not "hall", "club"). */
const strongVenueWords = (key: string): string[] => words(key).filter((w) => w.length >= 4 && !VENUE_WORDS.has(w));

/** Two venue keys that could be the same place (either missing counts as could-be). */
function venueCompatible(a: string, b: string): boolean {
  if (!a || !b || a === b) return true;
  const sa = strongVenueWords(a);
  const sb = strongVenueWords(b);
  if (!sa.length || !sb.length) return a.includes(b) || b.includes(a);
  return sa.some((w) => sb.includes(w));
}

/** A performer whose distinctive words all appear in the calendar title. */
function performerNamed(performers: readonly string[], title: string): boolean {
  const have = new Set(words(title));
  return performers.some((p) => {
    const toks = distinctiveTokens([p], [], 8);
    return toks.length > 0 && toks.every((w) => have.has(w));
  });
}

/**
 * The local dates of a calendar copy, to compare with the ticket's venue date. A timed copy is an instant, read in
 * the venue's zone (the owner's when it was guessed); an all-day copy is a date on the owner's own calendar, so it
 * is read in the owner's zone whatever the venue's.
 */
function calendarDays(c: CalEvent, venueZone: string | null, ownerZone: string | undefined): Set<string> {
  return c.allDay ? occasionDays(c.startsAt, c.endsAt, true, ownerZone, c.dates) : new Set([localDate(c.startsAt, venueZone ?? ownerZone)]);
}

/**
 * How well a ticket copy matches one calendar copy: 0 = not the same happening; higher is better (a shared Partiful
 * id 4, the same venue ±3 h 3–3.5, title or performer on the same local day 2–2.5, a Gmail-made copy ±3 h 1–1.5).
 * A shared Partiful id is the same happening whatever the copy's kind, length or the owner's answer (clusterEvents
 * unions it the same way); nothing else matches a trip, lodging, an appointment, a multi-day all-day copy or an
 * invite he declined. `timeZone` is the owner's zone.
 */
export function ticketMatch(t: CalEvent, c: CalEvent, timeZone?: string): number {
  const info = t.ticket;
  if (!info || c.source !== 'calendar') return 0;
  const dt = Math.abs(t.startsAt - c.startsAt);
  if (dt <= PARTIFUL_WINDOW && t.partifulIds.some((p) => c.partifulIds.includes(p))) return PARTIFUL_SCORE;
  if (NEVER_A_SHOW.has(c.kind) || c.selfDeclined || (c.allDay && calendarDays(c, null, timeZone).size > 1)) return 0;
  let best = 0;
  const timed = info.tz !== null && !c.allDay && dt <= MATCH_WINDOW;
  const near = 1 - dt / MATCH_WINDOW;
  if (timed && t.venueKey && t.venueKey === c.venueKey) best = Math.max(best, 3 + 0.5 * near);
  if (best < 2.5 && calendarDays(c, info.tz, timeZone).has(info.localDate)) {
    const j = jaccard(titleTokens(t.title), titleTokens(c.title));
    if (j >= 0.5) best = Math.max(best, 2 + 0.5 * j);
    // a performer's name in a work or errand title ("Band practice") is not the show
    else if (MAYBE_A_SHOW.has(c.kind) && performerNamed(info.performers, c.title)) best = Math.max(best, 2);
  }
  if (timed && c.fromGmail && MAYBE_A_SHOW.has(c.kind) && reservationVenue(c.title) === null && venueCompatible(t.venueKey, c.venueKey)) {
    best = Math.max(best, 1 + 0.5 * near);
  }
  return Math.round(best * 1000) / 1000;
}

/** Cluster indices with a copy starting within ±2 days of each day (a coarse pre-filter for ticketMatch). */
function dayIndex(clusters: readonly CalEvent[][]): Map<number, number[]> {
  const out = new Map<number, number[]>();
  clusters.forEach((cluster, k) => {
    for (const e of cluster) {
      const d = Math.floor(e.startsAt / DAY);
      const list = out.get(d) ?? [];
      if (list[list.length - 1] !== k) list.push(k);
      out.set(d, list);
    }
  });
  return out;
}

/** The owner declined every copy he would attend (draftOccasion's selfDeclined): the occasion is 'excluded'. */
function declinedCluster(cluster: readonly CalEvent[]): boolean {
  const attending = cluster.filter((e) => e.treatment !== 'candidate');
  return attending.length > 0 && attending.every((e) => e.selfDeclined);
}

function bestCluster(t: CalEvent, clusters: readonly CalEvent[][], index: Map<number, number[]>, timeZone?: string): { k: number; score: number } | null {
  const day = Math.floor(t.startsAt / DAY);
  const seen = new Set<number>();
  let best: { k: number; score: number } | null = null;
  for (let d = day - 2; d <= day + 2; d++) {
    for (const k of index.get(d) ?? []) {
      if (seen.has(k)) continue;
      seen.add(k);
      let score = 0;
      for (const c of clusters[k]!) score = Math.max(score, ticketMatch(t, c, timeZone));
      // an invite he declined takes a ticket by a shared Partiful id only, not through a shared calendar's copy of it
      if (score < PARTIFUL_SCORE && declinedCluster(clusters[k]!)) score = 0;
      if (score > 0 && (!best || score > best.score || (score === best.score && k < best.k))) best = { k, score };
    }
  }
  return best;
}

export interface AttachedClusters {
  /** The calendar clusters (a matched one with its ticket copy appended), then one cluster per unmatched ticket. */
  clusters: CalEvent[][];
  /** Clusters of fromGmail copies only, best-matched by a ticket the owner no longer holds: retired as 'excluded'. */
  released: Set<CalEvent[]>;
}

/**
 * One cluster per Partiful event: a ticket copy keeps a Partiful id only when no other cluster carries it (calendar
 * copies first, then ticket copies in cluster order), else two occasions would take its 'partiful' source from each
 * other on every pass. A ticket copy that loses an id is replaced in its (new) cluster array; loaded copies stay as
 * they were.
 */
function claimPartifulIds(out: CalEvent[][]): void {
  const holder = new Map<string, number>();
  out.forEach((cluster, k) => {
    for (const e of cluster) if (e.source === 'calendar') for (const p of e.partifulIds) if (!holder.has(p)) holder.set(p, k);
  });
  out.forEach((cluster, k) => {
    cluster.forEach((e, i) => {
      if (e.source !== 'ticket' || !e.partifulIds.length) return;
      const kept = e.partifulIds.filter((p) => {
        if (!holder.has(p)) holder.set(p, k);
        return holder.get(p) === k;
      });
      if (kept.length < e.partifulIds.length) cluster[i] = { ...e, partifulIds: kept };
    });
  });
}

/** Attaches ticket copies to the calendar clusters (see the module header). With no tickets, `clusters` is returned as is. */
export function attachTickets(clusters: CalEvent[][], tickets: TicketCopies, timeZone?: string): AttachedClusters {
  if (!tickets.live.length && !tickets.released.length) return { clusters, released: new Set() };
  const index = dayIndex(clusters);
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

  // each ticket's best calendar cluster; a cluster keeps its best-matching ticket only
  const winner = new Map<number, { t: CalEvent; score: number }>();
  const alone: CalEvent[] = [];
  for (const t of tickets.live) {
    const best = bestCluster(t, clusters, index, timeZone);
    if (!best) {
      alone.push(t);
      continue;
    }
    const cur = winner.get(best.k);
    if (!cur) winner.set(best.k, { t, score: best.score });
    else if (best.score > cur.score || (best.score === cur.score && (t.startsAt - cur.t.startsAt || cmp(t.id, cur.t.id)) < 0)) {
      alone.push(cur.t);
      winner.set(best.k, { t, score: best.score });
    } else alone.push(t);
  }
  const out = clusters.map((c, k) => (winner.has(k) ? [...c, winner.get(k)!.t] : c));
  alone.sort((a, b) => a.startsAt - b.startsAt || cmp(a.id, b.id));
  for (const t of alone) out.push([t]);
  claimPartifulIds(out);

  const released = new Set<CalEvent[]>();
  for (const t of tickets.released) {
    const best = bestCluster(t, clusters, index, timeZone);
    if (!best) continue;
    const cluster = out[best.k]!;
    // a Partiful link is another source: someone invited him, so it is not just Gmail's copy of the ticket
    if (cluster.every((e) => e.source === 'calendar' && e.fromGmail && !e.partifulIds.length)) released.add(cluster);
  }
  return { clusters: out, released };
}

// ------------------------------------------------------------------------------------------------ lookups

/** Follows ticket_events.merged_into_id to the surviving row. */
export function survivingTicket(db: DB, id: string): string {
  const next = db.prepare('SELECT merged_into_id FROM ticket_events WHERE id = ?').pluck();
  const seen = new Set<string>([id]);
  let cur = id;
  for (;;) {
    const m = next.get(cur) as string | null | undefined;
    if (!m || seen.has(m)) return cur;
    seen.add(m);
    cur = m;
  }
}

/** The ticket events behind an occasion's 'ticket' sources, resolved to their surviving rows (id order). */
export function occasionTickets(db: DB, occasionId: string): { id: string; status: string }[] {
  const refs = db.prepare(`SELECT source_ref FROM occasion_sources WHERE occasion_id = ? AND source = 'ticket' ORDER BY source_ref`).pluck().all(occasionId) as string[];
  if (!refs.length) return [];
  const status = db.prepare('SELECT status FROM ticket_events WHERE id = ?').pluck();
  const out = new Map<string, string>();
  for (const ref of refs) {
    const id = survivingTicket(db, ref);
    const s = status.get(id) as string | undefined;
    if (s) out.set(id, s);
  }
  return [...out].map(([id, s]) => ({ id, status: s })).sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** The occasion has a ticket source the owner still holds (its classification then stays social). */
export const hasLiveTicket = (db: DB, occasionId: string): boolean => occasionTickets(db, occasionId).some((t) => t.status === 'holding');

/** The active occasion a ticket event feeds (through ledger merges and occasion merges), or null. */
export function occasionOfTicket(db: DB, ticketId: string): string | null {
  const survivor = survivingTicket(db, ticketId);
  const ids = [survivor];
  const children = db.prepare('SELECT id FROM ticket_events WHERE merged_into_id = ?').pluck();
  for (let i = 0; i < ids.length && ids.length < 1000; i++) ids.push(...(children.all(ids[i]) as string[]));
  const occ = db
    .prepare(`SELECT occasion_id FROM occasion_sources WHERE source = 'ticket' AND source_ref IN (SELECT value FROM json_each(?)) ORDER BY source_ref = ? DESC LIMIT 1`)
    .pluck()
    .get(JSON.stringify(ids), survivor) as string | undefined;
  if (!occ) return null;
  const id = survivingOccasion(db, occ);
  const live = db.prepare(`SELECT 1 FROM occasions WHERE id = ? AND status = 'active'`).get(id);
  return live ? id : null;
}
