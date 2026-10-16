/**
 * Local-calendar day arithmetic for the ties pass. A day is an integer day number (days since 1970-01-01 of the
 * LOCAL calendar date in the `tz` setting), so gaps and ages are plain subtraction. Converting a timestamp needs
 * Intl, which is slow, so conversions are cached per UTC hour (zone offsets change on hour boundaries).
 */
import { localDate } from '@yb/shared';

export const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** 'YYYY-MM-DD' → day number. */
export function dayNumber(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

/** Day number → 'YYYY-MM-DD'. */
export function dayString(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** 0 = Monday … 6 = Sunday of a day number. */
export function isoWeekday(day: number): number {
  return (new Date(day * DAY_MS).getUTCDay() + 6) % 7;
}

/** The Monday of the week that contains `day`. */
export const weekStart = (day: number): number => day - isoWeekday(day);

/** A cached timestamp → local day-number converter for one time zone. */
export function dayConverter(timeZone: string | undefined): (ms: number) => number {
  const cache = new Map<number, number>();
  return (ms: number) => {
    const hour = Math.floor(ms / HOUR_MS);
    let d = cache.get(hour);
    if (d === undefined) {
      d = dayNumber(localDate(ms, timeZone));
      if (cache.size > 200_000) cache.clear();
      cache.set(hour, d);
    }
    return d;
  };
}
