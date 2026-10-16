/**
 * Durations and dates in commands, resolved against the command's own send time in the owner's zone:
 *   snooze N 1w|2w|1m|10d|tomorrow|next week|until fri|<date>   (default 7 days)
 *   pause [dur]                                                  (default 7 days)
 *   log: … yesterday / last Friday / Oct 3                       (default the message's day)
 */
import * as chrono from 'chrono-node';
import { addDays, DAY_MS, localParts } from '@yb/shared';
import { dateToUtc, zonedToUtc } from '../adapters/calendar/time';

export const DEFAULT_SNOOZE_DAYS = 7;
/** Further than this is a typo, not a snooze. */
const MAX_AHEAD_MS = 365 * DAY_MS;

const UNIT: Record<string, 'h' | 'd' | 'w' | 'm'> = {
  h: 'h', hr: 'h', hrs: 'h', hour: 'h', hours: 'h',
  d: 'd', day: 'd', days: 'd',
  w: 'w', wk: 'w', wks: 'w', week: 'w', weeks: 'w',
  m: 'm', mo: 'm', mos: 'm', month: 'm', months: 'm',
};
const WORD_NUM: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };

/** Words that may follow a number as a duration unit ("snooze 1 2 weeks"). */
export const isUnitWord = (w: string): boolean => Object.hasOwn(UNIT, w.toLowerCase());

/** Minutes east of UTC for `ms` in `timeZone` (chrono's reference offset). */
function tzOffsetMinutes(ms: number, timeZone: string): number {
  const p = localParts(ms, timeZone);
  const [y, mo, d] = p.date.split('-').map(Number) as [number, number, number];
  const [h, mi] = p.hhmm.split(':').map(Number) as [number, number];
  return Math.round((Date.UTC(y, mo - 1, d, h, mi) - Math.floor(ms / 60_000) * 60_000) / 60_000);
}

/** Adds calendar months keeping the local wall time (Jan 31 + 1m → Feb 28). */
function addMonths(at: number, n: number, timeZone: string): number {
  const p = localParts(at, timeZone);
  const [y, mo, d] = p.date.split('-').map(Number) as [number, number, number];
  const [h, mi] = p.hhmm.split(':').map(Number) as [number, number];
  const target = new Date(Date.UTC(y, mo - 1 + n, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return zonedToUtc(target.getUTCFullYear(), target.getUTCMonth() + 1, Math.min(d, lastDay), h, mi, 0, 0, timeZone);
}

const startOfLocalDay = (date: string, timeZone: string): number => dateToUtc(date, timeZone)!;

/**
 * When a snooze/pause given as `spec` ends, or null when `spec` isn't a duration/date we understand.
 * An empty spec is the default (7 days). Dates resolve to the start of that local day.
 */
export function resolveUntil(spec: string | null | undefined, at: number, timeZone: string, defaultDays = DEFAULT_SNOOZE_DAYS): number | null {
  let s = (spec ?? '').toLowerCase().replace(/[.,!]+$/g, '').replace(/\s+/g, ' ').trim();
  s = s.replace(/^(?:until|till|til|to|for|on|by)\s+/, '').trim();
  if (!s) return at + defaultDays * DAY_MS;
  const today = localParts(at, timeZone).date;

  const rel = /^(\d{1,3}|a|an|one|two|three|four|five|six)\s*([a-z]+)$/.exec(s);
  if (rel) {
    const n = /^\d+$/.test(rel[1]!) ? Number(rel[1]) : WORD_NUM[rel[1]!]!;
    const unit = UNIT[rel[2]!];
    if (unit && n > 0) {
      const until = unit === 'h' ? at + n * 3_600_000 : unit === 'd' ? at + n * DAY_MS : unit === 'w' ? at + 7 * n * DAY_MS : addMonths(at, n, timeZone);
      return until - at <= MAX_AHEAD_MS ? until : null;
    }
  }
  if (s === 'tomorrow' || s === 'tmrw' || s === 'tmr') return startOfLocalDay(addDays(today, 1), timeZone);
  if (s === 'next week') {
    const dow = localParts(at, timeZone).dow;
    return startOfLocalDay(addDays(today, ((8 - dow) % 7) || 7), timeZone); // next Monday
  }
  if (s === 'next month') {
    const [y, m] = today.split('-').map(Number) as [number, number];
    const first = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
    return startOfLocalDay(first, timeZone);
  }
  if (s === 'weekend' || s === 'the weekend' || s === 'this weekend') {
    const dow = localParts(at, timeZone).dow;
    return startOfLocalDay(addDays(today, ((6 - dow + 7) % 7) || 7), timeZone);
  }
  const ref = { instant: new Date(at), timezone: tzOffsetMinutes(at, timeZone) };
  const hit = chrono.parse(s, ref, { forwardDate: true })[0];
  if (!hit || hit.index !== 0 || hit.text.length < s.length - 1) return null;
  const c = hit.start;
  if (!(c.isCertain('day') || c.isCertain('weekday'))) return null;
  const y = c.get('year');
  const m = c.get('month');
  const d = c.get('day');
  if (!y || !m || !d) return null;
  const until = startOfLocalDay(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`, timeZone);
  return until > at && until - at <= MAX_AHEAD_MS ? until : null;
}

const RELATIVE = /\b(today|tonight|yesterday|last (?:night|week|weekend|mon|tue|wed|thu|fri|sat|sun)\w*|this (?:morning|afternoon|evening))\b/i;

/**
 * The day a `log:` happened: a date phrase in the text resolved backwards from the message, else the message's
 * own time. Never more than a day ahead (that's a plan, not a log) and never more than a year back.
 */
export function resolveLogTime(text: string, at: number, timeZone: string): { at: number; date: string } {
  const own = { at, date: localParts(at, timeZone).date };
  const ref = { instant: new Date(at), timezone: tzOffsetMinutes(at, timeZone) };
  for (const r of chrono.parse(text.slice(0, 400), ref, { forwardDate: false })) {
    const c = r.start;
    if (!(c.isCertain('day') || c.isCertain('weekday') || RELATIVE.test(r.text))) continue;
    const when = c.date().getTime();
    if (when > at + DAY_MS || when < at - 366 * DAY_MS) continue;
    const date = localParts(when, timeZone).date;
    if (date === own.date) return own;
    if (c.isCertain('hour')) return { at: when, date };
    return { at: zonedToUtc(+date.slice(0, 4), +date.slice(5, 7), +date.slice(8, 10), 12, 0, 0, 0, timeZone), date };
  }
  return own;
}

/** A YYYY-MM-DD from the intent parser → a time on that day (the message time if same day, else local noon). */
export function logTimeFromDate(date: string | null, at: number, timeZone: string): { at: number; date: string } | null {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const own = localParts(at, timeZone).date;
  if (date === own) return { at, date };
  const noon = zonedToUtc(+date.slice(0, 4), +date.slice(5, 7), +date.slice(8, 10), 12, 0, 0, 0, timeZone);
  if (!Number.isFinite(noon) || noon > at + DAY_MS || noon < at - 366 * DAY_MS) return null;
  return { at: noon, date };
}
