/**
 * Events screen API: occasions (merged calendar copies and the ticket the owner holds, maybe linked to a Partiful
 * event) plus Partiful events no occasion covers, with who was there. Every person comes through person_canon →
 * person_visible, so hidden and merged-away people never appear; evidence is signal types, weights and message ids
 * only (never message text). Sensitive occasions (medical) and non-social kinds (logistics, appointments, work) are
 * never listed, and a sensitive one is not served at all. Sources come from occasion_sources ('ticket' = the ticket
 * ledger; its title is the vendor's).
 *
 *   GET /events?when=upcoming|past&kind=social|trips|all&cursor=&limit=
 *   GET /events/:id          an occasion (a merged-away id answers with its survivor) or a Partiful event
 */
import { Router } from 'express';
import { z } from 'zod';
import type { DB } from '../db/connection';
import { badRequest, notFound } from '../http/errors';
import { occasionChain, survivingOccasion } from '../pipeline/occasions/build';
import { COUNTED, POSSIBLE } from '../pipeline/occasions/signals';
import type { RouteDeps } from './index';
import { compareByName, hiddenNameRedactor, maskText } from './people';

export { hiddenNameRedactor };

// ---------------------------------------------------------------------------------------------- DTOs

export type EventType = 'occasion' | 'event';

export interface AttendeeChip {
  personId: string;
  displayName: string;
}

export interface EventListItem {
  id: string;
  type: EventType;
  title: string | null;
  kind: string;
  startsAt: number;
  endsAt: number | null;
  allDay: boolean;
  venue: string | null;
  /** The occasion's sources (occasion_sources): 'calendar', 'partiful' and/or 'ticket', in that order. */
  sources: string[];
  attendeeCount: number;
  possibleCount: number;
  /** Up to 5 counted attendees. */
  attendees: AttendeeChip[];
}

export interface EventsPage {
  items: EventListItem[];
  nextCursor: string | null;
}

export interface EvidenceView {
  type: string;
  weight: number;
  messageIds: number[];
  ref: string | null;
}

export interface AttendeeView extends AttendeeChip {
  status: string;
  role: string | null;
  source: string;
  confidence: number;
  /** Counted in ties and edges (≥ 0.75); otherwise "possible". */
  counted: boolean;
  evidence: EvidenceView[];
}

export interface EventSourceView {
  /** 'ticket' = a ticket_events row from the owner's ticket emails (title as the vendor wrote it). */
  source: 'calendar' | 'partiful' | 'ticket';
  role: string;
  title: string | null;
  calendarTreatment: string | null;
}

export interface EventDetail {
  id: string;
  type: EventType;
  title: string | null;
  kind: string;
  isSocial: boolean;
  status: string;
  corroborated: boolean;
  classifiedBy: string | null;
  startsAt: number;
  endsAt: number | null;
  allDay: boolean;
  venue: string | null;
  ticketCount: number | null;
  sources: EventSourceView[];
  /** Names of the Google calendars the occasion came from (primary first; hidden people's names blanked). */
  calendars: string[];
  /** The owner's own RSVP, lowercased: the linked Partiful event's, else his calendar response ('going', 'maybe', …). */
  myRsvp: string | null;
  partifulEvent: { id: string; title: string | null; url: string | null } | null;
  attendees: AttendeeView[];
}

// ---------------------------------------------------------------------------------------------- helpers

const COUNTED_STATUSES = new Set(['going', 'attended', 'approved', 'checked_in', 'host']);
const HIDDEN_STATUSES = new Set(['rejected', 'withdrawn', 'declined', 'invited', 'waitlist']);
const PARTIFUL_ATTENDING = `(lower(coalesce(e.my_rsvp, '')) IN ('going','approved','maybe','checked_in','attended') OR lower(coalesce(e.my_role, '')) IN ('host','co_host','cohost'))`;
const KINDS: Record<string, string[]> = { social: ['social'], trips: ['lodging', 'travel'], all: ['social', 'lodging', 'travel'] };
const SOURCE_ORDER = ['calendar', 'partiful', 'ticket'];

interface AttRow {
  person_id: string;
  display_name: string;
  first_name: string | null;
  last_name: string | null;
  status: string;
  role: string | null;
  source: string;
  confidence: number;
  evidence: string;
  updated_at: number;
}

const isCounted = (r: { status: string; confidence: number }) => COUNTED_STATUSES.has(r.status.toLowerCase()) && r.confidence >= COUNTED;

/** Visible canonical attendees of occasions (chains) or Partiful events, one per person (user rows win, then confidence). */
function attendeeRows(db: DB, where: { occasionIds?: string[]; eventId?: string }): AttRow[] {
  const rows = db
    .prepare(
      `SELECT pv.id AS person_id, pv.display_name, pv.first_name, pv.last_name, a.status, a.role, a.source, a.confidence, a.evidence, a.updated_at
       FROM event_attendees a
       JOIN person_canon pc ON pc.person_id = a.person_id
       JOIN person_visible pv ON pv.id = pc.canonical_id
       WHERE ${where.occasionIds ? 'a.occasion_id IN (SELECT value FROM json_each(@occ))' : 'a.event_id = @event'}`,
    )
    .all({ occ: JSON.stringify(where.occasionIds ?? []), event: where.eventId ?? null }) as AttRow[];
  const best = new Map<string, AttRow>();
  const rank = (r: AttRow) => (r.source === 'user' ? 2 : 0) + (HIDDEN_STATUSES.has(r.status.toLowerCase()) ? -4 : 0);
  for (const r of rows) {
    const cur = best.get(r.person_id);
    if (!cur || rank(r) > rank(cur) || (rank(r) === rank(cur) && (r.confidence > cur.confidence || (r.confidence === cur.confidence && r.updated_at > cur.updated_at)))) {
      best.set(r.person_id, r);
    }
  }
  return [...best.values()].filter((r) => !HIDDEN_STATUSES.has(r.status.toLowerCase()) && r.confidence >= POSSIBLE);
}

const sortKey = (r: AttRow) => {
  const last = r.last_name?.trim() ?? '';
  const first = r.first_name?.trim() ?? '';
  return { id: r.person_id, last, first: first || (last ? '' : r.display_name.trim()), display: r.display_name.trim(), lastAt: null, createdAt: 0 };
};

/** Counted first, then last name A–Z (first name tiebreak). */
function sortAttendees(rows: AttRow[]): AttRow[] {
  return [...rows].sort((a, b) => Number(isCounted(b)) - Number(isCounted(a)) || compareByName(sortKey(a), sortKey(b)));
}

function evidenceOf(raw: string): EvidenceView[] {
  try {
    const list = JSON.parse(raw) as { t?: unknown; w?: unknown; m?: unknown; ref?: unknown }[];
    if (!Array.isArray(list)) return [];
    return list.map((e) => ({
      type: typeof e.t === 'string' ? e.t : 'unknown',
      weight: typeof e.w === 'number' ? e.w : 0,
      messageIds: Array.isArray(e.m) ? e.m.filter((x): x is number => Number.isInteger(x)) : [],
      ref: typeof e.ref === 'string' ? e.ref : null,
    }));
  } catch {
    return [];
  }
}

const chip = (r: AttRow): AttendeeChip => ({ personId: r.person_id, displayName: maskText(r.display_name) });

// ---------------------------------------------------------------------------------------------- list

interface ListRow {
  type: EventType;
  id: string;
  title: string | null;
  kind: string;
  starts_at: number;
  ends_at: number | null;
  all_day: number;
  venue: string | null;
  linked: number;
}

const Cursor = z.string().regex(/^-?\d{1,15}:[0-9a-f-]{36}$/i);

export function listEvents(db: DB, o: { when: 'upcoming' | 'past'; kind: keyof typeof KINDS; cursor?: string; limit: number; now?: number }): EventsPage {
  const now = o.now ?? Date.now();
  let cursorAt: number | null = null;
  let cursorId: string | null = null;
  if (o.cursor) {
    const c = Cursor.safeParse(o.cursor);
    if (!c.success) throw badRequest('Invalid cursor.');
    const i = c.data.indexOf(':');
    cursorAt = Number(c.data.slice(0, i));
    cursorId = c.data.slice(i + 1).toLowerCase();
  }
  const upcoming = o.when === 'upcoming';
  const includePartiful = o.kind !== 'trips';
  const rows = db
    .prepare(
      `WITH items AS (
         SELECT 'occasion' AS type, o.id, o.title, o.kind, o.starts_at, o.ends_at, o.all_day, o.venue_text AS venue,
                o.event_id IS NOT NULL AS linked
         FROM occasions o
         WHERE o.merged_into_id IS NULL AND o.status = 'active' AND o.sensitive = 0 AND o.kind IN (SELECT value FROM json_each(@kinds))
         UNION ALL
         SELECT 'event', e.id, e.title, 'social', e.starts_at, e.ends_at, 0, e.location_text, 1
         FROM events e
         WHERE @partiful = 1 AND e.source = 'partiful' AND e.starts_at IS NOT NULL AND ${PARTIFUL_ATTENDING}
           AND NOT EXISTS (SELECT 1 FROM occasions o WHERE o.event_id = e.id AND o.merged_into_id IS NULL AND o.status IN ('active', 'candidate'))
       )
       SELECT * FROM items
       WHERE (CASE WHEN @upcoming = 1 THEN coalesce(ends_at, starts_at) >= @now ELSE coalesce(ends_at, starts_at) < @now END)
         AND (@cursorAt IS NULL OR (CASE WHEN @upcoming = 1
               THEN (starts_at > @cursorAt OR (starts_at = @cursorAt AND id > @cursorId))
               ELSE (starts_at < @cursorAt OR (starts_at = @cursorAt AND id < @cursorId)) END))
       ORDER BY CASE WHEN @upcoming = 1 THEN starts_at END ASC, CASE WHEN @upcoming = 1 THEN id END ASC,
                CASE WHEN @upcoming = 0 THEN starts_at END DESC, CASE WHEN @upcoming = 0 THEN id END DESC
       LIMIT @limit`,
    )
    .all({
      kinds: JSON.stringify(KINDS[o.kind]),
      partiful: includePartiful ? 1 : 0,
      upcoming: upcoming ? 1 : 0,
      now,
      cursorAt,
      cursorId,
      limit: o.limit + 1,
    }) as ListRow[];
  const page = rows.slice(0, o.limit);
  const redact = hiddenNameRedactor(db);
  const sourcesOf = db.prepare(`SELECT DISTINCT source FROM occasion_sources WHERE occasion_id = ?`).pluck();
  const occasionSources = (r: ListRow): string[] => {
    const have = new Set(sourcesOf.all(r.id) as string[]);
    if (r.linked) have.add('partiful');
    return SOURCE_ORDER.filter((x) => have.has(x));
  };
  const items = page.map((r): EventListItem => {
    const att = r.type === 'occasion' ? attendeeRows(db, { occasionIds: occasionChain(db, r.id) }) : attendeeRows(db, { eventId: r.id });
    const counted = sortAttendees(att.filter(isCounted));
    return {
      id: r.id,
      type: r.type,
      title: r.type === 'occasion' ? redact(r.title) : r.title && maskText(r.title),
      kind: r.kind,
      startsAt: r.starts_at,
      endsAt: r.ends_at,
      allDay: r.all_day === 1,
      venue: r.venue && maskText(r.venue),
      sources: r.type === 'event' ? ['partiful'] : occasionSources(r),
      attendeeCount: counted.length,
      possibleCount: att.length - counted.length,
      attendees: counted.slice(0, 5).map(chip),
    };
  });
  const last = page[page.length - 1];
  return { items, nextCursor: rows.length > o.limit && last ? `${last.starts_at}:${last.id}` : null };
}

// ---------------------------------------------------------------------------------------------- detail

interface OccRow {
  id: string;
  kind: string;
  title: string | null;
  starts_at: number;
  ends_at: number | null;
  all_day: number;
  venue_text: string | null;
  event_id: string | null;
  is_social: number | null;
  sensitive: number;
  corroborated: number;
  classified_by: string | null;
  ticket_count: number | null;
  status: string;
}

/** Google's responseStatus for the owner, in the attendee vocabulary the client labels. */
const CALENDAR_RSVP: Record<string, string> = { accepted: 'going', tentative: 'maybe', declined: 'declined', needsAction: 'invited' };
const rsvpOf = (raw: string | null | undefined): string | null => (raw && raw.trim() ? raw.trim().toLowerCase() : null);

/** The occasion's calendars (a primary calendar named by its address reads "Primary") and the owner's response there. */
function occasionCalendars(db: DB, occasionId: string, redact: (t: string | null) => string | null): { calendars: string[]; response: string | null } {
  const rows = db
    .prepare(
      `SELECT g.is_primary, g.summary, ce.self_response
       FROM occasion_sources s JOIN calendar_events ce ON ce.id = s.source_ref
       LEFT JOIN gcal_calendars g ON g.calendar_id = ce.calendar_id
       WHERE s.occasion_id = ? AND s.source = 'calendar'
       ORDER BY CASE s.role WHEN 'primary' THEN 0 ELSE 1 END, coalesce(g.is_primary, 0) DESC, lower(coalesce(g.summary, '')), s.source_ref`,
    )
    .all(occasionId) as { is_primary: number | null; summary: string | null; self_response: string | null }[];
  const names: string[] = [];
  for (const r of rows) {
    const name = r.is_primary === 1 && (!r.summary || r.summary.includes('@')) ? 'Primary' : redact(r.summary?.trim() || null);
    if (name && !names.includes(name)) names.push(name);
  }
  const response = rows.find((r) => r.self_response)?.self_response ?? null;
  return { calendars: names, response: response ? (CALENDAR_RSVP[response] ?? null) : null };
}

const toAttendeeView = (r: AttRow): AttendeeView => ({
  ...chip(r),
  status: r.status,
  role: r.role,
  source: r.source,
  confidence: r.confidence,
  counted: isCounted(r),
  evidence: evidenceOf(r.evidence),
});

export function eventDetail(db: DB, rawId: string): EventDetail {
  const id = rawId.toLowerCase();
  const exists = db.prepare('SELECT 1 FROM occasions WHERE id = ?').get(id);
  if (exists) {
    const occ = db.prepare('SELECT * FROM occasions WHERE id = ?').get(survivingOccasion(db, id)) as OccRow;
    if (occ.sensitive === 1) throw notFound('Event');
    const redact = hiddenNameRedactor(db);
    const sources = db
      .prepare(
        `SELECT s.source, s.role, coalesce(ce.summary, ev.title, te.title) AS title, CASE WHEN s.source = 'calendar' THEN o.calendar_treatment END AS treatment
         FROM occasion_sources s JOIN occasions o ON o.id = s.occasion_id
         LEFT JOIN calendar_events ce ON s.source = 'calendar' AND ce.id = s.source_ref
         LEFT JOIN events ev ON s.source = 'partiful' AND ev.id = s.source_ref
         LEFT JOIN ticket_events te ON s.source = 'ticket' AND te.id = s.source_ref
         WHERE s.occasion_id = ? ORDER BY CASE s.role WHEN 'primary' THEN 0 ELSE 1 END, s.source, s.source_ref`,
      )
      .all(occ.id) as { source: EventSourceView['source']; role: string; title: string | null; treatment: string | null }[];
    const ev = occ.event_id
      ? (db.prepare('SELECT id, title, url, my_rsvp FROM events WHERE id = ?').get(occ.event_id) as
          | { id: string; title: string | null; url: string | null; my_rsvp: string | null }
          | undefined)
      : undefined;
    const cal = occasionCalendars(db, occ.id, redact);
    return {
      id: occ.id,
      type: 'occasion',
      title: redact(occ.title),
      kind: occ.kind,
      isSocial: occ.is_social === 1,
      status: occ.status,
      corroborated: occ.corroborated === 1,
      classifiedBy: occ.classified_by,
      startsAt: occ.starts_at,
      endsAt: occ.ends_at,
      allDay: occ.all_day === 1,
      venue: occ.venue_text && maskText(occ.venue_text),
      ticketCount: occ.ticket_count,
      sources: sources.map((s) => ({ source: s.source, role: s.role, title: redact(s.title), calendarTreatment: s.treatment })),
      calendars: cal.calendars,
      myRsvp: rsvpOf(ev?.my_rsvp) ?? cal.response,
      partifulEvent: ev ? { id: ev.id, title: ev.title && maskText(ev.title), url: ev.url } : null,
      attendees: sortAttendees(attendeeRows(db, { occasionIds: occasionChain(db, occ.id) })).map(toAttendeeView),
    };
  }
  const ev = db.prepare(`SELECT * FROM events e WHERE e.id = ? AND e.source = 'partiful'`).get(id) as
    | {
        id: string;
        title: string | null;
        kind: string;
        starts_at: number | null;
        ends_at: number | null;
        location_text: string | null;
        url: string | null;
        status: string | null;
        my_rsvp: string | null;
      }
    | undefined;
  if (!ev || ev.starts_at == null) throw notFound('Event');
  return {
    id: ev.id,
    type: 'event',
    title: ev.title && maskText(ev.title),
    kind: 'social',
    isSocial: true,
    status: ev.status ?? 'active',
    corroborated: true,
    classifiedBy: null,
    startsAt: ev.starts_at,
    endsAt: ev.ends_at,
    allDay: false,
    venue: ev.location_text && maskText(ev.location_text),
    ticketCount: null,
    sources: [{ source: 'partiful', role: 'primary', title: ev.title && maskText(ev.title), calendarTreatment: null }],
    calendars: [],
    myRsvp: rsvpOf(ev.my_rsvp),
    partifulEvent: { id: ev.id, title: ev.title && maskText(ev.title), url: ev.url },
    attendees: sortAttendees(attendeeRows(db, { eventId: ev.id })).map(toAttendeeView),
  };
}

// ---------------------------------------------------------------------------------------------- routes

const ListQuery = z.object({
  when: z.enum(['upcoming', 'past']).default('upcoming'),
  kind: z.enum(['social', 'trips', 'all']).default('social'),
  cursor: z.string().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
const IdParam = z.object({ id: z.string().regex(/^[0-9a-f-]{36}$/i) });

export function eventsRouter({ db }: RouteDeps): Router {
  const r = Router();
  r.get('/events', (req, res) => {
    const q = ListQuery.parse(req.query);
    res.json(listEvents(db, q) satisfies EventsPage);
  });
  r.get('/events/:id', (req, res) => {
    const { id } = IdParam.parse(req.params);
    res.json(eventDetail(db, id) satisfies EventDetail);
  });
  return r;
}
