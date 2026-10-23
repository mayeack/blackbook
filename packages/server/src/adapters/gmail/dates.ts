/**
 * The deterministic date post-check after the ticket parse (review amendments "Dates"):
 *   - JSON-LD startDate / endDate win over the model's start_local / end_local;
 *   - for order, registration, delivery, reminder and transfer kinds the year is re-picked so the start falls in
 *     [email date − 1 d, email date + 18 months] and matches a weekday the mail names next to that date (refs.weekdays);
 *     a JSON-LD year is the vendor's own and stays unless the named weekday contradicts it (tickets bought years
 *     ahead), and no year is ever picked on a weekday the mail contradicts (a transfer mailed after the show keeps
 *     its year) unless the given year contradicts it too;
 *   - the zone is the model's (a valid IANA name), else the owner's — and then `tz` stays null ("guessed"), so the
 *     ledger joins on title / performer by local date and never on the ±3 h rule. A JSON-LD offset pins the instant
 *     and decides the zone: the model's or the owner's when it agrees with the offset, else none (the string's own
 *     wall clock is kept); a UTC "…Z" string no zone agrees with is a serialization, read in the model's zone (else
 *     the owner's, guessed);
 *   - ends: end_local (or the JSON-LD end), else start + 6 h (club), 10 h (festival), 4 h (anything else);
 *   - a date without a time starts at 19:00 (12:00 for a festival).
 */
import { localParts } from '@yb/shared';
import { isValidTimeZone, zonedToUtc } from '../calendar/time';
import type { TicketCategory, TicketKind } from './prompt';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** The year window: start ∈ [email − 1 d, email + 18 months]. */
export const YEAR_WINDOW = { beforeMs: DAY, afterMs: 548 * DAY } as const;
const MAX_SPAN_MS = 21 * DAY;

/** Kinds about an event still ahead when the mail was sent. */
const UPCOMING_KINDS: ReadonlySet<TicketKind> = new Set(['order', 'registration', 'delivery', 'reminder', 'transfer_in', 'transfer_out', 'transfer_back', 'transfer_accepted']);

export function defaultDurationMs(category: TicketCategory): number {
  return category === 'club' ? 6 * HOUR : category === 'festival' ? 10 * HOUR : 4 * HOUR;
}

export interface Wall {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  /** The time was given (not a bare date). */
  timed: boolean;
  /** A UTC offset in minutes, when the string carried one (JSON-LD). */
  offsetMin: number | null;
}

const WALL_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;

/** "YYYY-MM-DDTHH:MM[:SS][offset]" or "YYYY-MM-DD" → its parts, or null. */
export function parseWall(s: string | null | undefined): Wall | null {
  const m = WALL_RE.exec((s ?? '').trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const timed = m[4] !== undefined;
  const h = timed ? Number(m[4]) : 0;
  const mi = timed ? Number(m[5]) : 0;
  if (h > 23 || mi > 59) return null;
  let offsetMin: number | null = null;
  if (m[6]) {
    if (/^z$/i.test(m[6])) offsetMin = 0;
    else {
      const o = /^([+-])(\d{2}):?(\d{2})$/.exec(m[6])!;
      offsetMin = (o[1] === '-' ? -1 : 1) * (Number(o[2]) * 60 + Number(o[3]));
    }
  }
  // Reject impossible dates (Feb 30).
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCMonth() !== mo - 1) return null;
  return { y, mo, d, h, mi, timed, offsetMin };
}

const pad = (n: number) => String(n).padStart(2, '0');
export const wallString = (w: Pick<Wall, 'y' | 'mo' | 'd' | 'h' | 'mi'>) => `${w.y}-${pad(w.mo)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}`;
const dowOf = (y: number, mo: number, d: number) => new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
const validDay = (y: number, mo: number, d: number) => new Date(Date.UTC(y, mo - 1, d)).getUTCMonth() === mo - 1;

/** The instant of a wall time in `tz` (an offset in the string wins). */
function instantOf(w: Wall, tz: string): number {
  if (w.offsetMin !== null) return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi) - w.offsetMin * 60_000;
  return zonedToUtc(w.y, w.mo, w.d, w.h, w.mi, 0, 0, tz);
}

/**
 * The year that puts the start in the window and on the weekday the mail names (see the header); the given year when
 * it already fits, when it is explicit (JSON-LD) and the weekday agrees, or when no year does. Never a year on a
 * weekday the mail contradicts, unless the given year contradicts it too (then the weekday can't be trusted).
 */
export function inferYear(w: Wall, tz: string, emailAt: number, weekdays: Readonly<Record<string, number>> = {}, o: { explicit?: boolean } = {}): number {
  const hint = weekdays[`${pad(w.mo)}-${pad(w.d)}`];
  const onHint = (y: number) => hint === undefined || dowOf(y, w.mo, w.d) === hint;
  if (o.explicit && onHint(w.y)) return w.y;
  const emailYear = Number(localParts(emailAt, tz).date.slice(0, 4));
  const inWindow = (y: number) => {
    if (!validDay(y, w.mo, w.d)) return false;
    const t = instantOf({ ...w, y, offsetMin: null }, tz);
    return t >= emailAt - YEAR_WINDOW.beforeMs && t <= emailAt + YEAR_WINDOW.afterMs;
  };
  const fits = (y: number) => inWindow(y) && onHint(y);
  if (fits(w.y)) return w.y;
  for (const y of [emailYear, emailYear + 1, emailYear - 1, emailYear + 2]) if (fits(y)) return y;
  // No year in the window is on the named weekday. The given year is, outside it (a mail after the show, tickets
  // bought far ahead): keep it. It isn't either: the weekday names some other date, so the window alone decides.
  if (hint !== undefined && !onHint(w.y)) for (const y of [w.y, emailYear, emailYear + 1]) if (inWindow(y)) return y;
  return w.y;
}

export interface DateInput {
  kind: TicketKind;
  category: TicketCategory;
  startLocal: string | null;
  endLocal: string | null;
  timezone: string | null;
  jsonLdStart: string | null;
  jsonLdEnd: string | null;
  emailAt: number;
  ownerTz: string;
  weekdays?: Readonly<Record<string, number>>;
}

export interface ResolvedDates {
  /** UTC ms, or null when the mail gives no date. */
  startsAt: number | null;
  endsAt: number | null;
  /** The venue's zone when known; null = guessed from the owner's. */
  tz: string | null;
  /** The zone the local values are in (tz ?? the owner's). */
  zone: string;
  localDate: string | null;
  startLocal: string | null;
  endLocal: string | null;
  /** The year was changed from what the source said. */
  yearFixed: boolean;
  source: 'json_ld' | 'model' | 'none';
}

export function resolveDates(i: DateInput): ResolvedDates {
  const modelTz = i.timezone && isValidTimeZone(i.timezone) ? i.timezone : null;
  const ld = parseWall(i.jsonLdStart);
  const model = parseWall(i.startLocal);
  const start = ld ?? model;
  const none: ResolvedDates = {
    startsAt: null,
    endsAt: null,
    tz: modelTz,
    zone: modelTz ?? i.ownerTz,
    localDate: null,
    startLocal: null,
    endLocal: null,
    yearFixed: false,
    source: 'none',
  };
  if (!start) return none;
  let tz = modelTz;
  let w: Wall = { ...start };
  if (start.offsetMin !== null) {
    // A string with an offset pins the instant. Its wall clock is the venue's when a zone agrees with the offset
    // (the model's first, else the owner's, which then is no longer a guess). A UTC string ("…Z") that no zone
    // agrees with is a serialization, not the venue's clock: the wall is read in the model's zone (else the
    // owner's, guessed). Any other offset nobody agrees with keeps its own wall, zone unknown.
    const instant = Date.UTC(start.y, start.mo - 1, start.d, start.h, start.mi) - start.offsetMin * 60_000;
    const agrees = (z: string) => offsetAt(instant, z) === start.offsetMin;
    if (modelTz && agrees(modelTz)) tz = modelTz;
    else if (start.offsetMin === 0 && start.timed && (modelTz || !agrees(i.ownerTz))) {
      tz = modelTz;
      w = wallOf(instant, modelTz ?? i.ownerTz);
    } else tz = agrees(i.ownerTz) ? i.ownerTz : null;
  }
  const zone = tz ?? i.ownerTz;
  if (!w.timed) {
    w.h = i.category === 'festival' ? 12 : 19;
    w.mi = 0;
  }
  let yearFixed = false;
  if (UPCOMING_KINDS.has(i.kind)) {
    const y = inferYear(w, zone, i.emailAt, i.weekdays, { explicit: !!ld });
    if (y !== w.y) {
      yearFixed = true;
      w.y = y;
      w.offsetMin = null; // the offset belonged to the old date
    }
  }
  const startsAt = instantOf(w, zone);
  // The venue's wall clock: the given wall time (with an offset, that is exact even when the zone is unknown).
  const offsetMs = w.offsetMin !== null ? w.offsetMin * 60_000 : null;
  const wallAt = (ms: number): Wall => (offsetMs !== null ? utcWall(ms + offsetMs) : wallOf(ms, zone));
  const localWall = w;

  // The end: JSON-LD, else the model's, else the category default. Same year as the start, after it, within 3 weeks.
  let endsAt: number | null = null;
  const e = parseWall(ld ? (i.jsonLdEnd ?? null) : i.endLocal) ?? (ld ? parseWall(i.endLocal) : null);
  if (e) {
    const ew: Wall = { ...e, y: yearFixed || !ld ? localWall.y : e.y };
    if (!ew.timed) {
      // A bare end date means "through that day".
      ew.h = 23;
      ew.mi = 59;
    }
    if (!validDay(ew.y, ew.mo, ew.d)) ew.y = e.y;
    let t = instantOf(ew, zone);
    if (t < startsAt && ew.offsetMin === null) {
      // "ends 1:00" after a 22:00 start is the next day; a December→January festival crosses the year.
      t = ew.mo < localWall.mo ? instantOf({ ...ew, y: ew.y + 1 }, zone) : t + DAY;
    }
    if (t > startsAt && t - startsAt <= MAX_SPAN_MS) endsAt = t;
  }
  endsAt ??= startsAt + defaultDurationMs(i.category);
  return {
    startsAt,
    endsAt,
    tz,
    zone,
    localDate: `${localWall.y}-${pad(localWall.mo)}-${pad(localWall.d)}`,
    startLocal: wallString(localWall),
    endLocal: wallString(wallAt(endsAt)),
    yearFixed,
    source: ld ? 'json_ld' : 'model',
  };
}

/** The UTC offset (minutes) of `tz` at an instant. */
function offsetAt(ms: number, tz: string): number {
  return Math.round((Date.UTC(...wallTuple(ms, tz)) - ms) / 60_000);
}

function wallTuple(ms: number, tz: string): [number, number, number, number, number] {
  const p = localParts(ms, tz);
  const [y, mo, d] = p.date.split('-').map(Number) as [number, number, number];
  const [h, mi] = p.hhmm.split(':').map(Number) as [number, number];
  return [y, mo - 1, d, h, mi];
}

function wallOf(ms: number, tz: string): Wall {
  const [y, mo, d, h, mi] = wallTuple(ms, tz);
  return { y, mo: mo + 1, d, h, mi, timed: true, offsetMin: null };
}

function utcWall(ms: number): Wall {
  const t = new Date(ms);
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(), h: t.getUTCHours(), mi: t.getUTCMinutes(), timed: true, offsetMin: null };
}
