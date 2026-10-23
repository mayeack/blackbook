/**
 * The ticket ledger (design docs/design/tickets-met-at.md "Web and API"; DTOs in @yb/shared api/tickets.ts):
 *
 *   GET /tickets?when=upcoming|past&cursor=&limit=   → TicketList
 *
 * One item per live ticket_events row (a merged-away row is never listed), whatever its status (the web shows a
 * pill), except a ticket feeding a sensitive get-together, which is not served at all (as routes/events.ts treats the
 * get-together): upcoming soonest first, past most recent first, keyset-paged on (starts_at, id). "Upcoming" means not over
 * yet (ends_at, else starts_at, ≥ now). Each item names the live get-together the ticket feeds (occasion_sources
 * 'ticket' for the ticket's merge chain → the surviving occasion, active and not sensitive) and the people the owner
 * met there: active person_met_at links on that occasion's chain, its Partiful event, or a Partiful event the ticket
 * mail linked (ticket_events.partiful_ids). People come through person_canon → person_visible (never hidden,
 * merged-away or roster-only) minus the owner's own records (identity/self.ts), sorted by last name A–Z.
 *
 * Read-only. Titles, venues and performers pass through maskText, and titles and performers also have hidden people's
 * names blanked (hiddenNameRedactor, the same rule as /events and /e/:id); transfer counterparties (ticket_parties)
 * and subjects never leave this module.
 */
import { Router } from 'express';
import { z } from 'zod';
import { TicketsQuery, type PersonChip, type TicketCategory, type TicketItem, type TicketList, type TicketStatus } from '@yb/shared';
import type { DB } from '../db/connection';
import { badRequest } from '../http/errors';
import { selfPeople } from '../identity/self';
import { occasionChain, survivingOccasion } from '../pipeline/occasions/build';
import type { RouteDeps } from './index';
import { compareByName, hiddenNameRedactor, maskText } from './people';

/** "Met here" chips per ticket; metHereCount has the full number. */
export const MET_HERE_MAX = 12;

const CursorValue = z.string().regex(/^-?\d{1,15}:[A-Za-z0-9_-]{1,64}$/);

interface TicketRow {
  id: string;
  title: string;
  performers: string;
  genres: string;
  category: TicketCategory;
  venue: string | null;
  city: string | null;
  starts_at: number;
  ends_at: number | null;
  local_date: string;
  vendors: string;
  partiful_ids: string;
  qty_bought: number;
  qty_received: number;
  qty_sent: number;
  qty_sold: number;
  qty_refunded: number;
  held: number | null;
  status: TicketStatus;
}

function strings(raw: string, max = 20): string[] {
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').slice(0, max) : [];
  } catch {
    return [];
  }
}

/** The surviving occasions a ticket (or a row merged into it) feeds, primary source first. */
function ticketOccasionIds(db: DB, ticketId: string): string[] {
  const refs = db
    .prepare(
      `WITH RECURSIVE chain(id) AS (
         SELECT @id UNION SELECT t.id FROM ticket_events t JOIN chain c ON t.merged_into_id = c.id
       )
       SELECT occasion_id FROM occasion_sources WHERE source = 'ticket' AND source_ref IN (SELECT id FROM chain)
       ORDER BY CASE role WHEN 'primary' THEN 0 ELSE 1 END, occasion_id`,
    )
    .pluck()
    .all({ id: ticketId }) as string[];
  return [...new Set(refs.map((ref) => survivingOccasion(db, ref)))];
}

/** The surviving, active, non-sensitive occasion a ticket (or a row merged into it) feeds, or null. */
export function ticketOccasion(db: DB, ticketId: string): { id: string; eventId: string | null } | null {
  const live = db.prepare(`SELECT id, event_id FROM occasions WHERE id = ? AND status = 'active' AND sensitive = 0`);
  for (const id of ticketOccasionIds(db, ticketId)) {
    const row = live.get(id) as { id: string; event_id: string | null } | undefined;
    if (row) return { id: row.id, eventId: row.event_id };
  }
  return null;
}

/** A ticket feeding a sensitive get-together (any status) is not served at all, like the get-together (routes/events.ts). */
export function ticketSensitive(db: DB, ticketId: string): boolean {
  const sensitive = db.prepare('SELECT sensitive FROM occasions WHERE id = ?').pluck();
  return ticketOccasionIds(db, ticketId).some((id) => sensitive.get(id) === 1);
}

/**
 * person_met_at target keys that mean "this ticket's happening": every occasion on the merge chain (o:) and their
 * Partiful events (e:), plus the Partiful events the ticket mail linked and the occasions built on those.
 */
function targetKeys(db: DB, occasion: { id: string } | null, partifulIds: string[]): string[] {
  const keys = new Set<string>();
  const eventOf = db.prepare('SELECT event_id FROM occasions WHERE id = ?').pluck();
  const addOccasion = (id: string) => {
    for (const o of occasionChain(db, survivingOccasion(db, id))) {
      keys.add(`o:${o}`);
      const ev = eventOf.get(o) as string | null | undefined;
      if (ev) keys.add(`e:${ev}`);
    }
  };
  if (occasion) addOccasion(occasion.id);
  if (partifulIds.length) {
    const events = db
      .prepare(`SELECT id FROM events WHERE source = 'partiful' AND source_event_id IN (SELECT value FROM json_each(?))`)
      .pluck()
      .all(JSON.stringify(partifulIds)) as string[];
    for (const id of events) {
      keys.add(`e:${id}`);
      for (const o of db.prepare('SELECT id FROM occasions WHERE event_id = ? AND sensitive = 0').pluck().all(id) as string[]) addOccasion(o);
    }
  }
  return [...keys];
}

interface MetRow {
  id: string;
  display_name: string;
  first_name: string | null;
  last_name: string | null;
  state: PersonChip['state'];
}

/**
 * Visible canonical people with an active met-at link to any of `keys`, last name A–Z. Never the owner: a record that
 * holds one of his handles (identity/self.ts) is skipped even when it is visible.
 */
export function metHerePeople(db: DB, keys: readonly string[], self: ReadonlySet<string> = selfPeople(db)): PersonChip[] {
  if (!keys.length) return [];
  const rows = (
    db
      .prepare(
        `SELECT DISTINCT pv.id, pv.display_name, pv.first_name, pv.last_name, s.state
         FROM person_met_at m
         JOIN person_canon pc ON pc.person_id = m.person_id
         JOIN person_visible pv ON pv.id = pc.canonical_id
         LEFT JOIN person_stats s ON s.person_id = pv.id
         WHERE m.status = 'active' AND m.target_key IN (SELECT value FROM json_each(?))`,
      )
      .all(JSON.stringify(keys)) as MetRow[]
  ).filter((r) => !self.has(r.id));
  const key = (r: MetRow) => {
    const last = r.last_name?.trim() ?? '';
    const first = r.first_name?.trim() ?? '';
    return { id: r.id, last, first: first || (last ? '' : r.display_name.trim()), display: r.display_name.trim(), lastAt: null, createdAt: 0 };
  };
  return rows
    .sort((a, b) => compareByName(key(a), key(b)))
    .map((r) => ({ id: r.id, displayName: maskText(r.display_name), firstName: r.first_name === null ? null : maskText(r.first_name), state: r.state ?? null }));
}

type Redact = ReturnType<typeof hiddenNameRedactor>;

function toItem(db: DB, r: TicketRow, self: ReadonlySet<string>, redact: Redact): TicketItem {
  const occasion = ticketOccasion(db, r.id);
  const met = metHerePeople(db, targetKeys(db, occasion, strings(r.partiful_ids)), self);
  return {
    id: r.id,
    title: redact(r.title) ?? '',
    performers: strings(r.performers).map((p) => redact(p) ?? ''),
    category: r.category,
    genres: strings(r.genres, 3),
    venue: r.venue && maskText(r.venue),
    city: r.city && maskText(r.city),
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    localDate: r.local_date,
    status: r.status,
    held: r.held,
    quantities: { bought: r.qty_bought, received: r.qty_received, sent: r.qty_sent, sold: r.qty_sold, refunded: r.qty_refunded },
    vendors: strings(r.vendors),
    occasionId: occasion?.id ?? null,
    metHere: met.slice(0, MET_HERE_MAX),
    metHereCount: met.length,
  };
}

export function listTickets(db: DB, q: TicketsQuery, now = Date.now()): TicketList {
  let cursorAt: number | null = null;
  let cursorId: string | null = null;
  if (q.cursor) {
    const c = CursorValue.safeParse(q.cursor);
    if (!c.success) throw badRequest('Invalid cursor.');
    const i = c.data.indexOf(':');
    cursorAt = Number(c.data.slice(0, i));
    cursorId = c.data.slice(i + 1);
  }
  const rows = db
    .prepare(
      `SELECT id, title, performers, genres, category, venue, city, starts_at, ends_at, local_date, vendors, partiful_ids,
              qty_bought, qty_received, qty_sent, qty_sold, qty_refunded, held, status
       FROM ticket_events
       WHERE merged_into_id IS NULL
         AND (CASE WHEN @upcoming = 1 THEN coalesce(ends_at, starts_at) >= @now ELSE coalesce(ends_at, starts_at) < @now END)
         AND (@cursorAt IS NULL OR (CASE WHEN @upcoming = 1
               THEN (starts_at > @cursorAt OR (starts_at = @cursorAt AND id > @cursorId))
               ELSE (starts_at < @cursorAt OR (starts_at = @cursorAt AND id < @cursorId)) END))
       ORDER BY CASE WHEN @upcoming = 1 THEN starts_at END ASC, CASE WHEN @upcoming = 1 THEN id END ASC,
                CASE WHEN @upcoming = 0 THEN starts_at END DESC, CASE WHEN @upcoming = 0 THEN id END DESC
       LIMIT @limit`,
    )
    .all({ upcoming: q.when === 'upcoming' ? 1 : 0, now, cursorAt, cursorId, limit: q.limit + 1 }) as TicketRow[];
  const page = rows.slice(0, q.limit);
  // The cursor follows the rows read, so a page whose rows were all withheld (sensitive) still moves on.
  const last = page[page.length - 1];
  const shown = page.filter((r) => !ticketSensitive(db, r.id));
  const self = shown.length ? selfPeople(db) : new Set<string>();
  const redact = hiddenNameRedactor(db);
  return {
    items: shown.map((r) => toItem(db, r, self, redact)),
    nextCursor: rows.length > q.limit && last ? `${last.starts_at}:${last.id}` : null,
  };
}

export function ticketsRoutes({ db }: RouteDeps): Router {
  const r = Router();
  r.get('/tickets', (req, res) => {
    const q = TicketsQuery.parse(req.query);
    res.json(listTickets(db, q) satisfies TicketList);
  });
  return r;
}
