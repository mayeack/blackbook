/**
 * Shared reads for the intel module (events, briefs, follow-ups, trips, intros): local-day arithmetic, the
 * owner's attended social occasions and Partiful events, their visible attendees, person stats, and the small
 * intel_state flags. Everything here reads; only setFlag / clearFlag write (intel_state, class S).
 * People always come through person_canon → person_visible (never the owner, hidden, merged or roster-only people).
 */
import { addDays, localDate } from '@yb/shared';
import type { DB } from '../db/connection';
import { occasionChain } from '../pipeline/occasions/build';
import { COUNTED, POSSIBLE } from '../pipeline/occasions/signals';

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

// ---------------------------------------------------------------------------------------------- time

/** Local-midnight Unix ms of a YYYY-MM-DD date in `timeZone` (DST-safe to the hour). */
export function dayStart(date: string, timeZone: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d);
  const offsetAt = (t: number) => {
    const p: Record<string, string> = {};
    for (const part of new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(t))) {
      p[part.type] = part.value;
    }
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - t;
  };
  let t = guess - offsetAt(guess);
  t = guess - offsetAt(t);
  return t;
}

/** Whole local days from `a` to `b` (YYYY-MM-DD), b − a. */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.UTC(...ymd(b)) - Date.UTC(...ymd(a))) / DAY);
}
const ymd = (d: string): [number, number, number] => {
  const [y, m, dd] = d.split('-').map(Number) as [number, number, number];
  return [y, m - 1, dd];
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Mar" for a ms time in `timeZone`. */
export const monthOf = (ms: number, timeZone: string): string => MONTHS[Number(localDate(ms, timeZone).slice(5, 7)) - 1]!;
/** "Oct 20" for a YYYY-MM-DD date. */
export const shortDate = (date: string): string => `${MONTHS[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8, 10))}`;

export { addDays, localDate };

// ---------------------------------------------------------------------------------------------- state flags

export function getFlag<T = unknown>(db: DB, key: string): T | null {
  const raw = db.prepare('SELECT value FROM intel_state WHERE key = ?').pluck().get(key) as string | undefined;
  return raw === undefined ? null : (JSON.parse(raw) as T);
}

export function setFlag(db: DB, key: string, value: unknown, now: number): void {
  db.prepare(
    `INSERT INTO intel_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, JSON.stringify(value), now);
}

export function clearFlag(db: DB, key: string): void {
  db.prepare('DELETE FROM intel_state WHERE key = ?').run(key);
}

/** Set when adjudicated attendees changed: interactions + co_attend edges are re-derived (job intel-effects). */
export const EFFECTS_DIRTY = 'occasion_effects_dirty';

// ---------------------------------------------------------------------------------------------- events

/** An owner-attended social happening: a calendar occasion, or a Partiful event no occasion covers. */
export interface SocialEvent {
  type: 'occasion' | 'event';
  id: string;
  title: string | null;
  startsAt: number;
  endsAt: number;
  venue: string | null;
  /** Occasions: the linked Partiful event. */
  eventId: string | null;
}

export const PARTIFUL_ATTENDING_SQL = `(lower(coalesce(e.my_rsvp, '')) IN ('going','approved','maybe','checked_in','attended') OR lower(coalesce(e.my_role, '')) IN ('host','co_host','cohost'))`;

/**
 * Social happenings the owner is going to / went to that overlap [from, to): active (corroborated, not declined),
 * unmerged, social, non-sensitive occasions whose linked Partiful RSVP (if any) isn't a decline, plus Partiful
 * events with a going/maybe/host RSVP that no live occasion covers.
 */
export function attendedEvents(db: DB, o: { startFrom?: number; startTo?: number; endFrom?: number; endTo?: number }): SocialEvent[] {
  const p = {
    sf: o.startFrom ?? -8.64e15,
    st: o.startTo ?? 8.64e15,
    ef: o.endFrom ?? -8.64e15,
    et: o.endTo ?? 8.64e15,
  };
  const occ = db
    .prepare(
      `SELECT 'occasion' AS type, o.id, o.title, o.starts_at AS startsAt, coalesce(o.ends_at, o.starts_at) AS endsAt, o.venue_text AS venue,
              o.event_id AS eventId
       FROM occasions o LEFT JOIN events e ON e.id = o.event_id
       WHERE o.merged_into_id IS NULL AND o.status = 'active' AND o.is_social = 1 AND o.sensitive = 0
         AND o.starts_at >= @sf AND o.starts_at < @st AND coalesce(o.ends_at, o.starts_at) >= @ef AND coalesce(o.ends_at, o.starts_at) < @et
         AND lower(coalesce(e.my_rsvp, '')) NOT IN ('declined','not_going','rejected')
       ORDER BY o.starts_at, o.id`,
    )
    .all(p) as SocialEvent[];
  const ev = db
    .prepare(
      `SELECT 'event' AS type, e.id, e.title, e.starts_at AS startsAt, coalesce(e.ends_at, e.starts_at + 3 * 3600000) AS endsAt,
              e.location_text AS venue, NULL AS eventId
       FROM events e
       WHERE e.source = 'partiful' AND e.starts_at IS NOT NULL AND ${PARTIFUL_ATTENDING_SQL}
         AND lower(coalesce(e.status, '')) NOT LIKE '%cancel%'
         AND e.starts_at >= @sf AND e.starts_at < @st
         AND coalesce(e.ends_at, e.starts_at + 3 * 3600000) >= @ef AND coalesce(e.ends_at, e.starts_at + 3 * 3600000) < @et
         AND NOT EXISTS (SELECT 1 FROM occasions o WHERE o.event_id = e.id AND o.merged_into_id IS NULL AND o.status IN ('active','candidate'))
       ORDER BY e.starts_at, e.id`,
    )
    .all(p) as SocialEvent[];
  return [...occ, ...ev].sort((a, b) => a.startsAt - b.startsAt || (a.id < b.id ? -1 : 1));
}

// ---------------------------------------------------------------------------------------------- attendees

const COUNTED_STATUSES = new Set(['going', 'attended', 'approved', 'checked_in', 'host']);
const SHOWN_STATUSES = new Set([...COUNTED_STATUSES, 'maybe', 'possible']);

export interface KnownAttendee {
  personId: string;
  status: string;
  role: string | null;
  source: string;
  confidence: number;
  /** Counted in ties and edges (≥ 0.75 and a going/attended status). */
  counted: boolean;
}

export const isCounted = (status: string, confidence: number): boolean => COUNTED_STATUSES.has(status.toLowerCase()) && confidence >= COUNTED;

interface RawAttendee {
  person_id: string;
  status: string;
  role: string | null;
  source: string;
  confidence: number;
  updated_at: number;
}

/**
 * Visible canonical attendees of an occasion (its merge chain plus the linked Partiful event's guest list) or of a
 * Partiful event: one row per person (the user's own rows win, then counted, then confidence), only going /
 * attended / host / maybe / possible rows (never declined, invited, withdrawn or rejected ones).
 */
export function knownAttendees(db: DB, ref: { type: 'occasion' | 'event'; id: string; eventId?: string | null }): KnownAttendee[] {
  const occasionIds = ref.type === 'occasion' ? occasionChain(db, ref.id) : [];
  const eventId = ref.type === 'event' ? ref.id : (ref.eventId ?? null);
  const rows = db
    .prepare(
      `SELECT pv.id AS person_id, a.status, a.role, a.source, a.confidence, a.updated_at
       FROM event_attendees a
       JOIN person_canon pc ON pc.person_id = a.person_id
       JOIN person_visible pv ON pv.id = pc.canonical_id
       WHERE a.occasion_id IN (SELECT value FROM json_each(@occ)) OR (@event IS NOT NULL AND a.event_id = @event)`,
    )
    .all({ occ: JSON.stringify(occasionIds), event: eventId }) as RawAttendee[];
  const rejected = new Set(rows.filter((r) => r.status === 'rejected').map((r) => r.person_id));
  const best = new Map<string, RawAttendee>();
  const rank = (r: RawAttendee) => (r.source === 'user' ? 4 : 0) + (isCounted(r.status, r.confidence) ? 2 : 0) + (SHOWN_STATUSES.has(r.status.toLowerCase()) ? 1 : 0);
  for (const r of rows) {
    const cur = best.get(r.person_id);
    if (!cur || rank(r) > rank(cur) || (rank(r) === rank(cur) && (r.confidence > cur.confidence || (r.confidence === cur.confidence && r.updated_at > cur.updated_at)))) {
      best.set(r.person_id, r);
    }
  }
  const out: KnownAttendee[] = [];
  for (const r of best.values()) {
    const status = r.status.toLowerCase();
    if (rejected.has(r.person_id) && r.source !== 'user') continue;
    if (!SHOWN_STATUSES.has(status)) continue;
    if (status === 'possible' && r.confidence < POSSIBLE) continue;
    out.push({ personId: r.person_id, status, role: r.role, source: r.source, confidence: r.confidence, counted: isCounted(status, r.confidence) });
  }
  return out.sort((a, b) => Number(b.counted) - Number(a.counted) || b.confidence - a.confidence || (a.personId < b.personId ? -1 : 1));
}

/**
 * Guests with no matching person (a Partiful guest list keeps strangers roster-only): their names as listed, plus
 * names the owner wrote in the calendar that matched nobody. Hidden people are never named.
 */
export function unknownGuestNames(db: DB, ref: { type: 'occasion' | 'event'; id: string; eventId?: string | null }, limit = 30): string[] {
  const eventId = ref.type === 'event' ? ref.id : (ref.eventId ?? null);
  const names: string[] = [];
  if (eventId) {
    const rows = db
      .prepare(
        `SELECT coalesce(p.display_name, i.display_name) AS name
         FROM event_attendees a
         JOIN person_canon pc ON pc.person_id = a.person_id
         JOIN people p ON p.id = pc.canonical_id
         LEFT JOIN identities i ON i.id = a.identity_id
         WHERE a.event_id = ? AND p.kind = 'person' AND p.status = 'roster_only' AND p.is_hidden = 0 AND p.merged_into_id IS NULL
           AND lower(a.status) IN ('going','approved','checked_in','attended','maybe','host')
         ORDER BY lower(coalesce(p.display_name, i.display_name))`,
      )
      .pluck()
      .all(eventId) as (string | null)[];
    for (const n of rows) if (n?.trim()) names.push(n.trim());
  }
  if (ref.type === 'occasion') {
    const rows = db
      .prepare(`SELECT surface FROM occasion_candidates WHERE occasion_id IN (SELECT value FROM json_each(?)) AND kind = 'name' AND surface IS NOT NULL ORDER BY surface`)
      .pluck()
      .all(JSON.stringify(occasionChain(db, ref.id))) as string[];
    for (const n of rows) if (n.trim()) names.push(n.trim());
  }
  const seen = new Set<string>();
  return names.filter((n) => {
    const k = n.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, limit);
}

// ---------------------------------------------------------------------------------------------- people

export interface Stats {
  tie: number | null;
  historical: number | null;
  lastAt: number | null;
  silenceD: number | null;
  expectedGapD: number | null;
  state: string | null;
}

export function statsOf(db: DB, personId: string): Stats {
  const r = db
    .prepare('SELECT tie_strength, historical_strength, last_at, silence_d, expected_gap_d, state FROM person_stats WHERE person_id = ?')
    .get(personId) as
    | { tie_strength: number | null; historical_strength: number | null; last_at: number | null; silence_d: number | null; expected_gap_d: number | null; state: string | null }
    | undefined;
  return {
    tie: r?.tie_strength ?? null,
    historical: r?.historical_strength ?? null,
    lastAt: r?.last_at ?? null,
    silenceD: r?.silence_d ?? null,
    expectedGapD: r?.expected_gap_d ?? null,
    state: r?.state ?? null,
  };
}

/** The visible canonical id of a (possibly merged-away) person, or null. */
export function visibleCanonical(db: DB, personId: string): string | null {
  return (
    (db
      .prepare(`SELECT pv.id FROM person_canon pc JOIN person_visible pv ON pv.id = pc.canonical_id WHERE pc.person_id = ?`)
      .pluck()
      .get(personId) as string | undefined) ??
    (db.prepare('SELECT id FROM person_visible WHERE id = ?').pluck().get(personId) as string | undefined) ??
    null
  );
}

/** The owner's person id (kind 'me'), or null. */
export function ownerId(db: DB): string | null {
  return (db.prepare(`SELECT id FROM people WHERE kind = 'me' AND status IN ('active','provisional') ORDER BY created_at LIMIT 1`).pluck().get() as string | undefined) ?? null;
}

/** Yields the event loop (long passes call it between chunks). */
export const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Drives a generator of small synchronous steps, giving the event loop a turn every `sliceMs`. */
export async function drive<R>(gen: Generator<void, R>, o: { sliceMs?: number; signal?: AbortSignal } = {}): Promise<{ value: R | null; complete: boolean }> {
  const slice = o.sliceMs ?? 25;
  let since = performance.now();
  for (;;) {
    if (o.signal?.aborted) return { value: null, complete: false };
    const r = gen.next();
    if (r.done) return { value: r.value, complete: true };
    if (performance.now() - since >= slice) {
      await yieldToLoop();
      since = performance.now();
    }
  }
}

/** Drains a step generator synchronously (tests, routes). */
export function drain<R>(gen: Generator<void, R>): R {
  for (;;) {
    const r = gen.next();
    if (r.done) return r.value;
  }
}

export const dayKey = (ms: number, timeZone: string): string => localDate(ms, timeZone);
export const nextDay = (date: string): string => addDays(date, 1);
