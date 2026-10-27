/**
 * Free nights for event picks (design docs/design/event-picks.md §2): the owner asked for events only "where I have
 * no event that night in my calendar". A night (local date D) is busy when, in the evening window
 * [D 18:00, D+1 03:00) local, there is any of:
 *
 *   calendar   a timed calendar event he hasn't declined, not cancelled, not marked "free" (transparency
 *              'transparent'), on an included calendar. On a non-primary calendar ('classify' treatment) a
 *              recurring instance with no invitees is a listing ("Recurring Events": a weekly wine tasting the
 *              calendar says happens, not that he goes) and doesn't count;
 *   away       an all-day calendar event spanning two days or more that covers D (a trip, a stay, a visit), or a
 *              flight that day;
 *   tickets    a ticket event he holds that night (ticket_events 'holding');
 *   partiful   a Partiful event he's going to / maybe / hosting that night.
 *
 * Single all-day entries (birthdays, reminders) don't block a night. Pure reader.
 */
import { addDays, localDate } from '@yb/shared';
import type { DB } from '../../db/connection';
import { DAY, dayStart, HOUR, PARTIFUL_ATTENDING_SQL } from '../common';

export type BusyReason = 'calendar' | 'away' | 'tickets' | 'partiful';

export interface Night {
  /** Local date (YYYY-MM-DD). */
  date: string;
  free: boolean;
  /** Why it is busy (first match, in the order above); null when free. */
  reason: BusyReason | null;
}

/**
 * The evening window: 18:00 that day to 03:00 the next (late club nights end after midnight). An afternoon plan that
 * ends by 18:00 (a 4–6 pm birthday hang) leaves the night free.
 */
export const EVENING = { fromHour: 18, toHour: 27 } as const;

/** A busy stretch of time (ms). */
export interface Span {
  start: number;
  end: number;
}

/**
 * Timed calendar plans overlapping [from, to): not declined, not cancelled, not marked "free", and not a listing (a
 * recurring entry with no invitees on a non-primary calendar: his "Recurring Events" calendar says it happens, not
 * that he goes).
 */
export function calendarPlans(db: DB, from: number, to: number): Span[] {
  const timed = db
    .prepare(
      `SELECT e.starts_at, e.ends_at, e.treatment, e.recurring_event_id, e.attendees, json_extract(e.raw, '$.transparency') AS transparency
       FROM calendar_events_included e
       WHERE e.all_day = 0 AND e.status <> 'cancelled' AND coalesce(e.self_response, '') <> 'declined'
         AND e.starts_at < @to AND coalesce(e.ends_at, e.starts_at + ${HOUR}) > @from`,
    )
    .all({ from, to }) as {
    starts_at: number;
    ends_at: number | null;
    treatment: string;
    recurring_event_id: string | null;
    attendees: string | null;
    transparency: string | null;
  }[];
  return timed
    .filter((e) => e.transparency !== 'transparent' && !isListing(e))
    .map((e) => ({ start: e.starts_at, end: e.ends_at ?? e.starts_at + HOUR }));
}

/** A calendar row that lists a happening rather than plans one (see calendarPlans). */
export const isListing = (e: { treatment: string; recurring_event_id: string | null; attendees: string | null }): boolean =>
  e.treatment !== 'attending' && !!e.recurring_event_id && !hasInvitees(e.attendees);

/** Partiful events he's going to / maybe / hosting that start in [from - 1 day, to) (no end time = 2 hours). */
export function partifulSpans(db: DB, from: number, to: number): Span[] {
  const rows = db
    .prepare(`SELECT e.starts_at, e.ends_at FROM events e WHERE e.source = 'partiful' AND ${PARTIFUL_ATTENDING_SQL} AND e.starts_at >= @from AND e.starts_at < @to`)
    .all({ from: from - DAY, to }) as { starts_at: number; ends_at: number | null }[];
  return rows.map((e) => ({ start: e.starts_at, end: e.ends_at && e.ends_at > e.starts_at ? e.ends_at : e.starts_at + 2 * HOUR }));
}

/** Local dates from..from+days-1 with whether each night is free. */
export function nightsOf(db: DB, from: string, days: number, timeZone: string): Night[] {
  const out: Night[] = [];
  const windowFrom = dayStart(from, timeZone);
  const windowTo = dayStart(addDays(from, days + 1), timeZone);
  const plans = calendarPlans(db, windowFrom, windowTo);
  const allDay = db
    .prepare(
      `SELECT e.start_date, e.end_date FROM calendar_events_included e
       WHERE e.all_day = 1 AND e.status <> 'cancelled' AND coalesce(e.self_response, '') <> 'declined'
         AND e.start_date IS NOT NULL AND e.end_date IS NOT NULL AND e.start_date < @toDate AND e.end_date > @fromDate`,
    )
    .all({ fromDate: from, toDate: addDays(from, days) }) as { start_date: string; end_date: string }[];
  // Google's all-day end date is exclusive: a two-night stay is start..start+2.
  const stays = allDay.filter((e) => e.end_date >= addDays(e.start_date, 2));
  const flights = db
    .prepare(
      `SELECT o.starts_at FROM occasions o
       WHERE o.merged_into_id IS NULL AND o.status = 'active' AND o.classification_rule = 'flight' AND o.starts_at >= @from AND o.starts_at < @to`,
    )
    .pluck()
    .all({ from: windowFrom, to: windowTo }) as number[];
  const tickets = db
    .prepare(`SELECT local_date FROM ticket_events WHERE merged_into_id IS NULL AND status = 'holding' AND local_date >= ? AND local_date < ?`)
    .pluck()
    .all(from, addDays(from, days)) as string[];
  const partiful = partifulSpans(db, windowFrom, windowTo);
  for (let i = 0; i < days; i++) {
    const date = addDays(from, i);
    const start = dayStart(date, timeZone) + EVENING.fromHour * HOUR;
    const end = dayStart(date, timeZone) + EVENING.toHour * HOUR;
    const overlaps = (a: number, b: number) => a < end && b > start;
    let reason: BusyReason | null = null;
    if (plans.some((e) => overlaps(e.start, e.end))) reason = 'calendar';
    else if (stays.some((s) => s.start_date <= date && s.end_date > date) || flights.some((t) => localDate(t, timeZone) === date)) reason = 'away';
    else if (tickets.includes(date)) reason = 'tickets';
    else if (partiful.some((e) => overlaps(e.start, e.end))) reason = 'partiful';
    out.push({ date, free: reason === null, reason });
  }
  return out;
}

function hasInvitees(attendees: string | null): boolean {
  if (!attendees) return false;
  try {
    const a = JSON.parse(attendees) as unknown;
    return Array.isArray(a) && a.some((x) => !(x as { self?: boolean } | null)?.self);
  } catch {
    return false;
  }
}
