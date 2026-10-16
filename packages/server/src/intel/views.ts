/**
 * Read models for the intel routes: GET /trips (TripsResponse) — trips with the people you know there and
 * visitors coming to your city. People come through person_visible (never hidden, merged or roster-only people);
 * phones and emails never appear (names are masked like everywhere else).
 */
import type { PersonChip, Trip, TripsResponse, Visitor } from '@yb/shared';
import type { DB } from '../db/connection';
import { hiddenNameRedactor, maskText } from '../routes/people';
import { settingTimeZone } from '../settings/registry';
import { DAY, HOUR, addDays, dayStart, drain, localDate } from './common';
import { homePlace, refreshTripsSteps, storedTrips, tripsRefreshedAt, visitors } from './trips';

/** GET /trips rebuilds the trips first when the nightly pass is this old (calendar edits show up the same day). */
export const TRIPS_STALE_MS = 6 * HOUR;

function chipMap(db: DB, ids: readonly string[]): Map<string, PersonChip> {
  const out = new Map<string, PersonChip>();
  if (!ids.length) return out;
  const rows = db
    .prepare(
      `SELECT pv.id, pv.display_name, pv.first_name, ps.state FROM person_visible pv LEFT JOIN person_stats ps ON ps.person_id = pv.id
       WHERE pv.id IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify([...new Set(ids)])) as { id: string; display_name: string; first_name: string | null; state: PersonChip['state'] }[];
  for (const r of rows) out.set(r.id, { id: r.id, displayName: maskText(r.display_name), firstName: r.first_name, state: r.state ?? null });
  return out;
}

export function tripsResponse(db: DB, when: 'upcoming' | 'past' | 'all', o: { now: number; timeZone?: string; refresh?: boolean }): TripsResponse {
  const timeZone = o.timeZone ?? settingTimeZone(db);
  if (o.refresh !== false) {
    const at = tripsRefreshedAt(db);
    if (at === null || o.now - at > TRIPS_STALE_MS) drain(refreshTripsSteps(db, { now: o.now, timeZone }));
  }
  const today = localDate(o.now, timeZone);
  const trips =
    when === 'upcoming'
      ? storedTrips(db, { fromDay: today })
      : when === 'past'
        ? storedTrips(db, { fromDay: addDays(today, -365), toDay: addDays(today, -1), order: 'desc' }).filter((t) => t.endsOn < today)
        : storedTrips(db, {});
  const suggestionOf = db.prepare(`SELECT id FROM suggestions WHERE kind = 'travel_overlap' AND trip_id = ? ORDER BY created_at DESC LIMIT 1`).pluck();
  const home = homePlace(db, o.now);
  const todayStart = dayStart(today, timeZone);
  const vis = visitors(db, {
    home,
    timeZone,
    now: o.now,
    from: when === 'upcoming' ? todayStart : todayStart - 365 * DAY,
    to: when === 'past' ? todayStart : todayStart + 366 * DAY,
  }).filter((v) => (when === 'past' ? (v.endsAt ?? v.startsAt) < todayStart : when === 'upcoming' ? (v.endsAt ?? v.startsAt) >= todayStart : true));
  const chips = chipMap(db, [...trips.flatMap((t) => t.people.map((p) => p.personId)), ...vis.map((v) => v.personId)]);
  const visitorSuggestion = db.prepare(`SELECT id FROM suggestions WHERE kind = 'travel_overlap' AND dedupe_key = ? ORDER BY created_at DESC LIMIT 1`).pluck();
  // A place written as a name ("Trip to Lakeside") could be a hidden person's name: blank it like titles.
  const redact = hiddenNameRedactor(db);
  return {
    trips: trips.map((t): Trip => {
      const label = t.key.startsWith('metro:') ? t.label : redact(t.label);
      return {
        id: t.id,
        label,
        geoKey: label === t.label ? t.key : 'place:redacted',
        startsOn: t.startsOn,
        endsOn: t.endsOn,
        sourceEventIds: t.occasionIds,
        people: t.people
          .filter((p) => chips.has(p.personId))
          .map((p) => ({ person: chips.get(p.personId)!, reason: p.reason, detail: p.detail, score: p.score, factId: p.factId })),
        suggestionId: (suggestionOf.get(t.id) as string | undefined) ?? null,
      };
    }),
    visitors: vis
      .filter((v) => chips.has(v.personId))
      .map(
        (v): Visitor => ({
          person: chips.get(v.personId)!,
          startsOn: v.startsOn,
          endsOn: v.endsOn,
          factId: v.factId,
          suggestionId: (visitorSuggestion.get(`travel_overlap:visit:${v.factId}`) as string | undefined) ?? null,
        }),
      ),
    home: home?.label ?? null,
  };
}
