import { describe, expect, it } from 'vitest';
import { calendarTreatments } from '../../../src/pipeline/occasions/calendars';
import { clusterEvents, loadCalendarEvents, occasionDays } from '../../../src/pipeline/occasions/build';
import { memDb, seedIdentity, seedPerson } from '../../helpers';
import { CAL, calEvent, DAY, evening, NOW } from './world';

function clusters(setup: (db: ReturnType<typeof memDb>) => void): string[][] {
  const db = memDb();
  const me = seedPerson(db, { kind: 'me', display_name: 'Me' });
  seedIdentity(db, me, 'email', CAL.personal);
  setup(db);
  const events = loadCalendarEvents(db, calendarTreatments(db), NOW - 400 * DAY, NOW + 90 * DAY);
  return clusterEvents(events)
    .map((c) => c.map((e) => e.title).sort())
    .sort((a, b) => (a[0]! < b[0]! ? -1 : 1));
}

describe('clustering calendar copies into occasions', () => {
  it('recurring instances share an iCal UID but stay separate days', () => {
    const got = clusters((db) => {
      for (const d of [-14, -7, 0]) calEvent(db, { summary: 'Run club', icalUid: 'series-1', start: evening(d, 7) });
    });
    expect(got).toEqual([['Run club'], ['Run club'], ['Run club']]);
  });

  it('two different plans at one venue need to be within 30 min; a reservation joins within 90', () => {
    const got = clusters((db) => {
      calEvent(db, { summary: 'Drinks w/ Quill', location: 'Moss & Fern', start: evening(-3, 18) });
      calEvent(db, { summary: 'Dinner w/ Romy', location: 'Moss & Fern', start: evening(-3, 19, 15) });
      calEvent(db, { summary: 'Reservation at Moss & Fern', location: 'Moss & Fern', start: evening(-3, 19, 30), eventType: 'fromGmail', creator: null });
    });
    expect(got).toEqual([['Dinner w/ Romy', 'Drinks w/ Quill', 'Reservation at Moss & Fern']]);
    // without the reservation bridging them, the two plans are separate
    expect(
      clusters((db) => {
        calEvent(db, { summary: 'Drinks w/ Quill', location: 'Moss & Fern', start: evening(-3, 18) });
        calEvent(db, { summary: 'Dinner w/ Romy', location: 'Moss & Fern', start: evening(-3, 19, 15) });
      }),
    ).toEqual([['Dinner w/ Romy'], ['Drinks w/ Quill']]);
  });

  it('the same event copied onto a second calendar; holidays are excluded', () => {
    const got = clusters((db) => {
      calEvent(db, { summary: 'Gallery opening', start: evening(-2) });
      calEvent(db, { calendar: CAL.community, summary: 'Gallery opening', start: evening(-2, 19, 30), creator: 'organizer@example.com' });
      calEvent(db, { calendar: CAL.holidays, summary: 'Columbus Day', start: Date.UTC(2026, 9, 12), allDay: true, creator: null });
      calEvent(db, { summary: 'Cancelled plan', start: evening(-1), status: 'cancelled' });
    });
    expect(got).toEqual([['Gallery opening', 'Gallery opening']]);
  });

  it('a reservation does not swallow an own event that is not a social plan', () => {
    const got = clusters((db) => {
      calEvent(db, { summary: 'Call with the bank', start: evening(-4) });
      calEvent(db, { summary: 'Reservation at Lupine Room', location: 'Lupine Room', start: evening(-4, 19, 30), eventType: 'fromGmail', creator: null });
    });
    expect(got).toEqual([['Call with the bank'], ['Reservation at Lupine Room']]);
  });
});

describe('occasion days', () => {
  it('local dates for timed events; UTC dates for all-day events stored at UTC midnight', () => {
    expect([...occasionDays(Date.UTC(2026, 9, 10, 23, 30), Date.UTC(2026, 9, 11, 1, 30), false, 'UTC')]).toEqual(['2026-10-10', '2026-10-11']);
    expect([...occasionDays(Date.UTC(2026, 9, 10, 2), Date.UTC(2026, 9, 10, 4), false, 'America/New_York')]).toEqual(['2026-10-09']);
    expect([...occasionDays(Date.UTC(2026, 9, 24), Date.UTC(2026, 9, 27), true, 'America/New_York')]).toEqual(['2026-10-24', '2026-10-25', '2026-10-26']);
  });
});
