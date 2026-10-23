/**
 * View models for the Events screen and the Google Calendar card. routes/{events,google}.ts are built alongside
 * this screen, so their JSON is read tolerantly (camelCase first, snake_case accepted, unknown fields ignored) and
 * turned into the shapes in api/types.ts. Nothing here trusts the server to have filtered "rejected" or
 * low-confidence attendees: below 0.5 is never shown, 0.5–0.75 is "possible" (PLAN "Calendar attendee inference").
 */
import type {
  AttendeeTier,
  AttendeeView,
  EventsPage,
  GoogleCalendarView,
  GoogleStatusView,
  OccasionDetail,
  OccasionSummary,
} from '../api/types';
import { date, percent, plural, span } from './format';
import { attendeeRoleLabel, attendeeSourceLabel, attendeeStatusLabel, DEFAULT_TREATMENTS } from './labels';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** First present (non-null) value among the keys. */
function pick(o: Obj, ...keys: string[]): unknown {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/** Unix ms, or an ISO date/time string. */
function ms(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Confidence at or above this counts as attendance; below POSSIBLE_MIN is not shown at all. */
export const ATTEND_MIN = 0.75;
export const POSSIBLE_MIN = 0.5;

const MAYBE_STATUSES = new Set(['maybe', 'invited', 'waitlist']);

export function attendeeTier(status: string, confidence: number): AttendeeTier | null {
  if (status === 'rejected') return null;
  if (status === 'declined') return 'declined';
  if (confidence < POSSIBLE_MIN) return null;
  if (status === 'possible' || confidence < ATTEND_MIN) return 'possible';
  if (MAYBE_STATUSES.has(status)) return 'maybe';
  return 'confirmed';
}

/** Name parts for sorting when the server sends only a display name ("Ana de la Cruz" → last "Cruz"). */
function splitName(name: string): { first: string; last: string } {
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length < 2) return { first: words[0] ?? '', last: '' };
  return { first: words[0]!, last: words[words.length - 1]! };
}

export function normalizeAttendee(raw: unknown): AttendeeView | null {
  if (!isObj(raw) || raw.hidden === true) return null;
  const person = isObj(raw.person) ? raw.person : {};
  const status = str(pick(raw, 'status', 'rsvp')) ?? 'going';
  const confidence = clamp01(num(raw.confidence) ?? 1);
  let tier = attendeeTier(status, confidence);
  if (!tier) return null;
  // The server's own verdict wins: `counted: false` is never shown as a confirmed attendee.
  if (raw.counted === false && tier === 'confirmed') tier = 'possible';
  const name = str(pick(raw, 'name', 'displayName', 'display_name', 'label')) ?? str(pick(person, 'displayName', 'name')) ?? 'Someone';
  const evidence = raw.evidence;
  return {
    personId: str(pick(raw, 'personId', 'person_id')) ?? str(person.id),
    name,
    firstName: str(pick(raw, 'firstName', 'first_name')) ?? str(person.firstName),
    lastName: str(pick(raw, 'lastName', 'last_name')) ?? str(person.lastName),
    status,
    role: str(raw.role),
    source: str(raw.source) ?? 'unknown',
    confidence,
    // the adjudicator's verdict is a reading of the clues, not one of them
    evidenceCount:
      num(pick(raw, 'evidenceCount', 'evidence_count')) ?? (Array.isArray(evidence) ? evidence.filter((e) => !isObj(e) || e.type !== 'llm').length : 0),
    tier,
  };
}

/** "Possibly there · Inferred · 62% · 3 clues": status (or role), where it came from, confidence, evidence. */
export function attendeeLine(a: AttendeeView, o: { withSource?: boolean } = {}): string {
  const what = a.tier === 'possible' ? 'Possibly there' : a.role && a.role !== 'guest' ? attendeeRoleLabel(a.role) : attendeeStatusLabel(a.status);
  const parts = o.withSource === false ? [what] : [what, attendeeSourceLabel(a.source)];
  if (a.confidence < 1) parts.push(percent(a.confidence));
  if (a.evidenceCount > 0) parts.push(plural(a.evidenceCount, 'clue'));
  return parts.join(' · ');
}

/** When a clue's message was sent, against the event: "28 h after it ended", "2 days before it", "during it". */
export function relativeToEvent(at: number, start: number, end: number | null): string {
  const HOUR = 3_600_000;
  const stop = end ?? start;
  const fmt = (ms: number) => (ms < 36 * HOUR ? `${Math.max(1, Math.round(ms / HOUR))} h` : `${Math.round(ms / (24 * HOUR))} days`);
  if (at < start) return `${fmt(start - at)} before it`;
  if (at <= stop) return 'during it';
  return `${fmt(at - stop)} after it ended`;
}

const TIER_ORDER: Record<AttendeeTier, number> = { confirmed: 0, maybe: 1, possible: 2, declined: 3 };
const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

/** Confirmed, then maybe, possible, declined; known people first; then last name A–Z (blank last), first name. */
export function compareAttendees(a: AttendeeView, b: AttendeeView): number {
  const an = splitName(a.name);
  const bn = splitName(b.name);
  const al = a.lastName ?? (a.firstName ? '' : an.last);
  const bl = b.lastName ?? (b.firstName ? '' : bn.last);
  return (
    TIER_ORDER[a.tier] - TIER_ORDER[b.tier] ||
    (a.personId ? 0 : 1) - (b.personId ? 0 : 1) ||
    (al ? 0 : 1) - (bl ? 0 : 1) ||
    collator.compare(al, bl) ||
    collator.compare(a.firstName ?? an.first, b.firstName ?? bn.first) ||
    collator.compare(a.name, b.name)
  );
}

function sourcesOf(raw: Obj): string[] {
  const list = arr(pick(raw, 'sources'))
    .map((s) => (isObj(s) ? str(s.source) : str(s)))
    .filter((s): s is string => s != null);
  const one = str(raw.source);
  return [...new Set(list.length ? list : one ? [one] : [])];
}

export function normalizeOccasion(raw: unknown): OccasionSummary | null {
  if (!isObj(raw)) return null;
  const id = str(pick(raw, 'id', 'occasionId', 'occasion_id', 'eventId', 'event_id'));
  if (!id) return null;
  const attendees = arr(pick(raw, 'attendees', 'people', 'guests'))
    .map(normalizeAttendee)
    .filter((a): a is AttendeeView => a != null)
    .sort(compareAttendees);
  const going = attendees.filter((a) => a.tier === 'confirmed' || a.tier === 'maybe').length;
  const possible = attendees.filter((a) => a.tier === 'possible').length;
  return {
    id,
    title: str(pick(raw, 'title', 'name', 'summary')),
    kind: str(pick(raw, 'kind', 'type')),
    startsAt: ms(pick(raw, 'startsAt', 'starts_at', 'startAt', 'start')),
    endsAt: ms(pick(raw, 'endsAt', 'ends_at', 'endAt', 'end')),
    allDay: pick(raw, 'allDay', 'all_day') === true || pick(raw, 'allDay', 'all_day') === 1,
    venue: str(pick(raw, 'venue', 'venueText', 'venue_text', 'location', 'locationText', 'location_text')),
    sources: sourcesOf(raw),
    myRsvp: str(pick(raw, 'myRsvp', 'my_rsvp', 'rsvp')),
    attendees,
    attendeeCount: Math.max(going, num(pick(raw, 'attendeeCount', 'attendee_count', 'goingCount', 'going_count')) ?? 0),
    possibleCount: Math.max(possible, num(pick(raw, 'possibleCount', 'possible_count')) ?? 0),
    evidenceCount: num(pick(raw, 'evidenceCount', 'evidence_count')) ?? attendees.reduce((n, a) => n + a.evidenceCount, 0),
    sensitive: raw.sensitive === true || raw.sensitive === 1,
  };
}

export function normalizeEventsPage(raw: unknown): EventsPage {
  const o = isObj(raw) ? raw : {};
  const list = Array.isArray(raw) ? raw : arr(pick(o, 'items', 'events', 'occasions'));
  return {
    items: list.map(normalizeOccasion).filter((x): x is OccasionSummary => x != null),
    nextCursor: str(pick(o, 'nextCursor', 'next_cursor')),
  };
}

/** Only https links leave the app (never javascript: or data: from an event field). */
export function safeHttpsUrl(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

export function normalizeOccasionDetail(raw: unknown): OccasionDetail | null {
  const o = isObj(raw) ? (isObj(raw.occasion) ? raw.occasion : isObj(raw.event) ? raw.event : raw) : null;
  const base = normalizeOccasion(o);
  if (!o || !base) return null;
  const partiful = isObj(o.partifulEvent) ? o.partifulEvent : {};
  return {
    ...base,
    url: safeHttpsUrl(pick(o, 'url', 'partifulUrl', 'partiful_url', 'htmlLink', 'html_link') ?? partiful.url),
    calendars: arr(pick(o, 'calendars'))
      .map((c) => (isObj(c) ? str(pick(c, 'name', 'summary')) : str(c)))
      .filter((c): c is string => c != null),
  };
}

/** Upcoming soonest first, past most recent first; undated last. */
export function sortOccasions(items: OccasionSummary[], when: 'upcoming' | 'past'): OccasionSummary[] {
  const dir = when === 'upcoming' ? 1 : -1;
  return [...items].sort((a, b) => {
    if (a.startsAt == null || b.startsAt == null) return (a.startsAt == null ? 1 : 0) - (b.startsAt == null ? 1 : 0);
    return dir * (a.startsAt - b.startsAt) || a.id.localeCompare(b.id);
  });
}

export function normalizeGoogleStatus(raw: unknown): GoogleStatusView {
  const o = isObj(raw) ? raw : {};
  const status = str(o.status);
  const calendars = arr(o.calendars)
    .map((c): GoogleCalendarView | null => {
      // A calendar no longer in his list isn't synced: nothing to choose.
      if (!isObj(c) || c.removed === true) return null;
      const id = str(pick(c, 'id', 'calendarId', 'calendar_id'));
      if (!id) return null;
      return {
        id,
        name: str(pick(c, 'name', 'summary', 'title')) ?? 'Calendar',
        treatment: str(pick(c, 'treatment', 'mode')) ?? 'attending',
        primary: c.primary === true,
        events: num(pick(c, 'events', 'eventCount')),
      };
    })
    .filter((c): c is GoogleCalendarView => c != null)
    .sort((a, b) => (a.primary ? 0 : 1) - (b.primary ? 0 : 1) || collator.compare(a.name, b.name));
  const offered = arr(o.treatments).map(str).filter((t): t is string => t != null);
  const treatments = [...new Set([...(offered.length ? offered : DEFAULT_TREATMENTS), ...calendars.map((c) => c.treatment)])];
  const needsReconnect = o.needsReconnect === true || status === 'needs_reconnect' || status === 'auth_required' || status === 'reconnect';
  return {
    configured: o.configured !== false && o.clientConfigured !== false && status !== 'not_configured',
    secretsAvailable: o.secretsAvailable !== false,
    connected: (o.connected === true || status === 'connected') && !needsReconnect,
    needsReconnect,
    account: str(pick(o, 'account', 'email', 'accountEmail')),
    calendars,
    treatments,
    lastSyncAt: ms(pick(o, 'lastSyncAt', 'last_sync_at', 'syncedAt')),
  };
}

/** The title to show: sensitive occasions (medical and the like) never show theirs. */
export function occasionTitle(o: Pick<OccasionSummary, 'title' | 'kind' | 'sensitive'>): string {
  if (o.sensitive) return 'Private appointment';
  return o.title ?? 'Untitled event';
}

export const eventPath = (id: string) => `/e/${encodeURIComponent(id)}`;

/** "Sat, Oct 18, 7:00 – 10:00 PM", "Oct 18" (all day), "Oct 18 – Oct 20" (multi-day all-day). */
export function whenLine(o: Pick<OccasionSummary, 'startsAt' | 'endsAt' | 'allDay'>, now = Date.now()): string {
  if (o.startsAt == null) return 'Date not set';
  if (o.allDay) {
    // An all-day end is exclusive (the next midnight).
    const last = o.endsAt != null ? o.endsAt - 1 : null;
    return last != null && date(last, now) !== date(o.startsAt, now) ? `${date(o.startsAt, now)} – ${date(last, now)}` : date(o.startsAt, now);
  }
  const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(o.startsAt);
  return `${weekday}, ${span(o.startsAt, o.endsAt, now)}`;
}

/** Where /google/callback sends the browser: /settings?google=<outcome>. */
export function googleOutcome(v: string | null): { tone: 'ok' | 'bad'; text: string } | null {
  switch (v) {
    case null:
    case '':
      return null;
    case 'connected':
      return { tone: 'ok', text: 'Google Calendar connected. The first sync runs within 30 minutes; choose how each calendar counts below.' };
    case 'denied':
      return { tone: 'bad', text: 'Google access was declined, so nothing was connected.' };
    case 'expired':
      return { tone: 'bad', text: 'That sign-in took too long. Connect again.' };
    case 'scope':
      return { tone: 'bad', text: 'yeackbot needs read access to your calendars. Connect again and allow “See your calendars”.' };
    default:
      return { tone: 'bad', text: 'Google Calendar couldn’t be connected. Try again in a minute.' };
  }
}
