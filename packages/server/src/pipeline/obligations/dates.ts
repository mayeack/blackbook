/**
 * Local-date ↔ Unix-ms conversion in an IANA zone, and the commitment due-date check of intelligence §4.5 step 5:
 * chrono-node parses the cited quote (reference = the message time, forward dates); when it disagrees with the
 * LLM's date by more than 2 days and the quote holds an explicit date token, chrono wins. A due date before the
 * message date − 1 day becomes vague.
 */
import * as chrono from 'chrono-node';
import { addDays, localParts } from '@yb/shared';
import { COMMITMENT, DAY } from './constants';

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Minutes east of UTC at `ms` in `timeZone`. */
export function tzOffsetMinutes(ms: number, timeZone?: string): number {
  const p = localParts(ms, timeZone);
  const [y, mo, d] = p.date.split('-').map(Number) as [number, number, number];
  const [h, mi] = p.hhmm.split(':').map(Number) as [number, number];
  return Math.round((Date.UTC(y, mo - 1, d, h, mi) - Math.floor(ms / 60_000) * 60_000) / 60_000);
}

/** Unix ms of local midnight starting `date` (YYYY-MM-DD) in `timeZone`. */
export function localDayStart(date: string, timeZone?: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d);
  const first = guess - tzOffsetMinutes(guess, timeZone) * 60_000;
  // Around a DST change the offset at the guess and at the answer differ: a second step settles it.
  return guess - tzOffsetMinutes(first, timeZone) * 60_000;
}

/** Unix ms of the last millisecond of local `date`. */
export const localDayEnd = (date: string, timeZone?: string): number => localDayStart(addDays(date, 1), timeZone) - 1;

export type DuePrecision = 'date' | 'range' | 'vague' | 'none';

export interface DueInput {
  precision: DuePrecision;
  /** YYYY-MM-DD (local, the extraction schema's form) or Unix ms. */
  start: string | number | null;
  end: string | number | null;
}

export interface ResolvedDue {
  precision: DuePrecision;
  start: number | null;
  end: number | null;
}

function toMs(v: string | number | null, edge: 'start' | 'end', timeZone?: string): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = v.trim().slice(0, 10);
  if (!LOCAL_DATE.test(s)) return null;
  return edge === 'start' ? localDayStart(s, timeZone) : localDayEnd(s, timeZone);
}

/** The LLM's due (dates or ms) → ms bounds; a bad or empty date degrades to vague. */
export function resolveDue(due: DueInput, timeZone?: string): ResolvedDue {
  if (due.precision === 'vague' || due.precision === 'none') return { precision: due.precision, start: null, end: null };
  const start = toMs(due.start, 'start', timeZone) ?? toMs(due.end, 'start', timeZone);
  if (start === null) return { precision: 'vague', start: null, end: null };
  // A local date ends at the end of its day (a range at the end of its last day); ms bounds are taken as given.
  const end = toMs(due.end ?? due.start, 'end', timeZone);
  return { precision: due.precision, start, end: end === null || end < start ? start : end };
}

/** First explicit day a quote names, resolved against the message time ("Friday", "the 24th", "tmrw"). */
export function chronoDay(quote: string, messageAt: number, timeZone?: string): string | null {
  const ref = { instant: new Date(messageAt), timezone: tzOffsetMinutes(messageAt, timeZone) };
  for (const r of chrono.parse(quote.slice(0, 300), ref, { forwardDate: true })) {
    if (!(r.start.isCertain('day') || r.start.isCertain('weekday') || /\b(today|tonight|tomorrow|tmrw|tmr)\b/i.test(r.text))) continue;
    const y = r.start.get('year');
    const m = r.start.get('month');
    const d = r.start.get('day');
    if (y && m && d) return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return null;
}

/**
 * Applies the date check to an LLM due: chrono's day replaces a date that is more than 2 days off; a due window
 * that ends before the message date − 1 day becomes vague (the promise can't be due before it was made).
 */
export function checkDue(due: ResolvedDue, quotes: readonly string[], messageAt: number | null, timeZone?: string): ResolvedDue {
  if (messageAt === null) return due;
  let out = due;
  if (out.precision === 'date' || out.precision === 'range') {
    for (const q of quotes) {
      const day = chronoDay(q, messageAt, timeZone);
      if (!day) continue;
      const start = localDayStart(day, timeZone);
      if (out.start === null || Math.abs(start - out.start) > COMMITMENT.chronoToleranceMs) {
        out = { precision: 'date', start, end: localDayEnd(day, timeZone) };
      }
      break;
    }
  }
  if (out.end !== null && out.end < messageAt - DAY) return { precision: 'vague', start: null, end: null };
  return out;
}

/** "Oct 3" in the zone (short, for loop details; never with a year in the current year). */
export function shortDate(ms: number, timeZone?: string, now: number = Date.now()): string {
  const sameYear = localParts(ms, timeZone).date.slice(0, 4) === localParts(now, timeZone).date.slice(0, 4);
  return new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) }).format(new Date(ms));
}
