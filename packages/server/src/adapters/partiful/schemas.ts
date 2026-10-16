/**
 * Tolerant parsing of Partiful payloads (the API is unofficial and has changed before). zod checks only what the
 * adapter can't do without: lists are arrays and their items have a string id (events, users) or a user id
 * (guests, contacts); everything else is .passthrough() and read with defensive helpers, so a new or retyped
 * field never breaks a sync. A list where most items fail is a contract break (PartifulContractError).
 * Field names (seen live 2026-10-16, key names only): home-page lists {upcomingEvents, initialPastEvents} /
 * {pastEvents}; event {id,title,status,startDate ("TBD" when unset),endDate,timezone,location (string|null),
 * ownerIds[],showGuestList,showHostList,showGuestCount,guestStatusCounts,isPublic,guest{id,eventId,userId,status}};
 * getGuests → a bare array, paged by cursor past 500, of {id,userId,name,status,rsvpDate,invitedBy,anchorGuestId,
 * plusOneCount,plusOnes,count,rsvpHistory,user}; getUsers → a bare array of {id,name,socials{instagram{value,
 * visibility}},…}; contact/mutual (research) {id|userId,name,sharedEventCount,isPastGuest,sharedEvent}.
 */
import { z } from 'zod';
import { PartifulContractError } from './errors';
import { issuePaths } from './session';

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

/** A string, or the id inside {id} / {userId} (some references are objects). */
const ref = (v: unknown): string | null => {
  if (typeof v === 'string') return str(v);
  if (typeof v === 'number') return String(v);
  if (isObj(v)) return str(v.userId) ?? str(v.id) ?? null;
  return null;
};

function at(obj: unknown, path: readonly string[]): unknown {
  let cur = obj;
  for (const k of path) {
    if (!isObj(cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

const firstString = (obj: unknown, paths: readonly (readonly string[])[]): string | null => {
  for (const p of paths) {
    const v = str(at(obj, p));
    if (v) return v;
  }
  return null;
};

/** ISO string, "TBD", epoch s/ms (number or digits), or a Firestore timestamp {_seconds|seconds}. */
export function toMs(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? (Math.abs(v) < 1e11 ? Math.round(v * 1000) : Math.round(v)) : null;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s || /^tbd$/i.test(s)) return null;
    if (/^\d+$/.test(s)) return toMs(Number(s));
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
  }
  if (isObj(v)) {
    const sec = num(v._seconds ?? v.seconds);
    if (sec !== null) return sec * 1000 + Math.round((num(v._nanoseconds ?? v.nanoseconds) ?? 0) / 1e6);
  }
  return null;
}

// ------------------------------------------------------------------------------------------- lists

/** The array inside a payload: the payload itself, one of `keys`, or its only array-valued property. */
export function listIn(fn: string, data: unknown, keys: readonly string[]): unknown[] {
  if (Array.isArray(data)) return data;
  if (isObj(data)) {
    for (const k of keys) if (Array.isArray(data[k])) return data[k] as unknown[];
    const arrays = Object.values(data).filter(Array.isArray);
    if (arrays.length === 1) return arrays[0] as unknown[];
    // An empty object / null list is a valid "nothing".
    if (keys.some((k) => data[k] === null) || Object.keys(data).length === 0) return [];
  }
  if (data === null) return [];
  throw new PartifulContractError(fn, 'no list in response');
}

/** Parses each item; throws a contract error when more than half of a non-trivial list is unreadable. */
function parseItems<T>(fn: string, items: unknown[], schema: z.ZodType, map: (v: Record<string, unknown>) => T | null): { ok: T[]; invalid: number } {
  const ok: T[] = [];
  let invalid = 0;
  let firstError: z.ZodError | null = null;
  for (const item of items) {
    const r = schema.safeParse(item);
    const v = r.success ? map(r.data as Record<string, unknown>) : null;
    if (v) ok.push(v);
    else {
      invalid++;
      if (!r.success) firstError ??= r.error;
    }
  }
  if (items.length >= 2 && invalid * 2 > items.length) {
    throw new PartifulContractError(fn, `${invalid} of ${items.length} items unreadable`, firstError ? issuePaths(firstError) : []);
  }
  return { ok, invalid };
}

// ------------------------------------------------------------------------------------------- events

const EventItem = z.object({ id: z.string().min(1).max(200) }).passthrough();

export interface MyGuest {
  status: string | null;
  invitedBy: string | null;
  anchorGuestId: string | null;
  guestId: string | null;
}

export interface ParsedEvent {
  id: string;
  title: string | null;
  description: string | null;
  /** Lowercased source status (published, canceled, draft, …). */
  status: string | null;
  canceled: boolean;
  startsAt: number | null;
  endsAt: number | null;
  tz: string | null;
  locationText: string | null;
  ownerIds: string[];
  showGuestList: boolean | null;
  showHostList: boolean | null;
  showGuestCount: boolean | null;
  visibility: string | null;
  /** guestStatusCounts with numeric values only, keys upper-cased. */
  statusCounts: Record<string, number>;
  /** GOING + APPROVED (+ checked in), or the explicit going/approved counters. */
  goingCount: number | null;
  myGuest: MyGuest | null;
  raw: Record<string, unknown>;
}

const LOCATION_PATHS = [
  ['locationDisplayText'],
  ['location'],
  ['locationInfo', 'displayName'],
  ['locationInfo', 'name'],
  ['locationInfo', 'mapsInfo', 'name'],
  ['locationInfo', 'value'],
  ['location', 'displayText'],
  ['location', 'name'],
  ['location', 'address'],
  ['address'],
] as const;

const DESCRIPTION_PATHS = [['description'], ['description', 'text'], ['descriptionText']] as const;

function counts(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isObj(v)) return out;
  for (const [k, x] of Object.entries(v)) {
    const n = num(x);
    if (n !== null && /^[A-Za-z_]{1,40}$/.test(k)) out[k.toUpperCase()] = n;
  }
  return out;
}

function myGuest(v: unknown): MyGuest | null {
  if (!isObj(v)) return null;
  return {
    status: str(v.status)?.toUpperCase() ?? null,
    invitedBy: ref(v.invitedBy) ?? ref(Array.isArray(v.invitedByUsers) ? v.invitedByUsers[0] : null),
    anchorGuestId: ref(v.anchorGuestId),
    guestId: ref(v.id),
  };
}

/** List items may be the event itself or a wrapper {event, guest}. */
function unwrapEvent(item: unknown): unknown {
  if (isObj(item) && isObj(item.event) && typeof item.event.id === 'string') {
    return { ...item.event, ...(item.guest !== undefined && item.event.guest === undefined ? { guest: item.guest } : {}) };
  }
  return item;
}

export function parseEvent(v: Record<string, unknown>): ParsedEvent | null {
  const id = str(v.id);
  if (!id || !/^[A-Za-z0-9_-]{1,200}$/.test(id)) return null;
  const status = str(v.status)?.toLowerCase() ?? null;
  const statusCounts = counts(v.guestStatusCounts);
  const fromCounts = ['GOING', 'APPROVED', 'CHECKED_IN'].some((k) => k in statusCounts)
    ? (statusCounts.GOING ?? 0) + (statusCounts.APPROVED ?? 0) + (statusCounts.CHECKED_IN ?? 0)
    : null;
  const explicit = [num(v.goingGuestCount), num(v.approvedGuestCount)].filter((n): n is number => n !== null);
  const goingCount = fromCounts ?? (explicit.length ? explicit.reduce((a, b) => a + b, 0) : null);
  const isPublic = bool(v.isPublic);
  const visibility = str(v.visibility) ?? str(v.privacy) ?? (isPublic === null ? null : isPublic ? 'public' : 'private');
  return {
    id,
    title: str(v.title)?.slice(0, 500) ?? null,
    description: firstString(v, DESCRIPTION_PATHS)?.slice(0, 20_000) ?? null,
    status,
    canceled: !!status && /cancel/.test(status),
    startsAt: toMs(v.startDate ?? v.startTime ?? v.start),
    endsAt: toMs(v.endDate ?? v.endTime ?? v.end),
    tz: str(v.timezone) ?? str(v.timeZone),
    locationText: firstString(v, LOCATION_PATHS)?.slice(0, 500) ?? null,
    ownerIds: (Array.isArray(v.ownerIds) ? v.ownerIds : []).map(ref).filter((x): x is string => !!x),
    showGuestList: bool(v.showGuestList),
    showHostList: bool(v.showHostList),
    showGuestCount: bool(v.showGuestCount),
    visibility: visibility && /^[A-Za-z_-]{1,40}$/.test(visibility) ? visibility.toLowerCase() : null,
    statusCounts,
    goingCount,
    myGuest: myGuest(v.guest),
    raw: v,
  };
}

export function parseEventList(fn: string, data: unknown): { events: ParsedEvent[]; invalid: number } {
  const items = listIn(fn, data, ['upcomingEvents', 'pastEvents', 'events', 'rsvps', 'publishedEvents', 'items', 'results']).map(unwrapEvent);
  const r = parseItems(fn, items, EventItem, parseEvent);
  return { events: r.ok, invalid: r.invalid };
}

/** getEventInfo: {event} or the event itself. */
export function parseEventInfo(fn: string, data: unknown): ParsedEvent | null {
  const obj = isObj(data) && isObj(data.event) ? { ...data.event, ...(data.guest !== undefined ? { guest: data.guest } : {}) } : data;
  if (!isObj(obj)) throw new PartifulContractError(fn, 'no event in response');
  const r = EventItem.safeParse(obj);
  if (!r.success) throw new PartifulContractError(fn, 'event without id', issuePaths(r.error));
  return parseEvent(r.data as Record<string, unknown>);
}

// ------------------------------------------------------------------------------------------- guests

const GuestItem = z.union([z.object({ userId: z.string().min(1) }).passthrough(), z.object({ id: z.string().min(1) }).passthrough()]);

/** socials.instagram: "handle" or {value, visibility} (live 2026-10-16: {value, visibility}). */
function instagramOf(socials: unknown): string | null {
  const ig = isObj(socials) ? socials.instagram : undefined;
  const v = typeof ig === 'string' ? str(ig) : isObj(ig) ? (str(ig.value) ?? str(ig.handle) ?? str(ig.username)) : null;
  return v?.slice(0, 200) ?? null;
}

export interface ParsedGuest {
  /** The guest record id within the event (anchorGuestId points at these). */
  guestId: string | null;
  /** null for invitees who aren't on Partiful (an SMS invite): no identity to attach. */
  userId: string | null;
  name: string | null;
  /** Upper-cased source status. */
  status: string | null;
  rsvpAt: number | null;
  invitedBy: string | null;
  anchorGuestId: string | null;
  plusOneCount: number | null;
  /** From the embedded `user` profile, when the guest record carries one. */
  instagram: string | null;
  /** The embedded profile includes `socials`, so no getUsers call is needed for this user. */
  hasProfile: boolean;
}

function parseGuest(v: Record<string, unknown>): ParsedGuest | null {
  const userId = ref(v.userId) ?? ref(v.user);
  const guestId = ref(v.id) ?? ref(v.guestId);
  if (!userId && !guestId) return null;
  const invitedByUsers = Array.isArray(v.invitedByUsers) ? v.invitedByUsers : [];
  return {
    guestId,
    userId: userId && /^[A-Za-z0-9_.:-]{1,128}$/.test(userId) ? userId : null,
    name: str(v.name)?.slice(0, 200) ?? str(at(v, ['user', 'name']))?.slice(0, 200) ?? null,
    status: str(v.status)?.toUpperCase() ?? null,
    rsvpAt: toMs(v.rsvpDate ?? v.rsvpedAt ?? v.updatedAt),
    invitedBy: ref(v.invitedBy) ?? ref(invitedByUsers[0]),
    anchorGuestId: ref(v.anchorGuestId),
    plusOneCount: num(v.plusOneCount),
    instagram: isObj(v.user) ? instagramOf(v.user.socials) : null,
    hasProfile: isObj(v.user) && 'socials' in v.user,
  };
}

export function parseGuestPage(fn: string, data: unknown): { guests: ParsedGuest[]; invalid: number } {
  const r = parseItems(fn, listIn(fn, data, ['guests', 'items', 'results']), GuestItem, parseGuest);
  return { guests: r.ok, invalid: r.invalid };
}

// ------------------------------------------------------------------------------------------- users

const UserItem = z.object({ id: z.string().min(1) }).passthrough();

export interface ParsedUser {
  id: string;
  name: string | null;
  /** Raw socials.instagram value (normalized later by the identity layer). */
  instagram: string | null;
}

function parseUser(v: Record<string, unknown>): ParsedUser | null {
  const id = str(v.id);
  if (!id || !/^[A-Za-z0-9_.:-]{1,128}$/.test(id)) return null;
  return { id, name: (str(v.name) ?? str(v.displayName))?.slice(0, 200) ?? null, instagram: instagramOf(v.socials) };
}

export function parseUsers(fn: string, data: unknown): { users: ParsedUser[]; invalid: number } {
  // getUsers may also answer {<id>: user, …}.
  const list =
    isObj(data) && !Object.values(data).some(Array.isArray) && Object.values(data).every((u) => isObj(u) && typeof u.id === 'string')
      ? Object.values(data)
      : listIn(fn, data, ['users', 'items', 'results']);
  const r = parseItems(fn, list, UserItem, parseUser);
  return { users: r.ok, invalid: r.invalid };
}

// ------------------------------------------------------------------------------------------- contacts / mutuals

const ContactItem = z.union([
  z.object({ userId: z.string().min(1) }).passthrough(),
  z.object({ id: z.string().min(1) }).passthrough(),
  z.object({ user: z.object({ id: z.string().min(1) }).passthrough() }).passthrough(),
]);

export interface ParsedContact {
  userId: string;
  name: string | null;
  sharedEventCount: number | null;
  isPastGuest: boolean | null;
  sharedEventId: string | null;
  sharedEventAt: number | null;
}

function parseContact(v: Record<string, unknown>): ParsedContact | null {
  const userId = ref(v.userId) ?? ref(v.user) ?? ref(v.id);
  if (!userId || !/^[A-Za-z0-9_.:-]{1,128}$/.test(userId)) return null;
  const shared = isObj(v.sharedEvent) ? v.sharedEvent : null;
  return {
    userId,
    name: (str(v.name) ?? str(at(v, ['user', 'name'])))?.slice(0, 200) ?? null,
    sharedEventCount: num(v.sharedEventCount),
    isPastGuest: bool(v.isPastGuest),
    sharedEventId: shared ? str(shared.id) : null,
    sharedEventAt: shared ? toMs(shared.startDate) : null,
  };
}

export function parseContacts(fn: string, data: unknown): { contacts: ParsedContact[]; invalid: number } {
  const r = parseItems(fn, listIn(fn, data, ['contacts', 'mutuals', 'users', 'items', 'results']), ContactItem, parseContact);
  return { contacts: r.ok, invalid: r.invalid };
}

// ------------------------------------------------------------------------------------------- statuses

export type AttendeeStatus = 'going' | 'approved' | 'maybe' | 'declined' | 'invited' | 'waitlist' | 'checked_in';

const STATUS_MAP: Record<string, AttendeeStatus> = {
  GOING: 'going',
  APPROVED: 'approved',
  CHECKED_IN: 'checked_in',
  ATTENDED: 'checked_in',
  MAYBE: 'maybe',
  INTERESTED: 'maybe',
  DECLINED: 'declined',
  CANT_GO: 'declined',
  NOT_GOING: 'declined',
  REJECTED: 'declined', // host turned an application down; 'rejected' is the undo tombstone in event_attendees
  WITHDRAWN: 'declined',
  REMOVED: 'declined',
  SENT: 'invited',
  INVITED: 'invited',
  READY_TO_SEND: 'invited',
  SENDING: 'invited',
  SEND_ERROR: 'invited',
  DELIVERY_ERROR: 'invited',
  RESPONDED_TO_FIND_A_TIME: 'invited',
  PENDING: 'invited',
  WAITLIST: 'waitlist',
  WAITLISTED: 'waitlist',
  PENDING_APPROVAL: 'waitlist',
  WAITLISTED_FOR_APPROVAL: 'waitlist',
};

/** Partiful RSVP status → event_attendees.status; unknown statuses count as invited (and are reported). */
export function mapGuestStatus(s: string | null): { status: AttendeeStatus; known: boolean } {
  const m = s ? STATUS_MAP[s.toUpperCase()] : undefined;
  return m ? { status: m, known: true } : { status: 'invited', known: false };
}

/** Attendance strength s (intelligence §2 co_attend). */
export function attendanceWeight(status: string): number {
  switch (status) {
    case 'going':
    case 'approved':
    case 'checked_in':
    case 'attended':
    case 'host':
      return 1;
    case 'maybe':
      return 0.5;
    case 'invited':
    case 'waitlist':
      return 0.2;
    default:
      return 0;
  }
}
