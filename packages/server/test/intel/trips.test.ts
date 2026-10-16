import { beforeEach, describe, expect, it } from 'vitest';
import { drain } from '../../src/intel/common';
import { travelOverlapGenerator } from '../../src/intel/generators';
import { buildTrips, homePlace, refreshTripsSteps, storedTrips, type TripSegment } from '../../src/intel/trips';
import { tripsResponse } from '../../src/intel/views';
import { nullLogger } from '../../src/ops/logger';
import { runOccasions } from '../../src/pipeline/occasions/run';
import type { GeneratorContext } from '../../src/pipeline/suggestions/types';
import { settingsSnapshot } from '../../src/settings/registry';
import { DAY, HOUR, intelWorld, NOW, setSetting, TZ, type IntelWorld } from './world';

let w: IntelWorld;
let avery: string, blake: string, casey: string, drew: string, hal: string, emery: string, finn: string;

const refresh = (now = NOW) => {
  runOccasions(w.db, { now, timeZone: TZ });
  return drain(refreshTripsSteps(w.db, { now, timeZone: TZ }));
};
const ctx = (now = NOW): GeneratorContext => ({ db: w.db, now, timeZone: TZ, settings: settingsSnapshot(w.db), runId: null, log: nullLogger });
const day = (m: number, d: number, h = 0) => Date.UTC(2026, m - 1, d, h);

beforeEach(() => {
  w = intelWorld();
  setSetting(w.db, 'travel.home_city', 'San Francisco');
  avery = w.person('Avery', 'Quill', { tie: 60, historical: 70 });
  blake = w.person('Blake', 'Ruin', { tie: 20, historical: 40 });
  casey = w.person('Casey', 'Dune', { tie: 80, historical: 80 });
  drew = w.person('Drew', 'Pike', { tie: 30, historical: 30 });
  hal = w.person('Hal', 'Hidden', { tie: 90, historical: 90, extra: { is_hidden: 1 } });
  emery = w.person('Emery', 'Vale', { tie: 50, historical: 50 });
  finn = w.person('Finn', 'Local', { tie: 40, historical: 40 });
  w.fact(avery, 'location_current', 'Austin, TX', { validFrom: day(3, 1) });
  w.fact(blake, 'home_location', 'Austin, TX', { source: 'legacy' });
  // Casey moved away: the newer location fact wins over an old address there.
  w.fact(casey, 'address', '1 Example Rd, Austin, TX 78701', { conf: 1, source: 'legacy' });
  w.fact(casey, 'location_current', 'Denver', { validFrom: day(6, 1) });
  w.fact(drew, 'location_current', 'Boston');
  w.fact(drew, 'travel_plan', 'Austin trip', { validFrom: day(10, 20), validTo: day(10, 21) });
  w.fact(hal, 'location_current', 'Austin');
  w.fact(emery, 'location_current', 'Denver');
  w.fact(emery, 'travel_plan', 'visiting San Francisco', { validFrom: day(10, 16), validTo: day(10, 18) });
  w.fact(finn, 'location_current', 'San Francisco');
  w.fact(finn, 'travel_plan', 'SF', { validFrom: day(10, 16), validTo: day(10, 17) });

  // Austin: out Mon, hotel, back Thu. Plus a past all-day Lisbon trip and an ordinary dinner at home.
  w.cal({ summary: 'Flight to Austin (UA 1234)', location: 'San Francisco SFO', start: day(10, 19, 15), end: day(10, 19, 19) });
  w.cal({ summary: 'Stay at Example Hotel', location: '100 Example Blvd, Austin, TX 78701', start: day(10, 19, 21), end: day(10, 22, 16) });
  w.cal({ summary: 'Flight to SFO', location: 'Austin AUS', start: day(10, 22, 18), end: day(10, 22, 22) });
  w.cal({ summary: 'Lisbon trip', start: day(8, 1), end: day(8, 6), allDay: true });
  w.cal({ summary: 'Dinner w/ Avery', location: 'Moss & Fern, 1 Example St, San Francisco, CA', start: day(10, 25, 19) });
  w.cal({ summary: 'PTO', start: day(11, 2), end: day(11, 5), allDay: true });
});

describe('trip detection', () => {
  it('home comes from the setting, else the owner’s own location fact', () => {
    expect(homePlace(w.db, NOW)?.key).toBe('metro:sf-bay');
    setSetting(w.db, 'travel.home_city', null);
    expect(homePlace(w.db, NOW)).toBeNull();
    w.fact(w.me, 'location_current', 'Brooklyn, NY');
    expect(homePlace(w.db, NOW)?.key).toBe('metro:nyc');
  });

  it('flights + lodging to one city form one trip, closed by the flight home; place-less PTO and home dinners are not trips', () => {
    const stats = refresh();
    expect(stats.created).toBe(2);
    const trips = storedTrips(w.db, {});
    expect(trips.map((t) => [t.key, t.label, t.startsOn, t.endsOn])).toEqual([
      ['metro:lisbon', 'Lisbon', '2026-08-01', '2026-08-05'],
      ['metro:austin', 'Austin', '2026-10-19', '2026-10-22'],
    ]);
    expect(trips[1]!.occasionIds).toHaveLength(3);
    // a second pass keeps the ids and changes nothing
    const ids = trips.map((t) => t.id);
    const again = refresh();
    expect(again.created).toBe(0);
    expect(again.removed).toBe(0);
    expect(storedTrips(w.db, {}).map((t) => t.id)).toEqual(ids);
  });

  it('a social occasion at a known metro other than home is a trip too; one at home is not', () => {
    w.cal({ summary: 'Wedding party', location: 'Example Hall, 5 Example Ave, Denver, CO 80202', start: day(11, 7, 17), end: day(11, 7, 23) });
    refresh();
    const denver = storedTrips(w.db, {}).find((t) => t.key === 'metro:denver');
    expect(denver).toMatchObject({ label: 'Denver', startsOn: '2026-11-07', endsOn: '2026-11-07' });
    expect(denver!.people.map((p) => p.personId).sort()).toEqual([casey, emery].sort());
    expect(storedTrips(w.db, {}).some((t) => t.key === 'metro:sf-bay')).toBe(false);
  });

  it('a trip whose events go away is removed', () => {
    refresh();
    w.db.prepare(`UPDATE calendar_events SET status = 'cancelled' WHERE summary LIKE 'Lisbon%'`).run();
    const stats = refresh();
    expect(stats.removed).toBe(1);
    expect(storedTrips(w.db, {}).map((t) => t.key)).toEqual(['metro:austin']);
  });

  it('without a known home, the flight back to where the trip started closes it (no trip "to home")', () => {
    const seg = (id: string, kind: TripSegment['kind'], startOn: string, endOn: string, dest: string, origin: string | null): TripSegment => ({
      occasionId: id,
      kind,
      startOn,
      endOn,
      dest: { key: dest, label: dest, known: true },
      returnHome: false,
      origin: origin ? { key: origin, label: origin, known: true } : null,
    });
    const trips = buildTrips([
      seg('a', 'flight', '2026-10-19', '2026-10-19', 'metro:austin', 'metro:sf-bay'),
      seg('b', 'flight', '2026-10-22', '2026-10-22', 'metro:sf-bay', 'metro:austin'),
    ]);
    expect(trips.map((t) => [t.key, t.startsOn, t.endsOn])).toEqual([['metro:austin', '2026-10-19', '2026-10-22']]);
  });
});

describe('who you know there', () => {
  it('matches current homes, address-book cities and travel plans; never hidden people or people who moved away', () => {
    refresh();
    const austin = storedTrips(w.db, {}).find((t) => t.key === 'metro:austin')!;
    expect(austin.people.map((p) => [p.personId, p.reason])).toEqual([
      [avery, 'location_current'],
      [drew, 'travel_plan'],
      [blake, 'addressbook'],
    ]);
    expect(austin.people[0]).toMatchObject({ detail: 'lives there since Mar', score: 0.64 });
    expect(austin.people[1]!.detail).toBe('there Oct 20–Oct 21');
    const ids = austin.people.map((p) => p.personId);
    expect(ids).not.toContain(hal);
    expect(ids).not.toContain(casey);
  });
});

describe('travel_overlap candidates', () => {
  it('3–10 days before departure: top people by 0.6·T + 0.4·H, forced in on the last eligible day', async () => {
    refresh();
    const trip = (await travelOverlapGenerator.generate(ctx())).filter((c) => !c.subjectKey.startsWith('visit:'));
    expect(trip).toHaveLength(1);
    expect(trip[0]).toMatchObject({
      kind: 'travel_overlap',
      personIds: [avery, drew, blake],
      base: 0.75,
      timeCritical: false,
      links: { tripId: expect.any(String) },
      payload: { city: 'Austin', tripDays: 4, daysUntil: 5 },
    });
    expect(trip[0]!.expiresAt).toBe(day(10, 19));
    const close = (await travelOverlapGenerator.generate(ctx(day(10, 16, 9)))).filter((c) => !c.subjectKey.startsWith('visit:'));
    expect(close[0]!.timeCritical).toBe(true);
    expect((await travelOverlapGenerator.generate(ctx(day(10, 17, 9)))).filter((c) => !c.subjectKey.startsWith('visit:'))).toHaveLength(0);
    expect((await travelOverlapGenerator.generate(ctx(day(10, 5, 9)))).filter((c) => !c.subjectKey.startsWith('visit:'))).toHaveLength(0);
  });

  it('the inverse case: someone who lives elsewhere coming to your city, 1–3 days before', async () => {
    refresh();
    const visits = (await travelOverlapGenerator.generate(ctx())).filter((c) => c.subjectKey.startsWith('visit:'));
    expect(visits).toHaveLength(1);
    expect(visits[0]).toMatchObject({ personIds: [emery], timeCritical: true, payload: { inverse: true, city: 'SF Bay Area', daysUntil: 2 } });
    expect(visits[0]!.personIds).not.toContain(finn);
  });
});

describe('GET /trips read model', () => {
  it('upcoming trips with people, visitors and the home label; past trips separately', () => {
    runOccasions(w.db, { now: NOW, timeZone: TZ });
    const up = tripsResponse(w.db, 'upcoming', { now: NOW, timeZone: TZ });
    expect(up.home).toBe('SF Bay Area');
    expect(up.trips.map((t) => t.label)).toEqual(['Austin']);
    expect(up.trips[0]!.people.map((p) => p.person.id)).toEqual([avery, drew, blake]);
    expect(up.trips[0]!.people[0]!.person).toMatchObject({ displayName: 'Avery Quill', firstName: 'Avery' });
    expect(up.visitors.map((v) => v.person.id)).toEqual([emery]);
    expect(JSON.stringify(up)).not.toContain('Hidden');
    const past = tripsResponse(w.db, 'past', { now: NOW, timeZone: TZ });
    expect(past.trips.map((t) => t.label)).toEqual(['Lisbon']);
    // a fresh rebuild happened (stale) and a second read within the window doesn't rebuild
    const again = tripsResponse(w.db, 'upcoming', { now: NOW + HOUR, timeZone: TZ });
    expect(again.trips[0]!.id).toBe(up.trips[0]!.id);
    expect(NOW + DAY).toBeGreaterThan(NOW);
  });
});
