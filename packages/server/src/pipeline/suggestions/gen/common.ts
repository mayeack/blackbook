/** Small shared helpers for the candidate generators (pure readers: generators never write). */
import { addDays } from '@yb/shared';
import type { DB } from '../../../db/connection';

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export const clamp01 = (x: number): number => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);
export const round = (x: number | null | undefined, digits = 1): number | null =>
  x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 10 ** digits) / 10 ** digits;

/** The newest message (either direction) in a 1:1 conversation with the (canonical) person, as a citation id. */
export function lastDirectMessageRef(db: DB, personId: string): string | null {
  const id = db
    .prepare(
      `SELECT m.id FROM identities i
       JOIN person_canon pc ON pc.person_id = i.person_id
       JOIN conversation_members cm ON cm.identity_id = i.id
       JOIN conversations c ON c.id = cm.conversation_id AND c.kind = 'direct'
       JOIN messages m ON m.conversation_id = c.id
       WHERE pc.canonical_id = ? AND m.kind IN ('text','attachment','link') AND m.is_bot = 0 AND m.retracted_at IS NULL
       ORDER BY m.sent_at DESC LIMIT 1`,
    )
    .pluck()
    .get(personId) as number | undefined;
  return id === undefined ? null : `m:${id}`;
}

/** Local-midnight Unix ms of a YYYY-MM-DD date in `timeZone` (DST-safe to the hour). */
export function localDayStart(date: string, timeZone: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d);
  const offsetAt = (t: number) => {
    const f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    const p: Record<string, string> = {};
    for (const part of f.formatToParts(new Date(t))) p[part.type] = part.value;
    const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
    return wall - t;
  };
  let t = guess - offsetAt(guess);
  t = guess - offsetAt(t);
  return t;
}

/** [start, end) of a local calendar day. */
export function localDayRange(date: string, timeZone: string): [number, number] {
  return [localDayStart(date, timeZone), localDayStart(addDays(date, 1), timeZone)];
}

/** The same calendar day `years` earlier (Feb 29 → Feb 28). */
export function sameDayYearsAgo(date: string, years = 1): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const year = y - years;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const day = m === 2 && d === 29 && !leap ? 28 : d;
  return `${String(year).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export const ATTENDING = `('going','approved','checked_in','attended','host')`;
