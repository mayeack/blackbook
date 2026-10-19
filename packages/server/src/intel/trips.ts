/**
 * Travel intel (intelligence §5 "Travel intel"): trips from the calendar, who you know at the destination, and
 * people coming to your city.
 *
 * Trip detection (nightly, job 'intel'; also refreshed by GET /trips when stale). Segments come from live occasions
 * (the occasions pipeline already classified them):
 *   flight   kind 'travel', rule 'flight': the destination from the title ("Flight to Austin", "SFO → AUS"); a
 *            flight back to the home metro (or out of the destination) closes the trip;
 *   lodging  kind 'lodging': the city slot of the location ("…, Austin, TX 78701"), else the title;
 *   travel   other 'travel' occasions (multi-day all-day events, "Road trip to Tahoe"): the title, else the location;
 *   venue    a social occasion whose venue is in a known metro other than home (a wedding in another city).
 * Destinations are normalized place strings (intel/places.ts, no geocoding); a trip is any destination ≠ the home
 * metro (settings travel.home_city, else the owner's own location fact). Segments to one destination that touch
 * (≤ 2 days apart) merge into one trip. Trips are derived (class D): rebuilt inside the window, removed when their
 * events go away.
 *
 * People match (trip_people): someone whose current home is the destination (location_current / location_next /
 * address-book city), whose own travel_plan puts them there on overlapping dates, who went to a Partiful event there
 * in the last 12 months, or who is in a saved location list for it — never someone whose current home is elsewhere.
 * Ranked by 0.6·T + 0.4·H (person_stats). Visitors: travel_plan facts that bring someone (who doesn't live here) to
 * the home metro.
 */
import { uuidv7, type TripMatchReason } from '@yb/shared';
import type { DB } from '../db/connection';
import { tx } from '../db/tx';
import { selfPeople } from '../identity/self';
import { occasionDays } from '../pipeline/occasions/build';
import { readSetting } from '../settings/registry';
import { DAY, addDays, dayStart, daysBetween, localDate, monthOf, shortDate, statsOf } from './common';
import { destinationFromTitle, parsePlace, placeOfFactValue, placeOfTravelPlan, samePlace, type Place } from './places';

/** How far back / ahead trips are (re)built. */
export const TRIP_WINDOW = { backDays: 400, aheadDays: 120 } as const;
/** Segments to one destination this many days apart still form one trip. */
const MERGE_GAP_DAYS = 2;
/** A flight home closes a trip only within this many days of its start. */
const RETURN_WITHIN_DAYS = 30;
/** People matched per trip (stored). */
const MAX_TRIP_PEOPLE = 50;
/** Location facts below this confidence don't place anyone. */
export const MIN_LOCATION_CONF = 0.7;
const PARTIFUL_LOOKBACK_MS = 365 * DAY;

export type SegmentKind = 'flight' | 'lodging' | 'travel' | 'venue';

export interface TripSegment {
  occasionId: string;
  kind: SegmentKind;
  startOn: string;
  endOn: string;
  dest: Place;
  /** A flight back home (closes a trip, never opens one). */
  returnHome: boolean;
  origin: Place | null;
}

export interface DetectedTrip {
  key: string;
  label: string;
  startsOn: string;
  endsOn: string;
  occasionIds: string[];
  kinds: SegmentKind[];
}

// ---------------------------------------------------------------------------------------------- home

/** The owner's home metro: the travel.home_city setting, else the owner's own current location fact. */
export function homePlace(db: DB, now: number): Place | null {
  const setting = readSetting(db, 'travel.home_city');
  if (setting) {
    const p = parsePlace(setting, 'name');
    if (p) return p;
  }
  const rows = db
    .prepare(
      `SELECT f.type, f.value FROM facts f
       JOIN person_canon pc ON pc.person_id = f.person_id
       JOIN people p ON p.id = pc.canonical_id
       WHERE p.kind = 'me' AND f.type IN ('location_current','home_location','address') AND f.status IN ('tentative','confirmed')
         AND f.retracted_at IS NULL AND (f.valid_to IS NULL OR f.valid_to > @now) AND (f.valid_from IS NULL OR f.valid_from <= @now)
       ORDER BY CASE f.type WHEN 'location_current' THEN 0 WHEN 'home_location' THEN 1 ELSE 2 END, coalesce(f.valid_from, f.recorded_at) DESC`,
    )
    .all({ now }) as { type: string; value: string }[];
  for (const r of rows) {
    const p = r.type === 'address' ? parsePlace(r.value, 'address') : placeOfFactValue(r.value);
    if (p) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------- location facts

export interface LocationFact {
  id: string;
  personId: string;
  type: 'location_current' | 'home_location' | 'address' | 'location_next' | 'travel_plan';
  value: string;
  confidence: number;
  validFrom: number | null;
  validTo: number | null;
  source: string;
  recordedAt: number;
  place: Place;
}

/** Live, non-sensitive location-ish facts of visible people (never a record of mine), with their parsed places. */
export function locationFacts(db: DB): LocationFact[] {
  const self = selfPeople(db);
  const rows = db
    .prepare(
      `SELECT f.id, pv.id AS personId, f.type, f.value, f.confidence, f.valid_from AS validFrom, f.valid_to AS validTo, f.source,
              f.recorded_at AS recordedAt
       FROM facts f JOIN person_canon pc ON pc.person_id = f.person_id JOIN person_visible pv ON pv.id = pc.canonical_id
       WHERE f.type IN ('location_current','home_location','address','location_next','travel_plan')
         AND f.status IN ('tentative','confirmed') AND f.sensitive = 0 AND f.retracted_at IS NULL
       ORDER BY pv.id, f.recorded_at, f.id`,
    )
    .all() as Omit<LocationFact, 'place'>[];
  const out: LocationFact[] = [];
  for (const r of rows) {
    if (self.has(r.personId)) continue;
    const place = r.type === 'address' ? parsePlace(r.value, 'address') : r.type === 'travel_plan' ? placeOfTravelPlan(r.value) : placeOfFactValue(r.value);
    if (place) out.push({ ...r, place });
  }
  return out;
}

export function factsByPerson(facts: readonly LocationFact[]): Map<string, LocationFact[]> {
  const out = new Map<string, LocationFact[]>();
  for (const f of facts) out.set(f.personId, [...(out.get(f.personId) ?? []), f]);
  return out;
}

const effective = (f: LocationFact) => f.validFrom ?? f.recordedAt;
const LIVES_GROUP: Record<string, number> = { location_current: 0, location_next: 0, home_location: 1, address: 2 };

/**
 * Where the person lives at `at`: the newest location_current / location_next (moved by then) fact, else an
 * address-book city (home_location), else an address. Null when nothing says.
 */
export function livesIn(facts: readonly LocationFact[] | undefined, at: number): LocationFact | null {
  let best: LocationFact | null = null;
  for (const f of facts ?? []) {
    const group = LIVES_GROUP[f.type];
    if (group === undefined || f.confidence < MIN_LOCATION_CONF) continue;
    if (f.type === 'location_next') {
      if (f.validFrom === null || f.validFrom > at) continue;
    } else if ((f.validFrom !== null && f.validFrom > at) || (f.validTo !== null && f.validTo < at)) continue;
    if (!best) {
      best = f;
      continue;
    }
    const bg = LIVES_GROUP[best.type]!;
    if (group < bg || (group === bg && effective(f) > effective(best))) best = f;
  }
  return best;
}

const reasonOfLives = (f: LocationFact): TripMatchReason =>
  f.type === 'location_next' ? 'location_next' : f.type === 'location_current' ? (f.source === 'legacy' ? 'legacy_location' : 'location_current') : 'addressbook';

// ---------------------------------------------------------------------------------------------- segments

interface OccRow {
  id: string;
  kind: string;
  title: string | null;
  starts_at: number;
  ends_at: number | null;
  all_day: number;
  venue_text: string | null;
  classification_rule: string | null;
}

interface CopyRow {
  summary: string | null;
  location: string | null;
  start_date: string | null;
  end_date: string | null;
}

/** First/last local day of an occasion (all-day dates from its primary calendar copy). */
export function occasionSpan(occ: Pick<OccRow, 'starts_at' | 'ends_at' | 'all_day'>, copies: readonly CopyRow[], timeZone: string): { startOn: string; endOn: string } {
  const primary = copies.find((c) => c.start_date && c.end_date);
  const days = [
    ...occasionDays(occ.starts_at, occ.ends_at ?? occ.starts_at, occ.all_day === 1, timeZone, primary ? { start: primary.start_date!, end: primary.end_date! } : null),
  ].sort();
  const first = days[0] ?? localDate(occ.starts_at, timeZone);
  return { startOn: first, endOn: days[days.length - 1] ?? first };
}

/** Trip segments among live occasions starting in [from, to). */
export function collectSegments(db: DB, o: { from: number; to: number; timeZone: string; home: Place | null }): TripSegment[] {
  const occs = db
    .prepare(
      `SELECT id, kind, title, starts_at, ends_at, all_day, venue_text, classification_rule FROM occasions
       WHERE merged_into_id IS NULL AND status = 'active' AND sensitive = 0 AND starts_at >= ? AND starts_at < ?
         AND (kind IN ('travel','lodging') OR (kind = 'social' AND venue_text IS NOT NULL))
       ORDER BY starts_at, id`,
    )
    .all(o.from, o.to) as OccRow[];
  const copiesOf = db.prepare(
    `SELECT ce.summary, ce.location, ce.start_date, ce.end_date FROM occasion_sources s JOIN calendar_events ce ON ce.id = s.source_ref
     WHERE s.occasion_id = ? AND s.source = 'calendar' ORDER BY CASE s.role WHEN 'primary' THEN 0 ELSE 1 END, s.source_ref`,
  );
  const out: TripSegment[] = [];
  for (const occ of occs) {
    const copies = copiesOf.all(occ.id) as CopyRow[];
    const titles = [occ.title, ...copies.map((c) => c.summary)].filter((t): t is string => !!t);
    const locations = [...copies.map((c) => c.location), occ.venue_text].filter((t): t is string => !!t);
    let kind: SegmentKind;
    let dest: Place | null = null;
    let origin: Place | null = null;
    if (occ.kind === 'travel' && occ.classification_rule === 'flight') {
      kind = 'flight';
      for (const t of titles) dest ??= destinationFromTitle(t);
      for (const l of locations) origin ??= parsePlace(l, 'strict');
    } else if (occ.kind === 'lodging') {
      kind = 'lodging';
      for (const l of locations) dest ??= parsePlace(l, 'venue_address');
      for (const t of titles) dest ??= destinationFromTitle(t);
    } else if (occ.kind === 'travel') {
      kind = 'travel';
      for (const t of titles) dest ??= destinationFromTitle(t);
      for (const l of locations) dest ??= parsePlace(l, 'venue_address');
    } else {
      // A social occasion counts only at a known metro that isn't home.
      if (!o.home) continue;
      kind = 'venue';
      for (const l of locations) dest ??= parsePlace(l, 'venue');
      if (!dest?.known) continue;
    }
    if (!dest) continue;
    const atHome = samePlace(dest, o.home);
    if (atHome && kind !== 'flight') continue;
    const span = occasionSpan(occ, copies, o.timeZone);
    out.push({ occasionId: occ.id, kind, ...span, dest, returnHome: kind === 'flight' && atHome, origin });
  }
  return out;
}

/** Segments → trips (pure). */
export function buildTrips(segments: readonly TripSegment[]): DetectedTrip[] {
  const sorted = [...segments].sort((a, b) => (a.startOn < b.startOn ? -1 : a.startOn > b.startOn ? 1 : a.occasionId < b.occasionId ? -1 : 1));
  // Without a known home, a flight back to where an earlier flight left from (within 30 days) is the way home.
  const returns = new Set(
    sorted
      .filter(
        (f) =>
          f.kind === 'flight' &&
          (f.returnHome ||
            sorted.some(
              (g) => g !== f && g.kind === 'flight' && g.startOn <= f.startOn && f.startOn <= addDays(g.startOn, RETURN_WITHIN_DAYS) && g.occasionId !== f.occasionId && samePlace(g.origin, f.dest) && g.dest.key !== f.dest.key,
            )),
      )
      .map((f) => f.occasionId),
  );
  const trips: (DetectedTrip & { spanned: boolean })[] = [];
  for (const s of sorted) {
    if (s.returnHome || returns.has(s.occasionId)) continue;
    const t = trips.find((x) => x.key === s.dest.key && s.startOn <= addDays(x.endsOn, MERGE_GAP_DAYS) && s.endOn >= addDays(x.startsOn, -MERGE_GAP_DAYS));
    if (t) {
      if (s.startOn < t.startsOn) t.startsOn = s.startOn;
      if (s.endOn > t.endsOn) t.endsOn = s.endOn;
      t.occasionIds.push(s.occasionId);
      if (!t.kinds.includes(s.kind)) t.kinds.push(s.kind);
      if (s.kind !== 'flight') t.spanned = true;
    } else {
      trips.push({ key: s.dest.key, label: s.dest.label, startsOn: s.startOn, endsOn: s.endOn, occasionIds: [s.occasionId], kinds: [s.kind], spanned: s.kind !== 'flight' });
    }
  }
  // A trip known only from its outbound flight ends at the first flight back home (or out of the destination).
  for (const t of trips) {
    const back = sorted.find(
      (s) =>
        s.kind === 'flight' &&
        !t.occasionIds.includes(s.occasionId) &&
        s.startOn >= t.startsOn &&
        s.startOn <= addDays(t.startsOn, RETURN_WITHIN_DAYS) &&
        (s.returnHome || returns.has(s.occasionId) || samePlace(s.origin, { key: t.key, label: t.label, known: true })) &&
        s.dest.key !== t.key,
    );
    if (back && (back.startOn >= t.endsOn || !t.spanned)) {
      if (back.startOn > t.endsOn) t.endsOn = back.startOn;
      t.occasionIds.push(back.occasionId);
    }
  }
  return trips.map(({ spanned: _spanned, ...t }) => ({ ...t, occasionIds: [...new Set(t.occasionIds)] }));
}

// ---------------------------------------------------------------------------------------------- people

export interface TripMatch {
  personId: string;
  reason: TripMatchReason;
  detail: string | null;
  score: number;
  factId: string | null;
}

const REASON_RANK: Record<TripMatchReason, number> = { location_current: 0, location_next: 1, travel_plan: 2, addressbook: 3, legacy_location: 4, partiful: 5 };

export interface PeopleIndex {
  facts: Map<string, LocationFact[]>;
  /** person → Partiful events attended (time, parsed place). */
  partiful: Map<string, { at: number; place: Place }[]>;
  /** person → saved (legacy) locations as places. */
  saved: Map<string, Place[]>;
}

export function peopleIndex(db: DB, now: number): PeopleIndex {
  // Records of mine (identity/self.ts) are never "someone" at my destination: my own facts are the home base.
  const self = selfPeople(db);
  const facts = factsByPerson(locationFacts(db));
  const partiful = new Map<string, { at: number; place: Place }[]>();
  const evRows = db
    .prepare(
      `SELECT DISTINCT pv.id AS person_id, e.starts_at AS at, e.location_text AS loc
       FROM event_attendees a JOIN events e ON e.id = a.event_id
       JOIN person_canon pc ON pc.person_id = a.person_id JOIN person_visible pv ON pv.id = pc.canonical_id
       WHERE e.source = 'partiful' AND e.location_text IS NOT NULL AND e.starts_at IS NOT NULL AND e.starts_at >= ?
         AND lower(a.status) IN ('going','approved','checked_in','attended','host')`,
    )
    .all(now - PARTIFUL_LOOKBACK_MS - TRIP_WINDOW.aheadDays * DAY) as { person_id: string; at: number; loc: string }[];
  for (const r of evRows) {
    if (self.has(r.person_id)) continue;
    const place = parsePlace(r.loc, 'venue_address');
    if (place) partiful.set(r.person_id, [...(partiful.get(r.person_id) ?? []), { at: r.at, place }]);
  }
  const saved = new Map<string, Place[]>();
  const locRows = db
    .prepare(
      `SELECT DISTINCT pv.id AS person_id, l.name FROM person_locations pl JOIN locations l ON l.id = pl.location_id AND l.status = 'active'
       JOIN person_canon pc ON pc.person_id = pl.person_id JOIN person_visible pv ON pv.id = pc.canonical_id`,
    )
    .all() as { person_id: string; name: string }[];
  for (const r of locRows) {
    if (self.has(r.person_id)) continue;
    const place = parsePlace(r.name, 'name');
    if (place) saved.set(r.person_id, [...(saved.get(r.person_id) ?? []), place]);
  }
  return { facts, partiful, saved };
}

const tieScore = (db: DB, personId: string): number => {
  const s = statsOf(db, personId);
  return Math.round(((0.6 * (s.tie ?? 0) + 0.4 * (s.historical ?? 0)) / 100) * 1000) / 1000;
};

/** People at `dest` during [startOn, endOn], best reason each, ranked by 0.6·T + 0.4·H. */
export function matchPeople(db: DB, idx: PeopleIndex, trip: { key: string; startsOn: string; endsOn: string }, timeZone: string): TripMatch[] {
  const dest = { key: trip.key, label: '', known: true };
  const startMs = dayStart(trip.startsOn, timeZone);
  const endMs = dayStart(addDays(trip.endsOn, 1), timeZone);
  const people = new Set([...idx.facts.keys(), ...idx.partiful.keys(), ...idx.saved.keys()]);
  const out: TripMatch[] = [];
  for (const pid of people) {
    const facts = idx.facts.get(pid);
    const home = livesIn(facts, startMs);
    const candidates: { reason: TripMatchReason; detail: string | null; factId: string | null }[] = [];
    if (home && samePlace(home.place, dest)) {
      const reason = reasonOfLives(home);
      const detail =
        reason === 'location_next'
          ? `moving there${home.validFrom ? ` ${monthOf(home.validFrom, timeZone)}` : ''}`
          : reason === 'location_current'
            ? `lives there${home.validFrom ? ` since ${monthOf(home.validFrom, timeZone)}` : ''}`
            : reason === 'legacy_location'
              ? 'saved location'
              : 'address book';
      candidates.push({ reason, detail, factId: home.id });
    }
    // Their own travel plan there on overlapping dates (even when they live elsewhere).
    for (const f of facts ?? []) {
      if (f.type !== 'travel_plan' || f.validFrom === null || !samePlace(f.place, dest)) continue;
      const to = f.validTo ?? f.validFrom + DAY;
      if (f.validFrom < endMs && to >= startMs) {
        const from = localDate(f.validFrom, timeZone);
        const until = localDate(to, timeZone);
        candidates.push({ reason: 'travel_plan', detail: `there ${shortDate(from)}${until !== from ? `–${shortDate(until)}` : ''}`, factId: f.id });
      }
    }
    // Weaker hints only when nothing says they live somewhere else.
    if (!home || samePlace(home.place, dest)) {
      const ev = (idx.partiful.get(pid) ?? []).filter((e) => samePlace(e.place, dest) && e.at <= startMs && e.at >= startMs - PARTIFUL_LOOKBACK_MS);
      if (ev.length) {
        const latest = Math.max(...ev.map((e) => e.at));
        candidates.push({ reason: 'partiful', detail: `Partiful event there in ${monthOf(latest, timeZone)}`, factId: null });
      }
      if ((idx.saved.get(pid) ?? []).some((p) => samePlace(p, dest))) candidates.push({ reason: 'legacy_location', detail: 'saved location', factId: null });
    }
    if (!candidates.length) continue;
    candidates.sort((a, b) => REASON_RANK[a.reason] - REASON_RANK[b.reason]);
    out.push({ personId: pid, ...candidates[0]!, score: tieScore(db, pid) });
  }
  return out.sort((a, b) => b.score - a.score || REASON_RANK[a.reason] - REASON_RANK[b.reason] || (a.personId < b.personId ? -1 : 1)).slice(0, MAX_TRIP_PEOPLE);
}

// ---------------------------------------------------------------------------------------------- visitors

export interface VisitorMatch {
  personId: string;
  factId: string;
  startsOn: string;
  endsOn: string | null;
  startsAt: number;
  endsAt: number | null;
}

/** People whose travel_plan brings them to the home metro (and who don't live there), by their start date. */
export function visitors(db: DB, o: { home: Place | null; timeZone: string; from: number; to: number; idx?: PeopleIndex; now: number }): VisitorMatch[] {
  if (!o.home) return [];
  const idx = o.idx?.facts ?? factsByPerson(locationFacts(db));
  const out: VisitorMatch[] = [];
  for (const [pid, facts] of idx) {
    for (const f of facts) {
      if (f.type !== 'travel_plan' || f.validFrom === null || !samePlace(f.place, o.home)) continue;
      const end = f.validTo ?? f.validFrom;
      if (end < o.from || f.validFrom >= o.to) continue;
      const lives = livesIn(facts, f.validFrom);
      if (lives && samePlace(lives.place, o.home)) continue;
      out.push({
        personId: pid,
        factId: f.id,
        startsOn: localDate(f.validFrom, o.timeZone),
        endsOn: f.validTo !== null ? localDate(f.validTo, o.timeZone) : null,
        startsAt: f.validFrom,
        endsAt: f.validTo,
      });
    }
  }
  return out.sort((a, b) => a.startsAt - b.startsAt || (a.personId < b.personId ? -1 : 1));
}

// ---------------------------------------------------------------------------------------------- refresh

export interface TripRefreshStats {
  segments: number;
  trips: number;
  created: number;
  updated: number;
  removed: number;
  matched: number;
}

interface StoredTrip {
  id: string;
  geo_key: string;
  label: string | null;
  starts_on: string;
  ends_on: string;
  source_event_ids: string;
  kinds: string;
  home_key: string | null;
}

export const TRIPS_REFRESHED = 'trips_refreshed_at';

/**
 * One trips pass as small steps (the 'intel' job drives it with event-loop yields): detect → upsert trips in the
 * window → remove undetected ones → re-match people for trips that aren't long over.
 */
export function* refreshTripsSteps(db: DB, o: { now: number; timeZone: string }): Generator<void, TripRefreshStats> {
  const stats: TripRefreshStats = { segments: 0, trips: 0, created: 0, updated: 0, removed: 0, matched: 0 };
  const home = homePlace(db, o.now);
  const from = o.now - TRIP_WINDOW.backDays * DAY;
  const to = o.now + TRIP_WINDOW.aheadDays * DAY;
  const segments = collectSegments(db, { from, to, timeZone: o.timeZone, home });
  stats.segments = segments.length;
  const detected = buildTrips(segments);
  stats.trips = detected.length;
  yield;
  const fromDay = localDate(from, o.timeZone);
  const toDay = localDate(to, o.timeZone);
  const keep = new Set<string>();
  tx(db, () => {
    const find = db.prepare('SELECT * FROM trips WHERE geo_key = ? AND starts_on = ?');
    for (const t of detected) {
      const cur = find.get(t.key, t.startsOn) as StoredTrip | undefined;
      const fields = {
        label: t.label,
        ends_on: t.endsOn,
        source_event_ids: JSON.stringify([...t.occasionIds].sort()),
        kinds: JSON.stringify([...t.kinds].sort()),
        home_key: home?.key ?? null,
      };
      if (!cur) {
        const id = uuidv7(o.now);
        db.prepare(
          `INSERT INTO trips (id, geo_key, label, starts_on, ends_on, source_event_ids, kinds, home_key, created_at, updated_at)
           VALUES (@id, @geo_key, @label, @starts_on, @ends_on, @source_event_ids, @kinds, @home_key, @now, @now)`,
        ).run({ id, geo_key: t.key, starts_on: t.startsOn, ...fields, now: o.now });
        keep.add(id);
        stats.created++;
      } else {
        keep.add(cur.id);
        const changed = cur.label !== fields.label || cur.ends_on !== fields.ends_on || cur.source_event_ids !== fields.source_event_ids || cur.kinds !== fields.kinds || cur.home_key !== fields.home_key;
        db.prepare(
          `UPDATE trips SET label = @label, ends_on = @ends_on, source_event_ids = @source_event_ids, kinds = @kinds, home_key = @home_key, updated_at = @now WHERE id = @id`,
        ).run({ id: cur.id, ...fields, now: o.now });
        if (changed) stats.updated++;
      }
    }
    const stale = (db.prepare('SELECT id FROM trips WHERE starts_on >= ? AND starts_on <= ?').pluck().all(fromDay, toDay) as string[]).filter((id) => !keep.has(id));
    for (const id of stale) {
      db.prepare('DELETE FROM trip_people WHERE trip_id = ?').run(id);
      db.prepare('DELETE FROM trips WHERE id = ?').run(id);
      stats.removed++;
    }
  });
  yield;
  // People for trips that are upcoming or ended in the last 60 days.
  const idx = peopleIndex(db, o.now);
  const recent = db.prepare(`SELECT id, geo_key, starts_on, ends_on FROM trips WHERE ends_on >= ? ORDER BY starts_on`).all(addDays(localDate(o.now, o.timeZone), -60)) as {
    id: string;
    geo_key: string;
    starts_on: string;
    ends_on: string;
  }[];
  for (const t of recent) {
    const matches = matchPeople(db, idx, { key: t.geo_key, startsOn: t.starts_on, endsOn: t.ends_on }, o.timeZone);
    tx(db, () => {
      db.prepare('DELETE FROM trip_people WHERE trip_id = ?').run(t.id);
      const ins = db.prepare(
        `INSERT INTO trip_people (trip_id, person_id, reason, detail, score, fact_id, computed_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const m of matches) ins.run(t.id, m.personId, m.reason, m.detail, Math.min(1, Math.max(0, m.score)), m.factId, o.now);
    });
    stats.matched += matches.length;
    yield;
  }
  db.prepare(
    `INSERT INTO intel_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(TRIPS_REFRESHED, JSON.stringify(o.now), o.now);
  return stats;
}

/** When the trips were last rebuilt (ms), or null. */
export function tripsRefreshedAt(db: DB): number | null {
  const raw = db.prepare('SELECT value FROM intel_state WHERE key = ?').pluck().get(TRIPS_REFRESHED) as string | undefined;
  return raw === undefined ? null : (JSON.parse(raw) as number);
}

export interface StoredTripView {
  id: string;
  key: string;
  label: string | null;
  startsOn: string;
  endsOn: string;
  occasionIds: string[];
  people: TripMatch[];
}

/** Stored trips overlapping [fromDay, toDay] (inclusive), with their people. */
export function storedTrips(db: DB, o: { fromDay?: string; toDay?: string; order?: 'asc' | 'desc' }): StoredTripView[] {
  const rows = db
    .prepare(
      `SELECT * FROM trips WHERE (@from IS NULL OR ends_on >= @from) AND (@to IS NULL OR starts_on <= @to)
       ORDER BY starts_on ${o.order === 'desc' ? 'DESC' : 'ASC'}, id`,
    )
    .all({ from: o.fromDay ?? null, to: o.toDay ?? null }) as StoredTrip[];
  const peopleOf = db.prepare(
    `SELECT tp.person_id AS personId, tp.reason, tp.detail, tp.score, tp.fact_id AS factId
     FROM trip_people tp JOIN person_visible pv ON pv.id = tp.person_id
     WHERE tp.trip_id = ? ORDER BY tp.score DESC, tp.person_id`,
  );
  return rows.map((r) => ({
    id: r.id,
    key: r.geo_key,
    label: r.label,
    startsOn: r.starts_on,
    endsOn: r.ends_on,
    occasionIds: JSON.parse(r.source_event_ids) as string[],
    people: peopleOf.all(r.id) as TripMatch[],
  }));
}

/** Days from today (local) until `date`. */
export const daysUntil = (date: string, now: number, timeZone: string): number => daysBetween(localDate(now, timeZone), date);
