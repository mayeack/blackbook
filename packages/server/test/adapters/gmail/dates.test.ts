/**
 * The deterministic date post-check (adapters/gmail/dates.ts): JSON-LD first, the year re-picked into
 * [email − 1 d, email + 18 mo] on the named weekday (New Year included), the owner's zone as a flagged guess, and the
 * end defaults.
 */
import { describe, expect, it } from 'vitest';
import { inferYear, parseWall, resolveDates, type DateInput } from '../../../src/adapters/gmail/dates';

const NY = 'America/New_York';
const LA = 'America/Los_Angeles';
const at = (y: number, mo: number, d: number, h = 12) => Date.UTC(y, mo - 1, d, h);
const base = (o: Partial<DateInput>): DateInput => ({
  kind: 'order',
  category: 'concert',
  startLocal: null,
  endLocal: null,
  timezone: null,
  jsonLdStart: null,
  jsonLdEnd: null,
  emailAt: at(2026, 10, 21),
  ownerTz: NY,
  ...o,
});

describe('year inference', () => {
  it('near New Year: a January show bought in December is next year (and on the named Saturday)', () => {
    const d = resolveDates(base({ emailAt: at(2026, 12, 20), startLocal: '2026-01-09T20:00', timezone: NY, weekdays: { '01-09': 6 } }));
    expect(d).toMatchObject({ startLocal: '2027-01-09T20:00', localDate: '2027-01-09', yearFixed: true, tz: NY });
    expect(d.startsAt).toBe(Date.UTC(2027, 0, 10, 1, 0)); // 20:00 EST
    // Without a weekday the window alone decides.
    expect(resolveDates(base({ emailAt: at(2026, 12, 20), startLocal: '2026-01-09T20:00' })).localDate).toBe('2027-01-09');
  });

  it('the weekday named next to the date picks between two years inside the window', () => {
    // Nov 7 is a Saturday in 2026 and a Sunday in 2027: the model's 2027 is in the window but on the wrong day.
    const w = parseWall('2027-11-07T20:00')!;
    expect(inferYear(w, NY, at(2026, 10, 21), { '11-07': 6 })).toBe(2026);
    expect(inferYear(w, NY, at(2026, 10, 21))).toBe(2027);
  });

  it('a start before the email date (minus a day) moves forward; a same-day reminder stays', () => {
    expect(resolveDates(base({ kind: 'reminder', emailAt: at(2026, 11, 7, 14), startLocal: '2025-11-07T20:00' })).localDate).toBe('2026-11-07');
    expect(resolveDates(base({ kind: 'reminder', emailAt: at(2026, 11, 7, 14), startLocal: '2026-11-07T20:00' })).yearFixed).toBe(false);
  });

  it('kinds about the past (refund, cancellation, resale) keep the year they were given', () => {
    expect(resolveDates(base({ kind: 'refund', emailAt: at(2026, 12, 20), startLocal: '2026-01-09T20:00' })).localDate).toBe('2026-01-09');
    expect(resolveDates(base({ kind: 'event_cancelled', emailAt: at(2026, 12, 20), startLocal: '2026-01-09T20:00' })).yearFixed).toBe(false);
  });

  it('an explicit JSON-LD year on the named weekday (or with none named) is kept, even past 18 months', () => {
    // Bought in April 2026 for "Thu, Jul 20" 2028.
    const far = { emailAt: at(2026, 4, 15), ownerTz: LA, category: 'sports' as const, jsonLdStart: '2028-07-20T19:00:00-07:00' };
    expect(resolveDates(base({ ...far, weekdays: { '07-20': 4 } }))).toMatchObject({ localDate: '2028-07-20', yearFixed: false, tz: LA, source: 'json_ld' });
    expect(resolveDates(base(far))).toMatchObject({ localDate: '2028-07-20', yearFixed: false });
    // A JSON-LD year on the wrong weekday is re-picked like the model's.
    expect(resolveDates(base({ emailAt: at(2026, 10, 21), jsonLdStart: '2027-11-07T20:00:00-05:00', weekdays: { '11-07': 6 } })).localDate).toBe('2026-11-07');
  });

  it('never a year on a weekday the mail contradicts: a transfer mailed days after the show keeps its year', () => {
    // Mon, Jul 20 2026; the transfer came back three days later. 2027-07-20 is a Tuesday.
    expect(inferYear(parseWall('2026-07-20T20:00')!, NY, at(2026, 7, 23), { '07-20': 1 })).toBe(2026);
    expect(resolveDates(base({ kind: 'transfer_back', emailAt: at(2026, 7, 23), startLocal: '2026-07-20T20:00', weekdays: { '07-20': 1 } }))).toMatchObject({
      localDate: '2026-07-20',
      yearFixed: false,
    });
  });

  it('no year fits the weekday and the given year contradicts it too: the window alone; nothing fits: the given year', () => {
    expect(inferYear(parseWall('2026-11-07T20:00')!, NY, at(2026, 10, 21), { '11-07': 2 })).toBe(2026);
    expect(inferYear(parseWall('2025-11-07T20:00')!, NY, at(2026, 10, 21), { '11-07': 2 })).toBe(2026);
    expect(inferYear(parseWall('2020-02-29T20:00')!, NY, at(2026, 10, 21))).toBe(2028); // the next Feb 29 inside 18 months
    expect(inferYear(parseWall('2020-02-29T20:00')!, NY, at(2026, 3, 1))).toBe(2020);
  });
});

describe('zones', () => {
  it('a null or invalid zone → the owner’s, flagged as a guess (tz null)', () => {
    const d = resolveDates(base({ startLocal: '2026-11-07T20:00' }));
    expect(d).toMatchObject({ tz: null, zone: NY, localDate: '2026-11-07', source: 'model' });
    expect(d.startsAt).toBe(Date.UTC(2026, 10, 8, 1, 0));
    expect(resolveDates(base({ startLocal: '2026-11-07T20:00', timezone: 'Mars/Olympus' })).tz).toBeNull();
    const la = resolveDates(base({ startLocal: '2026-11-07T20:00', timezone: LA }));
    expect(la).toMatchObject({ tz: LA, localDate: '2026-11-07' });
    expect(la.startsAt).toBe(Date.UTC(2026, 10, 8, 4, 0));
  });

  it('JSON-LD wins over the model; its offset confirms the owner’s zone, or pins the instant when it doesn’t match', () => {
    const d = resolveDates(base({ startLocal: '2026-11-08T19:00', jsonLdStart: '2026-11-07T20:00:00-05:00' }));
    expect(d).toMatchObject({ source: 'json_ld', tz: NY, localDate: '2026-11-07', startLocal: '2026-11-07T20:00' });
    expect(d.startsAt).toBe(Date.UTC(2026, 10, 8, 1, 0));
    const away = resolveDates(base({ ownerTz: LA, jsonLdStart: '2026-11-07T20:00:00-05:00' }));
    expect(away).toMatchObject({ tz: null, localDate: '2026-11-07', startLocal: '2026-11-07T20:00' });
    expect(away.startsAt).toBe(Date.UTC(2026, 10, 8, 1, 0));
  });
});

describe('offsets', () => {
  it('a UTC "…Z" JSON-LD start is a serialization: its wall clock is read in the venue’s zone (else the owner’s, guessed)', () => {
    const d = resolveDates(base({ timezone: NY, jsonLdStart: '2026-11-08T01:00:00Z' }));
    expect(d).toMatchObject({ tz: NY, localDate: '2026-11-07', startLocal: '2026-11-07T20:00', source: 'json_ld' });
    expect(d.startsAt).toBe(Date.UTC(2026, 10, 8, 1));
    const guessed = resolveDates(base({ jsonLdStart: '2026-11-08T01:00:00Z' }));
    expect(guessed).toMatchObject({ tz: null, localDate: '2026-11-07', startLocal: '2026-11-07T20:00' });
    expect(guessed.startsAt).toBe(Date.UTC(2026, 10, 8, 1));
    // An owner on UTC: the string is his own clock.
    expect(resolveDates(base({ ownerTz: 'UTC', jsonLdStart: '2026-11-08T01:00:00Z' }))).toMatchObject({ tz: 'UTC', localDate: '2026-11-08' });
  });

  it('a model zone the JSON-LD offset contradicts is dropped: the owner’s when it agrees, else none', () => {
    expect(resolveDates(base({ timezone: LA, jsonLdStart: '2026-11-07T20:00:00-05:00' }))).toMatchObject({ tz: NY, localDate: '2026-11-07', startLocal: '2026-11-07T20:00' });
    const none = resolveDates(base({ ownerTz: LA, timezone: 'Europe/Paris', jsonLdStart: '2026-11-07T20:00:00-05:00' }));
    expect(none).toMatchObject({ tz: null, localDate: '2026-11-07', startLocal: '2026-11-07T20:00', endLocal: '2026-11-08T00:00' });
    expect(none.startsAt).toBe(Date.UTC(2026, 10, 8, 1));
  });
});

describe('ends', () => {
  it('defaults by category: club 6 h, festival 10 h, anything else 4 h', () => {
    const start = '2026-11-07T22:00';
    const len = (category: DateInput['category']) => {
      const d = resolveDates(base({ startLocal: start, category }));
      return (d.endsAt! - d.startsAt!) / 3_600_000;
    };
    expect([len('club'), len('festival'), len('concert'), len('comedy')]).toEqual([6, 10, 4, 4]);
  });

  it('a stated end is used; an end before the start is the next day; a bare end date runs through that day', () => {
    const late = resolveDates(base({ startLocal: '2026-11-07T22:00', endLocal: '2026-11-07T02:00', category: 'club' }));
    expect((late.endsAt! - late.startsAt!) / 3_600_000).toBe(4);
    const fest = resolveDates(base({ startLocal: '2026-11-06T12:00', endLocal: '2026-11-08', category: 'festival' }));
    expect(fest.endLocal).toBe('2026-11-08T23:59');
    // A December → January festival crosses the year.
    const nye = resolveDates(base({ emailAt: at(2026, 12, 1), startLocal: '2026-12-31T18:00', endLocal: '2026-01-01T06:00', category: 'festival' }));
    expect(nye.endLocal).toBe('2027-01-01T06:00');
  });

  it('a date without a time starts in the evening (a festival at noon); no date at all → nothing', () => {
    expect(resolveDates(base({ startLocal: '2026-11-07' })).startLocal).toBe('2026-11-07T19:00');
    expect(resolveDates(base({ startLocal: '2026-11-07', category: 'festival' })).startLocal).toBe('2026-11-07T12:00');
    expect(resolveDates(base({}))).toMatchObject({ startsAt: null, endsAt: null, localDate: null, source: 'none' });
    expect(parseWall('2026-02-30T20:00')).toBeNull();
    expect(parseWall('next Saturday')).toBeNull();
  });
});
