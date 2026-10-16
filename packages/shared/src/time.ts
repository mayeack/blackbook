/** Seconds between the Unix epoch and Apple's reference date (2001-01-01T00:00:00Z). */
export const APPLE_EPOCH_OFFSET_S = 978_307_200;
export const DAY_MS = 86_400_000;

/** Core Data / NSDate seconds since 2001 (INTEGER or REAL) → Unix ms. */
export function coreDataSecondsToMs(v: number): number {
  return Math.round((v + APPLE_EPOCH_OFFSET_S) * 1000);
}

/**
 * chat.db `date` columns → Unix ms. Since macOS 10.13 they hold nanoseconds since 2001; older rows hold
 * seconds. Nanosecond values exceed 2^53, so a bigint (better-sqlite3 safeIntegers) is accepted too.
 */
export function chatDbDateToMs(v: number | bigint | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') {
    if (v === 0n) return null;
    const abs = v < 0n ? -v : v;
    return abs > 10_000_000_000n ? Number(v / 1_000_000n) + APPLE_EPOCH_OFFSET_S * 1000 : coreDataSecondsToMs(Number(v));
  }
  if (!Number.isFinite(v) || v === 0) return null;
  return Math.abs(v) > 1e10 ? Math.round(v / 1e6) + APPLE_EPOCH_OFFSET_S * 1000 : coreDataSecondsToMs(v);
}

/** Inverse of chatDbDateToMs for building synthetic fixtures: Unix ms → chat.db nanoseconds. */
export function msToChatDbNanos(ms: number): bigint {
  return BigInt(Math.round(ms - APPLE_EPOCH_OFFSET_S * 1000)) * 1_000_000n;
}

export interface LocalParts {
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM, 24-hour */
  hhmm: string;
  /** 0 = Sunday … 6 = Saturday */
  dow: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Calendar date, wall-clock time and weekday of `ms` in `timeZone` (default: the system zone). */
export function localParts(ms: number, timeZone?: string): LocalParts {
  const key = timeZone ?? '';
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hourCycle: 'h23',
    });
    formatters.set(key, f);
  }
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(new Date(ms))) p[part.type] = part.value;
  return { date: `${p.year}-${p.month}-${p.day}`, hhmm: `${p.hour}:${p.minute}`, dow: WEEKDAYS.indexOf(p.weekday ?? '') };
}

export const localDate = (ms: number, timeZone?: string): string => localParts(ms, timeZone).date;

/** Adds `days` to a YYYY-MM-DD date (calendar arithmetic, no time zone involved). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Validates "HH:MM" (24-hour). */
export const isHHMM = (s: string): boolean => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
