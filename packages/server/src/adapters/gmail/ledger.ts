/**
 * The ticket ledger (design §1 "Apply" and the review amendments "Ledger quantities and dates"): parsed ticket
 * emails → ticket_events, one row per real event. Class D: plain writes (never journaled), re-derived from ALL of
 * the event's parsed messages whenever one joins or changes, so applying the same answer twice changes nothing.
 *
 * Joining (placeMessage), strongest first:
 *   - the same vendorEventId, or the same order reference, when the dates are compatible (the spans overlap: two
 *     single-day orders for different days of one festival stay two rows; an event_changed names the new date, so
 *     its key alone decides; a mail from before the event's change notice names the old date, so it joins too —
 *     results apply in any order, and the backfill parses newest first);
 *   - else the same venue-local date (within the event's span) AND (title-token Jaccard ≥ 0.5, a shared performer,
 *     or the same venue_key with starts ±3 h — only when both zones are known, never on a guessed zone);
 *   - a message without a date joins by order ref / vendor id, else by title or performer to the nearest event
 *     within [email − 180 d, email + 18 mo]; otherwise it waits unattached (an orphan) until one appears. A change
 *     notice without a key moves the nearest earlier-mailed event with its title or performer; placed before that
 *     event's own mails, it is found by them instead (a dated mail that matches nothing on its date joins the same
 *     show's event a later change notice moved, when the event's pre-change mails name the same date or none).
 *   A message whose strong key points at one row and whose date / title at another makes them one: the younger
 *   rows are pointer-merged into the oldest (merged_into_id; messages and parties move to the survivor).
 *
 * Derivation (deriveEvent):
 *   - dates: event_changed moves the start — only messages from the newest event_changed on count; the event spans
 *     [min start, max end] of those that name the venue's zone (of all of them, tz NULL = guessed, when none does;
 *     a guessed instant never carries a known zone's name); ends default by category (dates.ts);
 *   - title / performers / genres (≤ 3) / category / venue / city: the order and registration mails first;
 *   - quantities by flow class (computeLedger): acquisitions (order, registration) keyed `orderRef ?? message id`
 *     taking the max per key; outflows (transfer_out, resale_sold, refund) once per message; transfer_in once per
 *     incoming transfer — mails in one thread or from one counterparty (the resolved person, else the address,
 *     else the first name) are one, the max (an offer and the owner's own "you're all set" read as transfer_in
 *     count once);
 *     transfer_back subtracts from sent; transfer_accepted and resale_listed never count. Pairing: a
 *     resale_sold followed within 14 d by transfer_out(s) of ≤ its quantity to someone who isn't a known person is
 *     one outflow; a secondary-market order followed within 14 d by transfer_in(s) of ≤ its quantity is one inflow
 *     (a sale or order of unknown size takes the first such transfer and its quantity); an order forwarded by a
 *     non-vendor sender is a transfer_in of 1. Quantities come from the deterministic refs
 *     (JSON-LD seats, passes, seat lines), then the counterparty line, then the model. A null quantity is unknown:
 *     an order or transfer_in counts 1 (and marks the inflow unknown), a transfer_out or resale_sold ≥ 1, a refund
 *     the whole orderRef (all of it without one);
 *   - status: cancelled (an event_cancelled with no later event_changed / delivery / reminder) > refunded
 *     (refunded ≥ bought + received > 0) > sold (sold > 0, held ≤ 0) > gave_away (sent > 0, held ≤ 0) > holding
 *     (bought + received > 0, or a delivery / wallet pass, which implies an acquisition) > unconfirmed. When the
 *     outflows reach an inflow that had an unknown quantity, it stays holding with held NULL.
 * ticket_parties get their event and person here: a canonical, non-hidden person (never the owner) by the
 * Gmail-folded email key, else by a full name that only one person in the book has.
 */
import { emailMatchKey, localDate, normalizeNamePart, uuidv7 } from '@yb/shared';
import type { DB } from '../../db/connection';
import { fullNameKey } from '../../identity/partifulLink';
import { venueKey as occasionVenueKey } from '../../pipeline/occasions/text';
import type { TicketRefs } from './clean';
import type { ParsedTicket } from './parse';
import type { TicketKind } from './prompt';
import { isSecondaryVendor } from './vendors';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const LEDGER = {
  /** Title-token Jaccard for "same event" on one local date. */
  titleJaccard: 0.5,
  /** Same venue, starts this close (known zones only). */
  sameVenueMs: 3 * HOUR,
  /** Resale → transfer and secondary order → transfer pairing window. */
  pairMs: 14 * DAY,
  /** A dateless message looks for its event within [email − before, email + after]. */
  datelessBeforeMs: 180 * DAY,
  datelessAfterMs: 548 * DAY,
} as const;

const ACQUISITIONS: ReadonlySet<TicketKind> = new Set(['order', 'registration']);
const NOT_EVENTS: ReadonlySet<TicketKind> = new Set(['marketing', 'not_ticket']);
export const isEventKind = (k: TicketKind): boolean => !NOT_EVENTS.has(k);
/** Kinds whose title / venue describe the event best. */
const KIND_RANK: Readonly<Partial<Record<TicketKind, number>>> = { order: 0, registration: 0, delivery: 1, transfer_in: 2, reminder: 3, event_changed: 3 };
const rankOf = (k: TicketKind) => KIND_RANK[k] ?? 5;

export type TicketStatus = 'holding' | 'unconfirmed' | 'gave_away' | 'sold' | 'refunded' | 'cancelled';

// ---------------------------------------------------------------------------------------------- text keys

const STOP = new Set(['the', 'a', 'an', 'and', 'with', 'at', 'live', 'tour', 'tickets', 'ticket', 'presents', 'in', 'of', 'feat', 'ft', 'featuring', 'w', 'vs', 'v', 'tix', 'show', 'night', 'event', 'on', 'for', 'to']);

/** Normalized title tokens (letters/digits, stop words dropped). */
export function titleTokens(s: string | null | undefined): string[] {
  return [...new Set(normalizeNamePart(s ?? '').split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2 && !STOP.has(t)))];
}
export const titleKey = (s: string | null | undefined): string => titleTokens(s).join(' ');

export function jaccard(a: readonly string[], b: readonly string[]): number {
  if (!a.length || !b.length) return 0;
  const sb = new Set(b);
  const inter = a.filter((x) => sb.has(x)).length;
  return inter / (new Set([...a, ...b]).size || 1);
}

/** Comparison form of a venue name, the occasions' own (pipeline/occasions/text.ts), so keys compare across modules. */
export const venueKey = (s: string | null | undefined): string | null => occasionVenueKey(s) || null;

const performerKey = (s: string) => normalizeNamePart(s).replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/^the /, '');
const sharesPerformer = (a: readonly string[], b: readonly string[]) => {
  const sb = new Set(b.map(performerKey).filter(Boolean));
  return a.some((p) => sb.has(performerKey(p)));
};

// ---------------------------------------------------------------------------------------------- rows

interface MsgRow {
  gmail_id: string;
  thread_id: string;
  internal_at: number;
  vendor: string | null;
  from_domain: string | null;
  refs: string;
  parsed: string;
  ticket_event_id: string | null;
}

export interface LedgerMsg {
  gmailId: string;
  threadId: string;
  internalAt: number;
  vendor: string | null;
  refs: TicketRefs;
  p: ParsedTicket;
  eventId: string | null;
}

interface EventRow {
  id: string;
  title: string;
  title_key: string;
  performers: string;
  venue_key: string | null;
  starts_at: number;
  ends_at: number | null;
  tz: string | null;
  local_date: string;
  vendor_event_ids: string;
  created_at: number;
}

const parseJson = <T>(s: string | null | undefined, fallback: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};

const toMsg = (r: MsgRow): LedgerMsg => ({
  gmailId: r.gmail_id,
  threadId: r.thread_id,
  internalAt: r.internal_at,
  vendor: r.vendor,
  refs: parseJson<TicketRefs>(r.refs, {}),
  p: parseJson<ParsedTicket>(r.parsed, null as unknown as ParsedTicket),
  eventId: r.ticket_event_id,
});

function loadMsg(db: DB, gmailId: string): LedgerMsg | null {
  const r = db
    .prepare(`SELECT gmail_id, thread_id, internal_at, vendor, from_domain, refs, parsed, ticket_event_id FROM gmail_messages WHERE gmail_id = ? AND parse_status = 'parsed'`)
    .get(gmailId) as MsgRow | undefined;
  return r && r.parsed ? toMsg(r) : null;
}

function eventMsgs(db: DB, eventId: string): LedgerMsg[] {
  return (
    db
      .prepare(
        `SELECT gmail_id, thread_id, internal_at, vendor, from_domain, refs, parsed, ticket_event_id FROM gmail_messages
         WHERE ticket_event_id = ? AND parse_status = 'parsed' AND parsed IS NOT NULL ORDER BY internal_at, gmail_id`,
      )
      .all(eventId) as MsgRow[]
  ).map(toMsg);
}

/** Follows merge pointers to the live row. */
export function survivingTicketEvent(db: DB, id: string): string {
  const next = db.prepare('SELECT merged_into_id FROM ticket_events WHERE id = ?').pluck();
  let cur = id;
  for (let i = 0; i < 32; i++) {
    const m = next.get(cur) as string | null | undefined;
    if (!m) return cur;
    cur = m;
  }
  return cur;
}

const getEvent = (db: DB, id: string) =>
  db
    .prepare(`SELECT id, title, title_key, performers, venue_key, starts_at, ends_at, tz, local_date, vendor_event_ids, created_at FROM ticket_events WHERE id = ?`)
    .get(id) as EventRow | undefined;

/** The local date range an event covers ([start date, end date] in its zone, or the owner's). */
function spanOf(e: Pick<EventRow, 'starts_at' | 'ends_at' | 'tz' | 'local_date'>, ownerTz: string): [string, string] {
  const end = e.ends_at && e.ends_at > e.starts_at ? localDate(e.ends_at - 1, e.tz ?? ownerTz) : e.local_date;
  return [e.local_date, end < e.local_date ? e.local_date : end];
}

function msgSpan(m: LedgerMsg, ownerTz: string): [string, string] | null {
  if (m.p.starts_at === null || !m.p.local_date) return null;
  const end = m.p.ends_at && m.p.ends_at > m.p.starts_at ? localDate(m.p.ends_at - 1, m.p.tz ?? ownerTz) : m.p.local_date;
  return [m.p.local_date, end < m.p.local_date ? m.p.local_date : end];
}

const overlaps = (a: [string, string], b: [string, string]) => a[0] <= b[1] && b[0] <= a[1];

function datesCompatible(e: EventRow, m: LedgerMsg, ownerTz: string): boolean {
  const ms = msgSpan(m, ownerTz);
  return !ms || overlaps(spanOf(e, ownerTz), ms);
}

/** The event holds a dated change notice mailed after `at` (so a mail from before it names the old date). */
function changedAfter(db: DB, eventId: string, at: number): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM gmail_messages WHERE ticket_event_id = ? AND parse_status = 'parsed' AND internal_at > ?
         AND json_extract(parsed, '$.kind') = 'event_changed' AND json_extract(parsed, '$.starts_at') IS NOT NULL LIMIT 1`,
    )
    .get(eventId, at);
}

/**
 * A strong-key match is the same event when the dates allow it: a change notice names the new date (its key alone
 * decides); a mail from before the event's change notice names the old one (results apply in any order — the backfill
 * parses newest first — so the order may land after its event moved).
 */
const strongCompatible = (db: DB, e: EventRow, m: LedgerMsg, ownerTz: string): boolean =>
  m.p.kind === 'event_changed' || datesCompatible(e, m, ownerTz) || changedAfter(db, e.id, m.internalAt);

// ---------------------------------------------------------------------------------------------- placing a message

/** Where a message belongs, and other rows it proves are the same event. */
function findEvent(db: DB, m: LedgerMsg, ownerTz: string): { target: string | null; mergeIn: string[] } {
  const live = (ids: string[]) => [...new Set(ids.map((id) => survivingTicketEvent(db, id)))];
  const strong: string[] = [];
  if (m.refs.vendorEventId) {
    strong.push(
      ...(db
        .prepare(`SELECT te.id FROM ticket_events te, json_each(te.vendor_event_ids) j WHERE te.merged_into_id IS NULL AND j.value = ? ORDER BY te.created_at, te.id`)
        .pluck()
        .all(m.refs.vendorEventId) as string[]),
    );
  }
  if (m.refs.orderRef) {
    strong.push(
      ...(db
        .prepare(
          `SELECT DISTINCT ticket_event_id FROM gmail_messages
           WHERE ticket_event_id IS NOT NULL AND gmail_id <> ? AND parse_status = 'parsed' AND json_extract(refs, '$.orderRef') = ?`,
        )
        .pluck()
        .all(m.gmailId, m.refs.orderRef) as string[]),
    );
  }
  const strongRows = live(strong)
    .map((id) => getEvent(db, id)!)
    .filter((e) => e && strongCompatible(db, e, m, ownerTz))
    .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));

  // Date + title / performer / venue on the same local date.
  const dated: { id: string; score: number; created: number }[] = [];
  const span = msgSpan(m, ownerTz);
  if (span) {
    const rows = db
      .prepare(
        `SELECT id, title, title_key, performers, venue_key, starts_at, ends_at, tz, local_date, vendor_event_ids, created_at FROM ticket_events
         WHERE merged_into_id IS NULL AND local_date BETWEEN date(?, '-21 days') AND ? ORDER BY created_at, id`,
      )
      .all(span[0], span[1]) as EventRow[];
    const tokens = titleTokens(m.p.title);
    const vkey = venueKey(m.p.venue);
    for (const e of rows) {
      if (!overlaps(spanOf(e, ownerTz), span)) continue;
      const j = jaccard(tokens, e.title_key.split(' ').filter(Boolean));
      const perf = sharesPerformer(m.p.performers, parseJson<string[]>(e.performers, []));
      const venue = !!vkey && vkey === e.venue_key && !!e.tz && !!m.p.tz && m.p.starts_at !== null && Math.abs(e.starts_at - m.p.starts_at) <= LEDGER.sameVenueMs;
      if (j >= LEDGER.titleJaccard || perf || venue) dated.push({ id: e.id, score: (perf ? 2 : 0) + (venue ? 1.5 : 0) + j, created: e.created_at });
    }
    dated.sort((a, b) => b.score - a.score);
  }

  const changed = m.p.kind === 'event_changed';
  if (strongRows.length) {
    // A change notice's date matches are other events on the new date, never this one. Everything else the message
    // ties together is one event: the oldest row survives (its id is what occasions already point at).
    const all = [...strongRows.map((e) => ({ id: e.id, created: e.created_at })), ...(changed ? [] : dated)];
    const ids = [...new Map(all.sort((a, b) => a.created - b.created || a.id.localeCompare(b.id)).map((x) => [x.id, x])).keys()];
    return { target: ids[0]!, mergeIn: ids.slice(1) };
  }
  if (dated.length) return { target: dated[0]!.id, mergeIn: [] };
  // A change notice without a key moves the nearest event with its title / performer that existed before it.
  if (changed) return { target: nearestByTitle(db, m, m.p.starts_at ?? m.internalAt, true), mergeIn: [] };
  if (span) return { target: preChangeEvent(db, m, ownerTz), mergeIn: [] };
  // No date: the nearest event by title or performer.
  return { target: nearestByTitle(db, m, m.internalAt, false), mergeIn: [] };
}

/** Title tokens (≥ the Jaccard bar) or a performer in common. */
const sameShow = (m: LedgerMsg, e: Pick<EventRow, 'title_key' | 'performers'>): boolean =>
  jaccard(titleTokens(m.p.title), e.title_key.split(' ').filter(Boolean)) >= LEDGER.titleJaccard || sharesPerformer(m.p.performers, parseJson<string[]>(e.performers, []));

/**
 * A dated mail that matches nothing on its own date: the event a later change notice (placed first) moved away
 * from that date, when it is the same show and the mails the event already holds from before the change name the
 * same old date (or there are none yet).
 */
function preChangeEvent(db: DB, m: LedgerMsg, ownerTz: string): string | null {
  const span = msgSpan(m, ownerTz);
  if (!span) return null;
  const rows = db
    .prepare(
      `SELECT g.ticket_event_id AS id, min(g.internal_at) AS changed_at FROM gmail_messages g JOIN ticket_events te ON te.id = g.ticket_event_id
       WHERE te.merged_into_id IS NULL AND g.parse_status = 'parsed' AND g.internal_at > ? AND g.internal_at <= ?
         AND json_extract(g.parsed, '$.kind') = 'event_changed' AND json_extract(g.parsed, '$.starts_at') IS NOT NULL
       GROUP BY g.ticket_event_id ORDER BY changed_at, g.ticket_event_id`,
    )
    .all(m.internalAt, m.internalAt + LEDGER.datelessAfterMs) as { id: string; changed_at: number }[];
  for (const r of rows) {
    const e = getEvent(db, r.id);
    if (!e || !sameShow(m, e)) continue;
    const before = eventMsgs(db, e.id)
      .filter((x) => x.internalAt < r.changed_at)
      .map((x) => msgSpan(x, ownerTz))
      .filter((s): s is [string, string] => !!s);
    if (!before.length || before.some((s) => overlaps(s, span))) return e.id;
  }
  return null;
}

/** The live event nearest to `around` within the dateless window that shares the message's title or a performer. */
function nearestByTitle(db: DB, m: LedgerMsg, around: number, existedBefore: boolean): string | null {
  const tokens = titleTokens(m.p.title);
  if (!tokens.length && !m.p.performers.length) return null;
  const near = db
    .prepare(
      `SELECT id, title, title_key, performers, venue_key, starts_at, ends_at, tz, local_date, vendor_event_ids, created_at FROM ticket_events
       WHERE merged_into_id IS NULL AND starts_at BETWEEN ? AND ? AND (? = 0 OR first_email_at <= ?)`,
    )
    .all(m.internalAt - LEDGER.datelessBeforeMs, m.internalAt + LEDGER.datelessAfterMs, existedBefore ? 1 : 0, m.internalAt) as EventRow[];
  const fits = near.filter((e) => sameShow(m, e)).sort((a, b) => Math.abs(a.starts_at - around) - Math.abs(b.starts_at - around) || a.created_at - b.created_at);
  return fits[0]?.id ?? null;
}

/** Pointer-merges `mergedId` into `survivorId`: messages, parties and earlier merges move to the survivor. */
export function mergeTicketEvents(db: DB, survivorId: string, mergedId: string, now: number): void {
  if (survivorId === mergedId) return;
  db.prepare('UPDATE ticket_events SET merged_into_id = ?, updated_at = ? WHERE id = ? OR merged_into_id = ?').run(survivorId, now, mergedId, mergedId);
  db.prepare('UPDATE gmail_messages SET ticket_event_id = ?, updated_at = ? WHERE ticket_event_id = ?').run(survivorId, now, mergedId);
  db.prepare('UPDATE ticket_parties SET ticket_event_id = ?, updated_at = ? WHERE ticket_event_id = ?').run(survivorId, now, mergedId);
}

export interface PlaceResult {
  eventId: string | null;
  created: boolean;
  merged: number;
  orphans: number;
}

/**
 * Puts one parsed message on its ticket event (creating or merging rows as needed) and re-derives the event. A
 * message already placed stays where it is (re-applying an answer is a no-op). Call inside a transaction.
 */
export function placeMessage(db: DB, gmailId: string, o: { now: number; ownerTz: string }): PlaceResult {
  const m = loadMsg(db, gmailId);
  const out: PlaceResult = { eventId: null, created: false, merged: 0, orphans: 0 };
  if (!m || !isEventKind(m.p.kind)) return out;
  let target: string | null = m.eventId ? survivingTicketEvent(db, m.eventId) : null;
  let mergeIn: string[] = [];
  if (!target) ({ target, mergeIn } = findEvent(db, m, o.ownerTz));
  if (!target) {
    if (m.p.starts_at === null || !m.p.local_date) return out; // an orphan, until its event shows up
    target = uuidv7(o.now);
    db.prepare(
      `INSERT INTO ticket_events (id, title, title_key, starts_at, ends_at, tz, local_date, status, first_email_at, last_email_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'unconfirmed', ?, ?, ?, ?)`,
    ).run(target, eventTitle([m]), titleKey(eventTitle([m])), m.p.starts_at, m.p.ends_at, m.p.tz, m.p.local_date, m.internalAt, m.internalAt, o.now, o.now);
    out.created = true;
  }
  for (const id of mergeIn) {
    mergeTicketEvents(db, target, id, o.now);
    out.merged++;
  }
  db.prepare('UPDATE gmail_messages SET ticket_event_id = ?, updated_at = ? WHERE gmail_id = ?').run(target, o.now, gmailId);
  deriveEvent(db, target, o);
  out.orphans = adoptOrphans(db, target, o);
  if (out.orphans) deriveEvent(db, target, o);
  out.eventId = target;
  return out;
}

/** Unplaced parsed messages that share an order ref or vendor event id with the event (or its title, when dateless). */
function adoptOrphans(db: DB, eventId: string, o: { now: number; ownerTz: string }): number {
  const orphans = (
    db
      .prepare(
        `SELECT gmail_id, thread_id, internal_at, vendor, from_domain, refs, parsed, ticket_event_id FROM gmail_messages
         WHERE parse_status = 'parsed' AND parsed IS NOT NULL AND ticket_event_id IS NULL`,
      )
      .all() as MsgRow[]
  )
    .map(toMsg)
    .filter((m) => m.p && isEventKind(m.p.kind));
  if (!orphans.length) return 0;
  const own = eventMsgs(db, eventId);
  const orderRefs = new Set(own.map((m) => m.refs.orderRef).filter(Boolean));
  const vendorIds = new Set(own.map((m) => m.refs.vendorEventId).filter(Boolean));
  const e = getEvent(db, eventId)!;
  const set = db.prepare('UPDATE gmail_messages SET ticket_event_id = ?, updated_at = ? WHERE gmail_id = ?');
  let n = 0;
  for (const m of orphans) {
    const byRef = (m.refs.orderRef && orderRefs.has(m.refs.orderRef)) || (m.refs.vendorEventId && vendorIds.has(m.refs.vendorEventId));
    const byTitle = m.p.starts_at === null && e.starts_at >= m.internalAt - LEDGER.datelessBeforeMs && e.starts_at <= m.internalAt + LEDGER.datelessAfterMs && sameShow(m, e);
    if (!byRef && !byTitle) continue;
    if (byRef && m.p.kind !== 'event_changed' && !datesCompatible(e, m, o.ownerTz)) continue;
    set.run(eventId, o.now, m.gmailId);
    n++;
  }
  return n;
}

/** Takes a message off its event (it was re-read as not a ticket) and re-derives what it left. */
export function unplaceMessage(db: DB, gmailId: string, o: { now: number; ownerTz: string }): void {
  const prev = db.prepare('SELECT ticket_event_id FROM gmail_messages WHERE gmail_id = ?').pluck().get(gmailId) as string | null | undefined;
  db.prepare('UPDATE gmail_messages SET ticket_event_id = NULL, updated_at = ? WHERE gmail_id = ?').run(o.now, gmailId);
  db.prepare('UPDATE ticket_parties SET ticket_event_id = NULL, updated_at = ? WHERE gmail_id = ?').run(o.now, gmailId);
  if (prev) deriveEvent(db, survivingTicketEvent(db, prev), o);
}

// ---------------------------------------------------------------------------------------------- quantities

export interface QtyMsg {
  id: string;
  at: number;
  kind: TicketKind;
  /** refs → counterparty → model; null = unknown. */
  qty: number | null;
  orderRef: string | null;
  vendor: string | null;
  forwarded: boolean;
  pkpass: number;
  /** A sent_to counterparty that resolved to a known person. */
  toKnownPerson: boolean;
  /** The Gmail thread (transfers in one thread are one transfer). */
  thread?: string | null;
  /** The received_from counterparty: resolved person, email key, normalized first name. */
  from?: { person: string | null; email: string | null; first: string | null } | null;
}

export interface LedgerCounts {
  bought: number;
  received: number;
  sent: number;
  sold: number;
  refunded: number;
  /** null = unknown (an inflow quantity was missing and the outflows reached it). */
  held: number | null;
  status: TicketStatus;
}

const pos = (q: number | null) => (q !== null && Number.isFinite(q) && q > 0 ? Math.round(q) : null);

/**
 * Pairs one sale / secondary order with the transfers that carry it out (within 14 d after it, ≤ its quantity in
 * total; null quantities count 1). One of unknown size takes the first eligible transfer and its quantity.
 */
function pair(head: { at: number; qty: number | null }, transfers: readonly QtyMsg[], absorbed: Set<string>, eligible: (t: QtyMsg) => boolean): void {
  let budget = head.qty;
  for (const t of transfers) {
    if (absorbed.has(t.id) || !eligible(t) || t.at < head.at || t.at > head.at + LEDGER.pairMs) continue;
    const q = pos(t.qty);
    if (budget === null) {
      absorbed.add(t.id);
      head.qty = q;
      return;
    }
    if ((q ?? 1) > budget) continue;
    absorbed.add(t.id);
    budget -= q ?? 1;
  }
}

/** Two transfer_in mails about one transfer: one thread, else one counterparty (person, else address, else first name). */
function sameTransfer(a: QtyMsg, b: QtyMsg): boolean {
  if (a.thread && a.thread === b.thread) return true;
  const x = a.from;
  const y = b.from;
  if (!x || !y) return false;
  if (x.person && y.person) return x.person === y.person;
  if (x.email && y.email) return x.email === y.email;
  return !!x.first && x.first === y.first;
}

/**
 * transfer_in mails → incoming transfers (sameTransfer): one per transfer, its first mail with the max quantity (null
 * when none says). The offer, a nudge to accept and the owner's own acceptance are one transfer.
 */
function transferIns(msgs: readonly QtyMsg[]): QtyMsg[] {
  const groups: QtyMsg[][] = [];
  for (const m of msgs) {
    const g = [m];
    // A mail that links two groups merges them.
    for (const h of groups.filter((x) => x.some((y) => sameTransfer(y, m)))) {
      g.unshift(...h);
      groups.splice(groups.indexOf(h), 1);
    }
    groups.push(g);
  }
  return groups
    .map((g) => {
      const sorted = [...g].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
      const qs = sorted.map((m) => pos(m.qty)).filter((q): q is number => q !== null);
      return { ...sorted[0]!, qty: qs.length ? Math.max(...qs) : null };
    })
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

/** The quantity state machine (see the header). Pure. */
export function computeLedger(msgs: readonly QtyMsg[]): LedgerCounts {
  const sorted = [...msgs].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  // An order forwarded by someone who isn't a vendor: they sent the owner a ticket.
  const eff = sorted.map((m) => (m.kind === 'order' && m.forwarded && !m.vendor ? { ...m, kind: 'transfer_in' as const, qty: 1 } : m));
  let unknownIn = false;

  // Acquisitions keyed orderRef ?? message, the max quantity per key.
  const groups = new Map<string, { at: number; qty: number | null; secondary: boolean }>();
  for (const m of eff.filter((x) => ACQUISITIONS.has(x.kind))) {
    const key = m.orderRef ? `ref:${m.orderRef}` : `msg:${m.id}`;
    const g = groups.get(key) ?? { at: m.at, qty: null, secondary: false };
    const q = pos(m.qty);
    if (q !== null) g.qty = Math.max(g.qty ?? 0, q);
    g.secondary ||= isSecondaryVendor(m.vendor);
    g.at = Math.min(g.at, m.at);
    groups.set(key, g);
  }

  // Inflows: once per incoming transfer (transferIns), minus the seller's transfer(s) that deliver a secondary-market
  // order (≤ its quantity; an order of unknown size takes the first transfer's).
  const ins = transferIns(eff.filter((m) => m.kind === 'transfer_in'));
  const absorbedIn = new Set<string>();
  for (const g of [...groups.values()].filter((x) => x.secondary).sort((a, b) => a.at - b.at)) {
    pair(g, ins, absorbedIn, () => true);
  }
  const qtyOf = (g: { qty: number | null }) => {
    if (g.qty === null) unknownIn = true;
    return g.qty ?? 1;
  };
  let bought = 0;
  for (const g of groups.values()) bought += qtyOf(g);
  let received = 0;
  for (const t of ins) {
    if (absorbedIn.has(t.id)) continue;
    const q = pos(t.qty);
    if (q === null) unknownIn = true;
    received += q ?? 1;
  }

  // A delivery or a wallet pass with no acquisition in the mailbox (bought before the backfill) implies one.
  if (bought + received === 0) {
    const proof = eff.filter((m) => m.kind === 'delivery' || m.pkpass > 0);
    if (proof.length) {
      const q = Math.max(0, ...proof.map((m) => pos(m.qty) ?? 0));
      if (!q) unknownIn = true;
      bought = q || 1;
    }
  }

  // Outflows: once per message; a sale's own delivery transfer(s) to a stranger are the same outflow (≤ the sale's
  // quantity; a sale of unknown size takes the first transfer's).
  const outs = eff.filter((m) => m.kind === 'transfer_out');
  const absorbedOut = new Set<string>();
  const sales = eff.filter((m) => m.kind === 'resale_sold').map((m) => ({ at: m.at, qty: pos(m.qty) }));
  for (const s of sales) pair(s, outs, absorbedOut, (t) => !t.toKnownPerson);
  const sold = sales.reduce((n, s) => n + (s.qty ?? 1), 0);
  const sentOut = outs.filter((t) => !absorbedOut.has(t.id)).reduce((n, t) => n + (pos(t.qty) ?? 1), 0);
  const back = eff.filter((m) => m.kind === 'transfer_back').reduce((n, t) => n + (pos(t.qty) ?? 1), 0);
  const sent = Math.max(0, sentOut - back);
  const inflow = bought + received;
  let refunded = 0;
  for (const r of eff.filter((m) => m.kind === 'refund')) {
    const q = pos(r.qty);
    if (q !== null) refunded += q;
    else if (r.orderRef && groups.has(`ref:${r.orderRef}`)) refunded += groups.get(`ref:${r.orderRef}`)!.qty ?? 1;
    else refunded += inflow;
  }

  // An event_cancelled counts unless a later change, delivery or reminder says the event goes on.
  const cancelled = eff.some((c) => c.kind === 'event_cancelled' && !eff.some((x) => x.at > c.at && (x.kind === 'event_changed' || x.kind === 'delivery' || x.kind === 'reminder')));
  const out = sent + sold + refunded;
  let held: number | null = Math.max(0, inflow - out);
  let status: TicketStatus;
  if (cancelled) status = 'cancelled';
  else if (inflow > 0 && refunded >= inflow) status = 'refunded';
  else if (unknownIn && inflow > 0 && out >= inflow) {
    status = 'holding';
    held = null;
  } else if (sold > 0 && inflow - out <= 0) status = 'sold';
  else if (sent > 0 && inflow - out <= 0) status = 'gave_away';
  else if (inflow > 0) status = 'holding';
  else status = 'unconfirmed';
  return { bought, received, sent, sold, refunded, held, status };
}

// ---------------------------------------------------------------------------------------------- parties

interface PartyRow {
  gmail_id: string;
  direction: 'sent_to' | 'received_from';
  name: string | null;
  email_key: string | null;
  quantity: number | null;
  person_id: string | null;
}

/** A resolver over the current book (people, email identities), built once per derivation. */
function partyResolver(db: DB): (p: Pick<PartyRow, 'name' | 'email_key'>) => string | null {
  const meId = db.prepare(`SELECT id FROM people WHERE kind = 'me' AND status IN ('active','provisional') ORDER BY created_at LIMIT 1`).pluck().get() as string | undefined;
  const allowed = db.prepare(
    `SELECT p.id FROM person_canon pc JOIN people p ON p.id = pc.canonical_id
     WHERE pc.person_id = ? AND p.kind = 'person' AND p.merged_into_id IS NULL AND p.is_hidden = 0
       AND p.status IN ('active','provisional','roster_only')`,
  ).pluck();
  const canon = (id: string) => {
    const c = (allowed.get(id) as string | undefined) ?? null;
    return c && c !== meId ? c : null;
  };
  let byEmail: Map<string, Set<string>> | null = null;
  let byName: Map<string, Set<string>> | null = null;
  const emails = () => {
    if (byEmail) return byEmail;
    byEmail = new Map();
    const rows = db.prepare(`SELECT person_id, key FROM identities WHERE kind = 'email' AND status = 'active'`).all() as { person_id: string; key: string }[];
    for (const r of rows) {
      const k = emailMatchKey(r.key);
      if (k) byEmail.set(k, (byEmail.get(k) ?? new Set()).add(r.person_id));
    }
    return byEmail;
  };
  const names = () => {
    if (byName) return byName;
    byName = new Map();
    const rows = db
      .prepare(
        `SELECT id, display_name, first_name, last_name FROM people
         WHERE kind = 'person' AND merged_into_id IS NULL AND status IN ('active','provisional','roster_only')`,
      )
      .all() as { id: string; display_name: string; first_name: string | null; last_name: string | null }[];
    for (const r of rows) {
      const k = fullNameKey(r);
      if (k) byName.set(k, (byName.get(k) ?? new Set()).add(r.id));
    }
    return byName;
  };
  const unique = (ids: Iterable<string> | undefined): string | null => {
    const people = new Set([...(ids ?? [])].map(canon));
    return people.size === 1 ? [...people][0]! : null;
  };
  return (p) => {
    if (p.email_key) {
      const hit = unique(emails().get(p.email_key));
      if (hit) return hit;
    }
    if (p.name) {
      const k = fullNameKey({ display_name: p.name, first_name: null, last_name: null });
      // Hidden people drop out of `canon`, so a name a hidden person shares is never unique by accident: count them.
      const ids = k ? names().get(k) : undefined;
      if (ids && ids.size === 1) return unique(ids);
    }
    return null;
  };
}

// ---------------------------------------------------------------------------------------------- derivation

const maxBy = <T>(xs: readonly T[], f: (x: T) => number): T | undefined => xs.reduce<T | undefined>((best, x) => (best === undefined || f(x) > f(best) ? x : best), undefined);

function eventTitle(msgs: readonly LedgerMsg[]): string {
  const ranked = [...msgs].sort((a, b) => rankOf(a.p.kind) - rankOf(b.p.kind) || a.internalAt - b.internalAt);
  return (ranked.map((m) => m.p.title).find((t): t is string => !!t) ?? ranked.flatMap((m) => m.p.performers)[0] ?? 'Untitled event').slice(0, 200);
}

function modeOf(xs: readonly string[]): string | null {
  const n = new Map<string, number>();
  for (const x of xs) n.set(x, (n.get(x) ?? 0) + 1);
  return maxBy([...n.entries()], ([, c]) => c)?.[0] ?? null;
}

/** Re-derives one ticket event from all of its parsed messages (see the header). Call inside a transaction. */
export function deriveEvent(db: DB, eventId: string, o: { now: number; ownerTz: string }): void {
  const msgs = eventMsgs(db, eventId).filter((m) => m.p && isEventKind(m.p.kind));
  if (!msgs.length) {
    db.prepare(
      `UPDATE ticket_events SET qty_bought = 0, qty_received = 0, qty_sent = 0, qty_sold = 0, qty_refunded = 0, held = 0,
         status = 'unconfirmed', emails = 0, updated_at = ? WHERE id = ?`,
    ).run(o.now, eventId);
    return;
  }
  const ranked = [...msgs].sort((a, b) => rankOf(a.p.kind) - rankOf(b.p.kind) || a.internalAt - b.internalAt);

  // Dates: from the newest event_changed on.
  const change = maxBy(
    msgs.filter((m) => m.p.kind === 'event_changed' && m.p.starts_at !== null),
    (m) => m.internalAt,
  );
  const anyDated = msgs.filter((m) => m.p.starts_at !== null && (!change || m.internalAt >= change.internalAt));
  // A mail without the venue's zone was read in the owner's: its instant is a guess, so it counts only when no mail
  // names the zone (never one zone's wall clock under another's name).
  const zoned = anyDated.filter((m) => m.p.tz);
  const dated = zoned.length ? zoned : anyDated;
  const first = [...dated].sort((a, b) => a.p.starts_at! - b.p.starts_at!)[0];
  const dates = first
    ? {
        starts_at: first.p.starts_at!,
        ends_at: Math.max(...dated.map((m) => m.p.ends_at ?? m.p.starts_at!)),
        tz: first.p.tz ?? null,
        local_date: first.p.local_date!,
      }
    : null;

  const performers: string[] = [];
  for (const m of ranked) for (const p of m.p.performers) if (!performers.some((x) => performerKey(x) === performerKey(p))) performers.push(p);
  const genreCount = new Map<string, number>();
  for (const m of msgs) for (const g of m.p.genres) genreCount.set(g, (genreCount.get(g) ?? 0) + 1);
  const genres = [...genreCount.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([g]) => g);
  const category = modeOf(ranked.map((m) => m.p.category).filter((c) => c !== 'other')) ?? 'other';
  const placeFrom = [...(change ? [change] : []), ...ranked];
  const venue = placeFrom.map((m) => m.p.venue).find((v): v is string => !!v) ?? null;
  const city = placeFrom.map((m) => m.p.city).find((v): v is string => !!v) ?? null;
  const title = eventTitle(msgs);
  const vendors = [...new Set(msgs.map((m) => m.vendor).filter((v): v is string => !!v))];
  const vendorIds = [...new Set(msgs.map((m) => m.refs.vendorEventId).filter((v): v is string => !!v))];
  const partifulIds = [...new Set(msgs.flatMap((m) => m.refs.partifulIds ?? []))];

  // Parties: event + person.
  const resolve = partyResolver(db);
  const ids = JSON.stringify(msgs.map((m) => m.gmailId));
  const parties = db.prepare(`SELECT gmail_id, direction, name, email_key, quantity, person_id FROM ticket_parties WHERE gmail_id IN (SELECT value FROM json_each(?))`).all(ids) as PartyRow[];
  const setParty = db.prepare('UPDATE ticket_parties SET ticket_event_id = ?, person_id = ?, updated_at = ? WHERE gmail_id = ? AND direction = ?');
  const knownTo = new Set<string>();
  const partyQty = new Map<string, number>();
  const from = new Map<string, NonNullable<QtyMsg['from']>>();
  for (const p of parties) {
    const person = resolve(p);
    setParty.run(eventId, person, o.now, p.gmail_id, p.direction);
    if (p.direction === 'sent_to' && person) knownTo.add(p.gmail_id);
    if (p.quantity) partyQty.set(p.gmail_id, p.quantity);
    if (p.direction === 'received_from') {
      const first = normalizeNamePart(p.name ?? '').split(/[^\p{L}\p{N}]+/u).find(Boolean) ?? null;
      from.set(p.gmail_id, { person, email: p.email_key, first });
    }
  }

  const counts = computeLedger(
    msgs.map((m) => ({
      id: m.gmailId,
      at: m.internalAt,
      kind: m.p.kind,
      qty: m.refs.qty ?? partyQty.get(m.gmailId) ?? m.p.quantity ?? null,
      orderRef: m.refs.orderRef ?? null,
      vendor: m.vendor,
      forwarded: !!m.refs.forwarded,
      pkpass: m.refs.pkpass ?? 0,
      toKnownPerson: knownTo.has(m.gmailId),
      thread: m.threadId,
      from: from.get(m.gmailId) ?? null,
    })),
  );

  db.prepare(
    `UPDATE ticket_events SET title = @title, title_key = @title_key, performers = @performers, genres = @genres, category = @category,
       venue = @venue, venue_key = @venue_key, city = @city,
       starts_at = coalesce(@starts_at, starts_at), ends_at = CASE WHEN @starts_at IS NULL THEN ends_at ELSE @ends_at END,
       tz = CASE WHEN @starts_at IS NULL THEN tz ELSE @tz END, local_date = coalesce(@local_date, local_date),
       vendors = @vendors, vendor_event_ids = @vendor_event_ids, partiful_ids = @partiful_ids,
       qty_bought = @bought, qty_received = @received, qty_sent = @sent, qty_sold = @sold, qty_refunded = @refunded, held = @held,
       status = @status, emails = @emails, first_email_at = @first, last_email_at = @last, updated_at = @now
     WHERE id = @id`,
  ).run({
    id: eventId,
    title,
    title_key: titleKey(title),
    performers: JSON.stringify(performers.slice(0, 10)),
    genres: JSON.stringify(genres),
    category,
    venue,
    venue_key: venueKey(venue),
    city,
    starts_at: dates?.starts_at ?? null,
    ends_at: dates?.ends_at ?? null,
    tz: dates?.tz ?? null,
    local_date: dates?.local_date ?? null,
    vendors: JSON.stringify(vendors),
    vendor_event_ids: JSON.stringify(vendorIds),
    partiful_ids: JSON.stringify(partifulIds),
    bought: counts.bought,
    received: counts.received,
    sent: counts.sent,
    sold: counts.sold,
    refunded: counts.refunded,
    held: counts.held,
    status: counts.status,
    emails: msgs.length,
    first: Math.min(...msgs.map((m) => m.internalAt)),
    last: Math.max(...msgs.map((m) => m.internalAt)),
    now: o.now,
  });
}

// ---------------------------------------------------------------------------------------------- disconnect

/**
 * Disconnect's "also delete synced Gmail data": every ticket event, looked-at message and party. The ticket-parse
 * requests in the LLM ledger are retired, not deleted: the rows are the spend ledger and the custom_id ledger (a
 * re-created message picks an attempt past them, parse.ts), so only what they hold of the mail goes — the stored
 * packet and the answer, as llm-purge does after 30 days. A request still open in the batch layer keeps its body
 * until it is handled (its answer applies to the same message if it comes back; llm-purge clears it later).
 */
export function deleteGmailData(db: DB, o: { now?: number } = {}): { messages: number; events: number; parties: number; requests: number } {
  const parties = db.prepare('DELETE FROM ticket_parties').run().changes;
  const messages = db.prepare('DELETE FROM gmail_messages').run().changes;
  db.prepare('UPDATE ticket_events SET merged_into_id = NULL WHERE merged_into_id IS NOT NULL').run();
  const events = db.prepare('DELETE FROM ticket_events').run().changes;
  const requests = db
    .prepare(
      `UPDATE llm_requests SET output = NULL, params = NULL, purged_at = coalesce(purged_at, ?)
       WHERE kind = 'ticket' AND subject_ref LIKE 'gmail:%' AND (output IS NOT NULL OR params IS NOT NULL)
         AND (applied_at IS NOT NULL OR (batch_id IS NULL AND status = 'errored'))`,
    )
    .run(o.now ?? Date.now()).changes;
  return { messages, events, parties, requests };
}
