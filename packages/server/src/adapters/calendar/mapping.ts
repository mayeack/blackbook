/**
 * Google event → calendar_events row. Description and attendee names stay in the local database (attendee
 * inference reads them) and are never logged. Rooms and other resources are dropped from attendees; `raw` keeps
 * the rest of the resource without the fields that already have their own column.
 */
import { normalizeEmail } from '@yb/shared';
import type { GoogleEvent } from './google';
import { resolveTime } from './time';

export interface CalendarAttendee {
  email: string | null;
  name: string | null;
  status: string | null;
  self: boolean;
  organizer: boolean;
  optional: boolean;
  guests: number;
}

export interface CalendarEventRow {
  calendar_id: string;
  google_event_id: string;
  ical_uid: string | null;
  recurring_event_id: string | null;
  status: 'confirmed' | 'tentative' | 'cancelled';
  summary: string | null;
  description: string | null;
  location: string | null;
  starts_at: number | null;
  ends_at: number | null;
  all_day: 0 | 1;
  tz: string | null;
  start_date: string | null;
  end_date: string | null;
  original_start_at: number | null;
  organizer_email: string | null;
  creator_email: string | null;
  self_organizer: 0 | 1 | null;
  self_response: 'accepted' | 'declined' | 'tentative' | 'needsAction' | null;
  attendees: string;
  html_link: string | null;
  partiful_event_id: string | null;
  event_type: string | null;
  etag: string | null;
  remote_updated_at: number | null;
  raw: string;
}

const STATUSES = new Set(['confirmed', 'tentative', 'cancelled']);
const RESPONSES = new Set(['accepted', 'declined', 'tentative', 'needsAction']);
const MAX_RAW_BYTES = 32 * 1024;

const PARTIFUL_URL = /partiful\.com\/e\/([A-Za-z0-9_-]{6,64})/i;
/** iCal UIDs of the Partiful feed look like "<event id>@partiful.com" (or a subdomain). */
const PARTIFUL_UID = /^([A-Za-z0-9_-]{6,64})@(?:[a-z0-9-]+\.)*partiful\.com$/i;

/** The Partiful event id from a partiful.com/e/<id> link in the notes, location or source, or the feed UID. */
export function partifulEventId(ev: Pick<GoogleEvent, 'description' | 'location' | 'source' | 'iCalUID'>): string | null {
  for (const text of [ev.description, ev.location, ev.source?.url]) {
    const m = text ? PARTIFUL_URL.exec(text) : null;
    if (m) return m[1]!;
  }
  const uid = ev.iCalUID ? PARTIFUL_UID.exec(ev.iCalUID) : null;
  return uid ? uid[1]! : null;
}

const email = (v: string | null | undefined) => (v ? normalizeEmail(v) : null);
const parsedMs = (v: string | null | undefined) => {
  const ms = v ? Date.parse(v) : NaN;
  return Number.isFinite(ms) ? ms : null;
};

function rawJson(ev: GoogleEvent): string {
  const { description: _d, attendees: _a, ...rest } = ev;
  const json = JSON.stringify(rest);
  if (Buffer.byteLength(json) <= MAX_RAW_BYTES) return json;
  // Oversized (huge conference data, extended properties): keep the fields the pipeline looks at.
  const { id, status, eventType, start, end, originalStartTime, source, recurringEventId, iCalUID, transparency, visibility } = rest as Record<string, unknown>;
  return JSON.stringify({ id, status, eventType, start, end, originalStartTime, source, recurringEventId, iCalUID, transparency, visibility, truncated: true });
}

export function toRow(calendarId: string, ev: GoogleEvent, calendarTz: string | null): CalendarEventRow {
  const start = resolveTime(ev.start, calendarTz);
  const end = resolveTime(ev.end, calendarTz);
  const original = ev.originalStartTime ? resolveTime(ev.originalStartTime, calendarTz) : null;
  const attendees: CalendarAttendee[] = (ev.attendees ?? [])
    .filter((a) => !a.resource)
    .map((a) => ({
      email: email(a.email),
      name: a.displayName?.trim() || null,
      status: a.responseStatus ?? null,
      self: !!a.self,
      organizer: !!a.organizer,
      optional: !!a.optional,
      guests: Math.max(0, a.additionalGuests ?? 0),
    }));
  const selfResponse = (ev.attendees ?? []).find((a) => a.self)?.responseStatus ?? null;
  return {
    calendar_id: calendarId,
    google_event_id: ev.id,
    ical_uid: ev.iCalUID ?? null,
    recurring_event_id: ev.recurringEventId ?? null,
    status: (STATUSES.has(ev.status ?? '') ? ev.status : 'confirmed') as CalendarEventRow['status'],
    summary: ev.summary ?? null,
    description: ev.description ?? null,
    location: ev.location ?? null,
    starts_at: start.at,
    ends_at: end.at ?? start.at,
    all_day: start.allDay ? 1 : 0,
    tz: start.tz,
    start_date: start.allDay ? start.date : null,
    end_date: start.allDay ? end.date : null,
    original_start_at: original?.at ?? null,
    organizer_email: email(ev.organizer?.email),
    creator_email: email(ev.creator?.email),
    self_organizer: ev.organizer ? (ev.organizer.self ? 1 : 0) : null,
    self_response: selfResponse && RESPONSES.has(selfResponse) ? (selfResponse as CalendarEventRow['self_response']) : null,
    attendees: JSON.stringify(attendees),
    html_link: ev.htmlLink ?? null,
    partiful_event_id: partifulEventId(ev),
    event_type: ev.eventType ?? null,
    etag: ev.etag ?? null,
    remote_updated_at: parsedMs(ev.updated),
    raw: rawJson(ev),
  };
}
