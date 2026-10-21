/**
 * Events screen API: calendar occasions (merged calendar copies, maybe linked to a Partiful event) plus Partiful
 * events no occasion covers, with who was there. Every person comes through person_canon → person_visible, so
 * hidden and merged-away people never appear; in the list and the detail, evidence is signal types, weights and
 * message ids only (never message text). Sensitive occasions (medical) and non-social kinds (logistics,
 * appointments, work) are never listed, and a sensitive one is not served at all.
 *
 *   GET /events?when=upcoming|past&kind=social|trips|all&cursor=&limit=
 *   GET /events/:id                 an occasion (a merged-away id answers with its survivor) or a Partiful event
 *   GET /events/:id/clues/:personId  one attendee's clues with the messages behind them, asked for when the owner
 *                                    opens them: only the ids that row cites, never from an excluded conversation,
 *                                    unsent ones without text, emails and phone numbers masked, hidden people's
 *                                    names blanked
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
  /** 'calendar' and/or 'partiful'. */
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

export interface ClueMessageView {
  id: number;
  sentAt: number;
  fromMe: boolean;
  /** Who wrote it when it wasn't the owner: a visible person's name, else null ("someone"). */
  sender: string | null;
  /** 'dm' (a 1:1 thread) or 'group' (with the group chat's title when it has one). */
  where: 'dm' | 'group';
  chat: string | null;
  /** Masked and clipped; null when it was unsent or is an attachment without text. */
  text: string | null;
  attachment: boolean;
}

export interface ClueView {
  type: string;
  weight: number;
  messages: ClueMessageView[];
  /** What a non-message clue points at: the group chat, Partiful event or calendar entry's title. */
  refTitle: string | null;
}

export interface AttendeeClues {
  personId: string;
  displayName: string;
  status: string;
  source: string;
  confidence: number;
  startsAt: number;
  endsAt: number | null;
  clues: ClueView[];
}

export interface EventSourceView {
  source: 'calendar' | 'partiful';
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
      sources: r.type === 'event' ? ['partiful'] : r.linked ? ['calendar', 'partiful'] : ['calendar'],
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
        `SELECT s.source, s.role, coalesce(ce.summary, ev.title) AS title, CASE WHEN s.source = 'calendar' THEN o.calendar_treatment END AS treatment
         FROM occasion_sources s JOIN occasions o ON o.id = s.occasion_id
         LEFT JOIN calendar_events ce ON s.source = 'calendar' AND ce.id = s.source_ref
         LEFT JOIN events ev ON s.source = 'partiful' AND ev.id = s.source_ref
         WHERE s.occasion_id = ? ORDER BY CASE s.role WHEN 'primary' THEN 0 ELSE 1 END, s.source, s.source_ref`,
      )
      .all(occ.id) as { source: 'calendar' | 'partiful'; role: string; title: string | null; treatment: string | null }[];
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

// ---------------------------------------------------------------------------------------------- clues

const CLUE_TEXT_MAX = 240;

/** One attendee's clues with their messages (see the module header). 404 when the person isn't shown there. */
export function attendeeClues(db: DB, rawId: string, personId: string): AttendeeClues {
  const detail = eventDetail(db, rawId);
  const canonical = (db.prepare('SELECT canonical_id FROM person_canon WHERE person_id = ?').pluck().get(personId) as string | undefined) ?? personId;
  const a = detail.attendees.find((x) => x.personId === canonical);
  if (!a) throw notFound('Attendee');
  const ids = [...new Set(a.evidence.flatMap((e) => e.messageIds))];
  const rows = ids.length
    ? (db
        .prepare(
          `SELECT m.id, m.sent_at, m.is_from_me, m.kind, m.text, m.retracted_at, c.kind AS conv_kind, c.title AS chat, pv.display_name AS sender
           FROM messages m JOIN conversations c ON c.id = m.conversation_id
           LEFT JOIN identities i ON i.id = m.sender_identity_id
           LEFT JOIN person_canon pc ON pc.person_id = i.person_id
           LEFT JOIN person_visible pv ON pv.id = pc.canonical_id
           WHERE m.id IN (SELECT value FROM json_each(?)) AND c.agent_excluded = 0 AND m.is_spam = 0`,
        )
        .all(JSON.stringify(ids)) as {
        id: number;
        sent_at: number;
        is_from_me: number;
        kind: string;
        text: string | null;
        retracted_at: number | null;
        conv_kind: string;
        chat: string | null;
        sender: string | null;
      }[])
    : [];
  const redact = hiddenNameRedactor(db);
  const clip = (t: string) => (t.length <= CLUE_TEXT_MAX ? t : `${t.slice(0, CLUE_TEXT_MAX - 1).trimEnd()}…`);
  const byId = new Map(
    rows.map((r): [number, ClueMessageView] => {
      const raw = r.retracted_at == null && r.text ? r.text.replace(/\s+/g, ' ').trim() : '';
      return [
        r.id,
        {
          id: r.id,
          sentAt: r.sent_at,
          fromMe: r.is_from_me === 1,
          sender: r.is_from_me === 1 || !r.sender ? null : maskText(r.sender),
          where: r.conv_kind === 'group' ? 'group' : 'dm',
          chat: r.conv_kind === 'group' && r.chat ? redact(maskText(r.chat)) : null,
          text: raw ? redact(clip(maskText(raw))) : null,
          attachment: r.kind === 'attachment',
        },
      ];
    }),
  );
  const refTitle = db
    .prepare(
      `SELECT CASE
       WHEN @ref LIKE 'conv:%' THEN (SELECT title FROM conversations WHERE id = substr(@ref, 6) AND agent_excluded = 0)
       WHEN @ref LIKE 'event:%' THEN (SELECT title FROM events WHERE id = substr(@ref, 7))
       WHEN @ref LIKE 'cal:%' THEN (SELECT summary FROM calendar_events WHERE id = substr(@ref, 5))
       WHEN @ref LIKE 'circle:%' THEN (SELECT name FROM circles WHERE id = substr(@ref, 8))
     END`,
    )
    .pluck();
  return {
    personId: a.personId,
    displayName: a.displayName,
    status: a.status,
    source: a.source,
    confidence: a.confidence,
    startsAt: detail.startsAt,
    endsAt: detail.endsAt,
    clues: a.evidence.map((e) => {
      const title = e.ref ? (refTitle.get({ ref: e.ref }) as string | null | undefined) : null;
      return {
        type: e.type,
        weight: e.weight,
        messages: e.messageIds
          .map((id) => byId.get(id))
          .filter((m): m is ClueMessageView => !!m)
          .sort((x, y) => x.sentAt - y.sentAt),
        refTitle: title ? redact(maskText(title)) : null,
      };
    }),
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
const CluesParam = z.object({ id: z.string().regex(/^[0-9a-f-]{36}$/i), personId: z.string().regex(/^[0-9a-f-]{36}$/i) });

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
  r.get('/events/:id/clues/:personId', (req, res) => {
    const { id, personId } = CluesParam.parse(req.params);
    res.json(attendeeClues(db, id, personId) satisfies AttendeeClues);
  });
  return r;
}
