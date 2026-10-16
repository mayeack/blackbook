/**
 * Google Calendar times → Unix ms. A timed event's dateTime normally carries its UTC offset; one without (a
 * "floating" time) is read in the event's own zone, else the calendar's. All-day events are wall dates: they start
 * at local midnight in the calendar's zone, and Google's end date is exclusive.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(tz: string | null | undefined): tz is string {
  if (!tz) return false;
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

/** Local wall time minus UTC at instant `ms`, in ms. */
function offsetAt(ms: number, timeZone: string): number {
  const p: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(ms))) if (part.type !== 'literal') p[part.type] = Number(part.value);
  const wall = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
  return wall - (ms - (((ms % 1000) + 1000) % 1000));
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FLOATING_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?$/;
const HAS_OFFSET_RE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

const DAY = 86_400_000;

/**
 * A wall-clock time in `timeZone` → Unix ms. Tries the offsets in force a day before and a day after: in a DST
 * overlap both fit and the earlier instant wins; in a gap neither fits and the time moves forward (read with the
 * offset from before the change, as Temporal's "compatible" does).
 */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, ms: number, timeZone: string): number {
  const wall = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  const before = wall - offsetAt(wall - DAY, timeZone);
  const after = wall - offsetAt(wall + DAY, timeZone);
  const fits = (t: number) => offsetAt(t, timeZone) === wall - t;
  const ok = [before, after].filter(fits);
  return ok.length ? Math.min(...ok) : before;
}

/** YYYY-MM-DD → local midnight in `timeZone`. */
export function dateToUtc(date: string, timeZone: string): number | null {
  const m = DATE_RE.exec(date);
  if (!m) return null;
  return zonedToUtc(Number(m[1]), Number(m[2]), Number(m[3]), 0, 0, 0, 0, timeZone);
}

/** RFC 3339 dateTime → Unix ms; a floating time (no offset) is read in `timeZone`. */
export function dateTimeToUtc(dateTime: string, timeZone: string): number | null {
  if (HAS_OFFSET_RE.test(dateTime)) {
    const ms = Date.parse(dateTime);
    return Number.isFinite(ms) ? ms : null;
  }
  const m = FLOATING_RE.exec(dateTime);
  if (!m) return null;
  const frac = m[7] ? Number(m[7].padEnd(3, '0').slice(0, 3)) : 0;
  return zonedToUtc(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0), frac, timeZone);
}

export interface GoogleTime {
  date?: string | null;
  dateTime?: string | null;
  timeZone?: string | null;
}

export interface ResolvedTime {
  at: number | null;
  /** All-day events only: the wall date as Google sent it. */
  date: string | null;
  allDay: boolean;
  /** The zone the time is expressed in (the event's own, else the calendar's). */
  tz: string | null;
}

/** Resolves an event start/end. `calendarTz` is the calendar's zone (calendarList / events.list timeZone). */
export function resolveTime(t: GoogleTime | null | undefined, calendarTz: string | null): ResolvedTime {
  const own = isValidTimeZone(t?.timeZone) ? t!.timeZone! : null;
  const cal = isValidTimeZone(calendarTz) ? calendarTz : null;
  const tz = own ?? cal;
  if (t?.dateTime) return { at: dateTimeToUtc(t.dateTime, tz ?? 'UTC'), date: null, allDay: false, tz };
  if (t?.date) return { at: dateToUtc(t.date, tz ?? 'UTC'), date: DATE_RE.test(t.date) ? t.date : null, allDay: true, tz };
  return { at: null, date: null, allDay: false, tz };
}
