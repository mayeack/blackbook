/**
 * Occasion merge (PLAN step 1): calendar copies of one real-world happening become one occasion.
 *   - copies of the same instance on several calendars (same iCal UID or same title, ±90 min);
 *   - the same normalized venue within ±90 min (a Gmail "Reservation at <venue>" next to the owner's own event;
 *     two own events with different titles need ±30 min);
 *   - a reservation next to an own event that has no venue;
 *   - the same Partiful id (a partiful.com/e/<id> link, or the subscribed feed's UID), which also links the
 *     occasion to events(source='partiful').
 * Ticket copies (tickets.ts: ticket_events rows the owner holds) join after the calendar copies cluster, at most
 * one per cluster; an unmatched one is a ticket-only occasion (occasion_sources.source 'ticket').
 * occasions and occasion_sources are derived (rebuilt every run) but ids are stable: a cluster keeps the occasion
 * its calendar events or ticket already belong to (copies are keyed by (source, id) everywhere), two occasions
 * that turn out to be one are pointer-merged (merged_into_id), and an occasion whose copies disappear (or whose
 * ticket was sold, given away or cancelled) is cancelled/excluded rather than deleted, so the journaled attendee
 * rows that point at it never dangle.
 */
import { addDays, localDate, uuidv7 } from '@yb/shared';
import { z } from 'zod';
import type { DB } from '../../db/connection';
import { tx } from '../../db/tx';
import { primaryCalendars, type CalendarTreatment } from './calendars';
import { classifyOccasion, type Classification, type OccasionKind } from './classify';
import { parseMentions, partifulIdFromUid, partifulIdsIn, plainText, reservationVenue, venueFromTitle, venueKey, ticketCount, words, type Mention } from './text';
import type { TicketCopy } from './tickets';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WINDOW = 90 * MIN;
const DEFAULT_LENGTH = 2 * HOUR;

/** calendar_events.attendees: the calendar adapter's {email, name, status, self, …}, or Google's own field names. */
const Attendee = z
  .object({
    email: z.string().max(320).nullish(),
    emailAddress: z.string().max(320).nullish(),
    displayName: z.string().max(200).nullish(),
    name: z.string().max(200).nullish(),
    responseStatus: z.string().max(40).nullish(),
    status: z.string().max(40).nullish(),
    self: z.boolean().nullish(),
    organizer: z.boolean().nullish(),
    resource: z.boolean().nullish(),
  })
  .passthrough();

export interface ExplicitAttendee {
  email: string | null;
  name: string | null;
  /** accepted | tentative | needsAction | declined (Google's vocabulary; EventKit statuses are mapped). */
  response: 'accepted' | 'tentative' | 'needsAction' | 'declined';
  calEventId: string;
}

export type CopySource = 'calendar' | 'ticket';

export interface CalEvent {
  /** calendar_events.id, or the surviving ticket_events.id of a ticket copy. */
  id: string;
  source: CopySource;
  /** '' for a ticket copy. */
  calendarId: string;
  treatment: Exclude<CalendarTreatment, 'excluded'>;
  title: string;
  notes: string;
  location: string;
  venue: string;
  venueKey: string;
  titleKey: string;
  startsAt: number;
  endsAt: number;
  allDay: boolean;
  icalUid: string | null;
  /** All-day events: the calendar's own dates (YYYY-MM-DD, end exclusive), when the adapter stored them. */
  dates: { start: string; end: string } | null;
  partifulIds: string[];
  reservation: boolean;
  /** Google put it on the calendar from a Gmail message (eventType 'fromGmail'). */
  fromGmail: boolean;
  selfDeclined: boolean;
  attendees: ExplicitAttendee[];
  /** On its own, this event classifies as social (a reservation next to it is the same evening). */
  social: boolean;
  /** Its own rule kind (a ticket copy is 'social'). */
  kind: OccasionKind;
  /** The ledger row behind a ticket copy; null for calendar copies. */
  ticket: TicketCopy | null;
  /** The recurring series it is an instance of, when that series is on a calendar other than the owner's own. */
  series: string | null;
}

/** A copy's key in claims, roles and keep-sets: ids of different sources never collide. */
export const copyKey = (e: Pick<CalEvent, 'source' | 'id'>): string => `${e.source}:${e.id}`;

interface CalRow {
  id: string;
  calendar_id: string;
  ical_uid: string | null;
  status: string;
  summary: string | null;
  description: string | null;
  location: string | null;
  starts_at: number;
  ends_at: number | null;
  all_day: number;
  creator_email: string | null;
  attendees: string;
  html_link: string | null;
  partiful_event_id: string | null;
  event_type: string | null;
  self_response: string | null;
  start_date: string | null;
  end_date: string | null;
  recurring_event_id: string | null;
}

const RESPONSE: Record<string, ExplicitAttendee['response']> = {
  accepted: 'accepted',
  tentative: 'tentative',
  needsaction: 'needsAction',
  declined: 'declined',
  // EventKit (collector) participant statuses
  pending: 'needsAction',
  unknown: 'needsAction',
  invited: 'needsAction',
  delegated: 'tentative',
  completed: 'accepted',
  inprocess: 'tentative',
};

function parseAttendees(raw: string, calEventId: string): { list: ExplicitAttendee[]; selfDeclined: boolean } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { list: [], selfDeclined: false };
  }
  const parsed = z.array(Attendee).safeParse(json);
  if (!parsed.success) return { list: [], selfDeclined: false };
  let selfDeclined = false;
  const list: ExplicitAttendee[] = [];
  for (const a of parsed.data) {
    const response = RESPONSE[(a.responseStatus ?? a.status ?? 'needsAction').toLowerCase().replace(/[^a-z]/g, '')] ?? 'needsAction';
    if (a.self) {
      selfDeclined = response === 'declined';
      continue;
    }
    if (a.resource) continue;
    const email = a.email ?? a.emailAddress ?? null;
    const name = a.displayName ?? a.name ?? null;
    if (!email && !name) continue;
    list.push({ email, name, response, calEventId });
  }
  return { list, selfDeclined };
}

const titleKey = (t: string) => words(t).join(' ');

/** Calendar events in [from, to] on non-excluded calendars, ready for clustering. Cancelled ones are left out. */
export function loadCalendarEvents(db: DB, treatments: ReadonlyMap<string, CalendarTreatment>, from: number, to: number): CalEvent[] {
  // event_type / self_response / start_date / end_date are the calendar adapter's columns (008); older rows only
  // have Google's eventType inside raw.
  const cols = new Set(db.prepare(`SELECT name FROM pragma_table_info('calendar_events')`).pluck().all() as string[]);
  const col = (name: string, fallback: string) => (cols.has(name) ? name : fallback);
  const rows = db
    .prepare(
      `SELECT id, calendar_id, ical_uid, status, summary, description, location, starts_at, ends_at, all_day, creator_email,
              attendees, html_link, partiful_event_id,
              coalesce(${col('event_type', 'NULL')}, CASE WHEN json_valid(raw) THEN json_extract(raw, '$.eventType') END) AS event_type,
              ${col('self_response', 'NULL')} AS self_response, ${col('start_date', 'NULL')} AS start_date, ${col('end_date', 'NULL')} AS end_date,
              recurring_event_id
       FROM calendar_events
       WHERE starts_at IS NOT NULL AND starts_at BETWEEN ? AND ? AND status <> 'cancelled'
       ORDER BY starts_at, id`,
    )
    .all(from, to) as CalRow[];
  const own = primaryCalendars(db);
  const out: CalEvent[] = [];
  for (const r of rows) {
    const treatment = treatments.get(r.calendar_id) ?? 'attending';
    if (treatment === 'excluded') continue;
    const title = (r.summary ?? '').trim();
    const notes = plainText(r.description);
    const resVenue = reservationVenue(title);
    const location = (r.location ?? '').trim();
    const venue = location || resVenue || venueFromTitle(title) || '';
    const parsed = parseAttendees(r.attendees, r.id);
    const list = parsed.list;
    const selfDeclined = r.self_response ? r.self_response === 'declined' : parsed.selfDeclined;
    const ids = [
      ...(r.partiful_event_id ? [r.partiful_event_id] : []),
      ...(partifulIdFromUid(r.ical_uid) ? [partifulIdFromUid(r.ical_uid)!] : []),
      ...partifulIdsIn(r.description, r.location, r.html_link),
    ];
    const allDay = r.all_day === 1;
    const endsAt = r.ends_at && r.ends_at > r.starts_at ? r.ends_at : r.starts_at + (allDay ? DAY : DEFAULT_LENGTH);
    const partifulIds = [...new Set(ids)];
    const rule = classifyOccasion({
      titles: [title],
      notes: [notes],
      location: location || null,
      allDay,
      startsAt: r.starts_at,
      endsAt,
      hasPartiful: partifulIds.length > 0,
      hasReservation: false,
      mentions: parseMentions(title, notes),
      explicitAttendees: list.length,
    });
    out.push({
      id: r.id,
      source: 'calendar',
      calendarId: r.calendar_id,
      treatment,
      title,
      notes,
      location,
      venue,
      venueKey: venueKey(venue),
      titleKey: titleKey(title),
      startsAt: r.starts_at,
      endsAt,
      allDay,
      icalUid: r.ical_uid,
      dates: allDay && r.start_date && r.end_date ? { start: r.start_date, end: r.end_date } : null,
      partifulIds,
      reservation: resVenue !== null || r.event_type === 'fromGmail',
      fromGmail: r.event_type === 'fromGmail',
      selfDeclined,
      attendees: list,
      social: rule.isSocial,
      kind: rule.kind,
      ticket: null,
      series: r.recurring_event_id && !own.has(r.calendar_id) ? `${r.calendar_id}|${r.recurring_event_id}` : null,
    });
  }
  return out;
}

class UnionFind {
  private readonly parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]!]!;
      i = this.parent[i]!;
    }
    return i;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
}

function sameOccasion(a: CalEvent, b: CalEvent): boolean {
  if (a.allDay !== b.allDay) return false;
  const dt = Math.abs(a.startsAt - b.startsAt);
  if (a.allDay ? dt >= DAY : dt > WINDOW) return false;
  if (a.icalUid && a.icalUid === b.icalUid && a.calendarId !== b.calendarId) return true;
  if (a.titleKey && a.titleKey === b.titleKey && a.calendarId !== b.calendarId) return true;
  if (a.venueKey && a.venueKey === b.venueKey) {
    if (a.reservation || b.reservation || a.treatment === 'feed' || b.treatment === 'feed' || a.titleKey === b.titleKey) return true;
    return dt <= 30 * MIN;
  }
  const [res, own] = a.reservation ? [a, b] : b.reservation ? [b, a] : [null, null];
  return !!res && !!own && !own.reservation && !own.venueKey && own.treatment === 'attending' && own.social;
}

/** Groups events into occasions (indices into `events`, each cluster sorted by start). Pure. */
export function clusterEvents(events: readonly CalEvent[]): CalEvent[][] {
  const uf = new UnionFind(events.length);
  for (let i = 0; i < events.length; i++) {
    for (let j = i + 1; j < events.length && events[j]!.startsAt - events[i]!.startsAt <= DAY; j++) {
      if (sameOccasion(events[i]!, events[j]!)) uf.union(i, j);
    }
  }
  const byPartiful = new Map<string, number>();
  events.forEach((e, i) => {
    for (const pid of e.partifulIds) {
      const prev = byPartiful.get(pid);
      if (prev === undefined) byPartiful.set(pid, i);
      else if (Math.abs(events[prev]!.startsAt - e.startsAt) <= 36 * HOUR) uf.union(prev, i);
    }
  });
  const groups = new Map<number, CalEvent[]>();
  events.forEach((e, i) => {
    const root = uf.find(i);
    groups.set(root, [...(groups.get(root) ?? []), e]);
  });
  return [...groups.values()];
}

// ------------------------------------------------------------------------------------------------ drafts

export type SourceRole = 'primary' | 'duplicate' | 'reservation' | 'feed_copy';

export interface OccasionDraft {
  events: CalEvent[];
  primary: CalEvent;
  /** By copyKey (source:id). */
  roles: Map<string, SourceRole>;
  treatment: Exclude<CalendarTreatment, 'excluded'>;
  title: string;
  startsAt: number;
  endsAt: number;
  allDay: boolean;
  venueText: string | null;
  venueKey: string | null;
  partifulId: string | null;
  /** events.id of the linked Partiful event, if it has been ingested. */
  eventId: string | null;
  eventTitle: string | null;
  selfDeclined: boolean;
  mentions: Mention[];
  attendees: ExplicitAttendee[];
  /** The calendar text's count, else the ticket copy's (bought + received − sold − refunded). */
  ticketCount: number | null;
  classification: Classification;
  /** The ticket the owner holds for it (a cluster has at most one ticket copy). */
  ticket: TicketCopy | null;
  /** Gmail-made copies of a show whose tickets he sold, gave away or lost: the occasion is 'excluded'. */
  ticketReleased: boolean;
}

const TREATMENT_RANK: Record<string, number> = { attending: 3, feed: 2, candidate: 1 };
/** A ticket copy ranks under the owner's own event and over feed copies, shared calendars and reservations. */
const TICKET_RANK = 2.9;

function primaryOf(events: CalEvent[]): CalEvent {
  const score = (e: CalEvent) =>
    e.source === 'ticket'
      ? TICKET_RANK
      : (TREATMENT_RANK[e.treatment] ?? 0) - (e.reservation ? 2.5 : 0) + (e.notes ? 0.5 : 0) + (e.partifulIds.length ? 0.25 : 0);
  return [...events].sort((a, b) => score(b) - score(a) || a.startsAt - b.startsAt || (a.id < b.id ? -1 : 1))[0]!;
}

function mergeMentions(events: CalEvent[]): Mention[] {
  const out: Mention[] = [];
  const seen = new Map<string, number>();
  for (const e of events) {
    // a vendor's title names performers ("Fern & The Lanterns"), never the owner's companions
    if (e.reservation || e.source === 'ticket') continue;
    for (const m of parseMentions(e.title, e.notes)) {
      const k = `${m.norm}|${m.role}`;
      const at = seen.get(k);
      if (at === undefined) {
        seen.set(k, out.length);
        out.push(m);
      } else if (m.where === 'title' && out[at]!.where !== 'title') out[at] = m;
    }
  }
  return out;
}

export function draftOccasion(db: DB, events: CalEvent[], o: { ticketReleased?: boolean } = {}): OccasionDraft {
  const primary = primaryOf(events);
  const sorted = [primary, ...events.filter((e) => e !== primary).sort((a, b) => a.startsAt - b.startsAt || (a.id < b.id ? -1 : 1))];
  const roles = new Map<string, SourceRole>();
  for (const e of sorted) roles.set(copyKey(e), e === primary ? 'primary' : e.reservation ? 'reservation' : e.treatment === 'feed' ? 'feed_copy' : 'duplicate');
  const ticket = sorted.find((e) => e.ticket !== null)?.ticket ?? null;
  const calendarCopies = sorted.filter((e) => e.source === 'calendar');
  const treatment = sorted.some((e) => e.treatment === 'attending') ? 'attending' : sorted.some((e) => e.treatment === 'feed') ? 'feed' : 'candidate';
  const partifulId = sorted.flatMap((e) => e.partifulIds)[0] ?? null;
  const ev = partifulId
    ? (db.prepare(`SELECT id, title, location_text FROM events WHERE source = 'partiful' AND source_event_id = ?`).get(partifulId) as
        | { id: string; title: string | null; location_text: string | null }
        | undefined)
    : undefined;
  const venueText = primary.location || sorted.find((e) => e.reservation && e.venue)?.venue || sorted.find((e) => e.location)?.location || ev?.location_text || primary.venue || null;
  const mentions = mergeMentions(sorted);
  const attendees = new Map<string, ExplicitAttendee>();
  for (const e of sorted) for (const a of e.attendees) attendees.set((a.email ?? `name:${a.name}`).toLowerCase(), a);
  const title = primary.reservation && ev?.title ? ev.title : primary.title;
  const attending = sorted.filter((e) => e.treatment !== 'candidate');
  const classification = classifyOccasion({
    titles: [title, ...sorted.filter((e) => e !== primary && !e.reservation).map((e) => e.title)],
    notes: sorted.map((e) => e.notes).filter(Boolean),
    location: venueText,
    allDay: primary.allDay,
    startsAt: primary.startsAt,
    endsAt: primary.endsAt,
    hasPartiful: partifulId !== null,
    hasReservation: sorted.some((e) => e.reservation),
    mentions,
    explicitAttendees: attendees.size,
    ...(ticket ? { ticketCategory: ticket.category } : {}),
  });
  return {
    events: sorted,
    primary,
    roles,
    treatment,
    title,
    startsAt: primary.startsAt,
    endsAt: primary.endsAt,
    allDay: primary.allDay,
    venueText,
    venueKey: venueKey(venueText) || null,
    partifulId,
    eventId: ev?.id ?? null,
    eventTitle: ev?.title ?? null,
    selfDeclined: attending.length > 0 && attending.every((e) => e.selfDeclined),
    mentions,
    attendees: [...attendees.values()],
    ticketCount: ticketCount(...calendarCopies.flatMap((e) => [e.title, e.notes])) ?? ticket?.count ?? null,
    classification,
    ticket,
    ticketReleased: o.ticketReleased === true,
  };
}

/**
 * Local dates an occasion covers. All-day events use the calendar's own dates when known (end exclusive), else
 * their UTC dates when stored at UTC midnight.
 */
export function occasionDays(startsAt: number, endsAt: number, allDay: boolean, timeZone?: string, dates?: { start: string; end: string } | null): Set<string> {
  const out = new Set<string>();
  if (allDay && dates) {
    for (let d = dates.start; d < dates.end && out.size < 31; d = addDays(d, 1)) out.add(d);
    if (out.size) return out;
  }
  const utc = allDay && startsAt % DAY === 0;
  const dateOf = (ms: number) => (utc ? new Date(ms).toISOString().slice(0, 10) : localDate(ms, timeZone));
  const last = Math.max(startsAt, endsAt - 1);
  for (let t = startsAt; t <= last && out.size < 31; t += 12 * HOUR) out.add(dateOf(t));
  out.add(dateOf(last));
  return out;
}

// ------------------------------------------------------------------------------------------------ sync

export interface OccasionRow {
  id: string;
  kind: string;
  title: string | null;
  starts_at: number;
  ends_at: number | null;
  all_day: number;
  venue_text: string | null;
  venue_key: string | null;
  event_id: string | null;
  is_social: number | null;
  sensitive: number;
  corroborated: number;
  classified_by: string | null;
  classification_confidence: number | null;
  ticket_count: number | null;
  status: string;
  merged_into_id: string | null;
  calendar_treatment: string | null;
  classification_rule: string | null;
  candidate_count: number;
  inferred_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface SyncedOccasion {
  id: string;
  draft: OccasionDraft;
  /** Kind/social/sensitive as stored (an LLM or user classification wins over the rules). */
  kind: string;
  isSocial: boolean;
  sensitive: boolean;
  created: boolean;
}

export interface SyncStats {
  created: number;
  updated: number;
  merged: number;
  retired: number;
}

/** Follows merged_into_id to the surviving occasion. */
export function survivingOccasion(db: DB, id: string): string {
  const next = db.prepare('SELECT merged_into_id FROM occasions WHERE id = ?').pluck();
  const seen = new Set<string>();
  let cur = id;
  for (;;) {
    const m = next.get(cur) as string | null | undefined;
    if (!m || seen.has(m)) return cur;
    seen.add(cur);
    cur = m;
  }
}

/** Every occasion id whose merge chain ends at `id` (itself included). */
export function occasionChain(db: DB, id: string): string[] {
  const out = [id];
  const children = db.prepare('SELECT id FROM occasions WHERE merged_into_id = ?').pluck();
  for (let i = 0; i < out.length && out.length < 1000; i++) out.push(...(children.all(out[i]) as string[]));
  return out;
}

/** occasion_sources refs that stand for a copy: its id, plus (ticket copies) the ledger rows merged into it. */
const refsOf = (e: CalEvent): string[] => (e.ticket ? [e.id, ...e.ticket.aliases] : [e.id]);

/**
 * Writes the drafts: stable ids, pointer merges, occasion_sources rewritten per cluster, changed columns only
 * (a re-run over unchanged calendars and tickets writes nothing). Copies are keyed by (source, id) everywhere;
 * a ticket copy also claims through the ledger rows merged into it, and those stale refs are rewritten to the
 * survivor. Occasions in [from, to] whose copies are gone become 'cancelled' (or 'excluded' when their calendar is
 * now excluded, or its synced events were deleted: the calendar adapter never deletes an event Google cancelled,
 * only an excluded or removed calendar's events, and on disconnect). A ticket-only occasion whose ticket was sold,
 * given away, refunded or cancelled is 'cancelled' that way; one still backed by a calendar copy stays. The status
 * of a live occasion is settled by the run (corroboration needs messages); a new one starts 'active', 'candidate'
 * or 'excluded' (the owner declined, or a released ticket retired its Gmail-made copy). A live ticket source lets
 * the rules override an LLM classification (never the user's).
 */
export function syncOccasions(
  db: DB,
  drafts: OccasionDraft[],
  o: { now: number; from: number; to: number; excludedCalendars: ReadonlySet<string> },
): { occasions: SyncedOccasion[]; stats: SyncStats } {
  return tx(db, () => {
    const stats: SyncStats = { created: 0, updated: 0, merged: 0, retired: 0 };
    const sourceOf = db.prepare(`SELECT occasion_id FROM occasion_sources WHERE source = ? AND source_ref = ?`).pluck();
    const roleOf = db.prepare(`SELECT role FROM occasion_sources WHERE source = ? AND source_ref = ?`).pluck();
    const getOcc = db.prepare('SELECT * FROM occasions WHERE id = ?');

    // 1. which existing occasions each cluster claims (through merge chains): overlap, and whether it holds the
    //    occasion's primary copy (on a split, that half keeps the id)
    const claims: { cluster: number; occ: string; overlap: number; primary: number; createdAt: number }[] = [];
    drafts.forEach((d, cluster) => {
      const counts = new Map<string, { overlap: number; primary: number }>();
      for (const e of d.events) {
        const mine = new Map<string, number>();
        for (const ref of refsOf(e)) {
          const occ = sourceOf.get(e.source, ref) as string | undefined;
          if (!occ) continue;
          const s = survivingOccasion(db, occ);
          mine.set(s, Math.max(mine.get(s) ?? 0, roleOf.get(e.source, ref) === 'primary' ? 1 : 0));
        }
        for (const [s, primary] of mine) {
          const c = counts.get(s) ?? { overlap: 0, primary: 0 };
          c.overlap++;
          if (primary) c.primary = 1;
          counts.set(s, c);
        }
      }
      for (const [occ, c] of counts) claims.push({ cluster, occ, ...c, createdAt: (getOcc.get(occ) as OccasionRow).created_at });
    });
    const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    claims.sort((a, b) => b.primary - a.primary || b.overlap - a.overlap || a.createdAt - b.createdAt || cmp(a.occ, b.occ) || a.cluster - b.cluster);
    const idOf = new Map<number, string>();
    const taken = new Set<string>();
    for (const c of claims) {
      if (idOf.has(c.cluster) || taken.has(c.occ)) continue;
      idOf.set(c.cluster, c.occ);
      taken.add(c.occ);
    }
    // a claimed occasion nobody kept is absorbed by the cluster that overlaps it most
    const absorbed = new Map<string, string>();
    for (const c of claims) if (!taken.has(c.occ) && !absorbed.has(c.occ) && idOf.has(c.cluster)) absorbed.set(c.occ, idOf.get(c.cluster)!);

    const insertOcc = db.prepare(
      `INSERT INTO occasions (id, kind, title, starts_at, ends_at, all_day, venue_text, venue_key, event_id, is_social, sensitive,
         corroborated, classified_by, classification_confidence, ticket_count, status, calendar_treatment, classification_rule,
         created_at, updated_at)
       VALUES (@id, @kind, @title, @starts_at, @ends_at, @all_day, @venue_text, @venue_key, @event_id, @is_social, @sensitive,
         @corroborated, 'rule', @classification_confidence, @ticket_count, @status, @calendar_treatment, @classification_rule, @now, @now)`,
    );
    const delSources = db.prepare(`DELETE FROM occasion_sources WHERE source = ? AND source_ref = ?`);
    const delOccSources = db.prepare(`DELETE FROM occasion_sources WHERE occasion_id = ?`);
    const insSource = db.prepare(
      `INSERT INTO occasion_sources (occasion_id, source, source_ref, role, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (occasion_id, source, source_ref) DO UPDATE SET role = excluded.role WHERE role IS NOT excluded.role`,
    );
    const partifulOwner = db.prepare(`SELECT occasion_id FROM occasion_sources WHERE source = 'partiful' AND source_ref = ?`).pluck();
    const existingSources = db.prepare(`SELECT source, source_ref, role FROM occasion_sources WHERE occasion_id = ? ORDER BY source, source_ref`);

    const out: SyncedOccasion[] = [];
    drafts.forEach((d, cluster) => {
      const c = d.classification;
      const excluded = d.selfDeclined || d.ticketReleased;
      let id = idOf.get(cluster);
      const created = !id;
      const base = {
        title: d.title || null,
        starts_at: d.startsAt,
        ends_at: d.endsAt,
        all_day: d.allDay ? 1 : 0,
        venue_text: d.venueText,
        venue_key: d.venueKey,
        event_id: d.eventId,
        ticket_count: d.ticketCount,
        calendar_treatment: d.treatment,
      };
      if (!id) {
        id = uuidv7(o.now);
        insertOcc.run({
          id,
          kind: c.kind,
          is_social: c.isSocial ? 1 : 0,
          sensitive: c.sensitive ? 1 : 0,
          corroborated: d.treatment === 'candidate' ? 0 : 1,
          classification_confidence: c.confidence,
          classification_rule: c.rule,
          status: excluded ? 'excluded' : d.treatment === 'candidate' ? 'candidate' : 'active',
          ...base,
          now: o.now,
        });
        stats.created++;
      } else {
        const cur = getOcc.get(id) as OccasionRow;
        const ruled = cur.classified_by === null || cur.classified_by === 'rule' || (cur.classified_by === 'llm' && d.ticket !== null);
        const patch: Record<string, unknown> = { ...base, merged_into_id: null };
        if (ruled) {
          Object.assign(patch, {
            kind: c.kind,
            is_social: c.isSocial ? 1 : 0,
            sensitive: c.sensitive ? 1 : 0,
            classified_by: 'rule',
            classification_confidence: c.confidence,
            classification_rule: c.rule,
          });
        }
        if (updateChanged(db, id, cur, patch, o.now)) stats.updated++;
      }

      // sources: this cluster's calendar events and ticket (moved from wherever they were; a merged ticket row's
      // ref becomes its survivor's) + the linked Partiful event
      const before = JSON.stringify(existingSources.all(id));
      for (const e of d.events) {
        for (const ref of refsOf(e)) {
          const owner = sourceOf.get(e.source, ref) as string | undefined;
          if (owner && (owner !== id || ref !== e.id)) delSources.run(e.source, ref);
        }
        insSource.run(id, e.source, e.id, d.roles.get(copyKey(e))!, o.now);
      }
      if (d.eventId) {
        const owner = partifulOwner.get(d.eventId) as string | undefined;
        if (!owner || survivingOccasion(db, owner) !== id) {
          if (owner) delSources.run('partiful', d.eventId);
          insSource.run(id, 'partiful', d.eventId, 'duplicate', o.now);
        }
      }
      // calendar and ticket rows of this occasion that are no longer in the cluster go (their event moved or
      // vanished, or the owner no longer holds the ticket)
      const keep = new Set(d.events.map(copyKey));
      for (const s of existingSources.all(id) as { source: string; source_ref: string }[]) {
        if ((s.source === 'calendar' || s.source === 'ticket') && !keep.has(`${s.source}:${s.source_ref}`)) delSources.run(s.source, s.source_ref);
        if (s.source === 'partiful' && s.source_ref !== d.eventId) delSources.run('partiful', s.source_ref);
      }
      if (!created && JSON.stringify(existingSources.all(id)) !== before) touch(db, id, o.now);

      const row = getOcc.get(id) as OccasionRow;
      out.push({ id, draft: d, kind: row.kind, isSocial: row.is_social === 1, sensitive: row.sensitive === 1, created });
    });

    // absorbed occasions point at their survivor and give up their sources
    for (const [occ, survivor] of absorbed) {
      const cur = getOcc.get(occ) as OccasionRow;
      if (cur.merged_into_id === survivor) continue;
      db.prepare('UPDATE occasions SET merged_into_id = ?, updated_at = ? WHERE id = ?').run(survivor, o.now, occ);
      delOccSources.run(occ);
      stats.merged++;
    }

    // occasions in range that no cluster claimed: their events were cancelled, deleted or excluded, or the owner
    // no longer holds the ticket (excluded_src counts calendar rows only, so a ticket-only one is 'cancelled')
    const live = new Set(out.map((x) => x.id));
    const orphans = db
      .prepare(
        `SELECT o.*, (SELECT count(*) FROM occasion_sources s LEFT JOIN calendar_events ce ON ce.id = s.source_ref
                      WHERE s.occasion_id = o.id AND s.source = 'calendar'
                        AND (ce.id IS NULL OR ce.calendar_id IN (SELECT value FROM json_each(@ex)))) AS excluded_src
         FROM occasions o
         WHERE o.merged_into_id IS NULL AND o.starts_at BETWEEN @from AND @to AND o.status NOT IN ('cancelled')
           AND EXISTS (SELECT 1 FROM occasion_sources s WHERE s.occasion_id = o.id AND s.source IN ('calendar', 'ticket'))`,
      )
      .all({ from: o.from, to: o.to, ex: JSON.stringify([...o.excludedCalendars]) }) as (OccasionRow & { excluded_src: number })[];
    for (const occ of orphans) {
      if (live.has(occ.id)) continue;
      const status = occ.excluded_src > 0 ? 'excluded' : 'cancelled';
      if (occ.status === status || occ.classified_by === 'user') continue;
      db.prepare('UPDATE occasions SET status = ?, updated_at = ? WHERE id = ?').run(status, o.now, occ.id);
      stats.retired++;
    }
    return { occasions: out, stats };
  });
}

function touch(db: DB, id: string, now: number) {
  db.prepare('UPDATE occasions SET updated_at = ? WHERE id = ?').run(now, id);
}

/** Updates only columns whose value changes; true if anything did. */
export function updateChanged(db: DB, id: string, cur: object, patch: Record<string, unknown>, now: number): boolean {
  const row = cur as Record<string, unknown>;
  const changed = Object.entries(patch).filter(([k, v]) => (row[k] ?? null) !== (v ?? null));
  if (!changed.length) return false;
  const cols = changed.map(([k]) => `"${k}" = ?`).join(', ');
  db.prepare(`UPDATE occasions SET ${cols}, updated_at = ? WHERE id = ?`).run(...changed.map(([, v]) => v ?? null), now, id);
  return true;
}
