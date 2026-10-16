import { describe, expect, it } from 'vitest';
import {
  GoogleApiError,
  GoogleAuthError,
  GoogleEgressRefusedError,
  guardedFetch,
  mapGoogleError,
  SyncTokenGoneError,
  type FetchLike,
} from '../../../src/adapters/calendar/google';
import { partifulEventId, toRow } from '../../../src/adapters/calendar/mapping';
import { dateTimeToUtc, dateToUtc, resolveTime, zonedToUtc } from '../../../src/adapters/calendar/time';
import { defaultTreatment } from '../../../src/adapters/calendar/treatment';
import { CAL } from './fakeGoogle';

describe('guardedFetch (read-only allowlist)', () => {
  const seen: string[] = [];
  const inner: FetchLike = async (input, init) => {
    seen.push(`${init?.method ?? 'GET'} ${String(input)}`);
    return new Response('{}', { status: 200 });
  };
  const f = guardedFetch(inner);

  it('passes the OAuth token/revoke POSTs and the two Calendar GETs', async () => {
    seen.length = 0;
    await f(new URL('https://oauth2.googleapis.com/token'), { method: 'POST' });
    await f('https://oauth2.googleapis.com/revoke?token=x', { method: 'POST' });
    await f('https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250');
    await f(new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true'), { method: 'GET' });
    expect(seen).toHaveLength(4);
  });

  it('refuses writes, other Calendar endpoints and other hosts before anything is sent', async () => {
    seen.length = 0;
    const refused = [
      ['https://www.googleapis.com/calendar/v3/calendars/primary/events', 'POST'],
      ['https://www.googleapis.com/calendar/v3/calendars/primary/events/abc', 'PUT'],
      ['https://www.googleapis.com/calendar/v3/calendars/primary/events/abc', 'DELETE'],
      ['https://www.googleapis.com/calendar/v3/calendars/primary/events/abc', 'GET'],
      ['https://www.googleapis.com/calendar/v3/calendars/primary/events/watch', 'POST'],
      ['https://www.googleapis.com/calendar/v3/calendars/primary/acl', 'GET'],
      ['https://www.googleapis.com/gmail/v1/users/me/messages', 'GET'],
      ['https://oauth2.googleapis.com/token', 'GET'],
      ['http://oauth2.googleapis.com/token', 'POST'],
      ['https://evil.example/calendar/v3/users/me/calendarList', 'GET'],
    ] as const;
    for (const [url, method] of refused) {
      await expect(f(url, { method }), `${method} ${url}`).rejects.toBeInstanceOf(GoogleEgressRefusedError);
    }
    expect(seen).toEqual([]);
  });
});

describe('mapGoogleError', () => {
  const gaxios = (status: number, data: unknown) => Object.assign(new Error('Request failed'), { name: 'GaxiosError', status, response: { status, data } });

  it('maps OAuth and API failures to typed errors without keeping the original', () => {
    expect(mapGoogleError(gaxios(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }))).toBeInstanceOf(GoogleAuthError);
    expect(mapGoogleError(gaxios(401, { error: { code: 401, errors: [{ reason: 'authError' }] } }))).toBeInstanceOf(GoogleAuthError);
    const gone = mapGoogleError(gaxios(410, { error: { code: 410, errors: [{ reason: 'fullSyncRequired' }] } }));
    expect(gone).toBeInstanceOf(SyncTokenGoneError);
    const forbidden = mapGoogleError(gaxios(403, { error: { code: 403, errors: [{ reason: 'rateLimitExceeded' }] } })) as GoogleApiError;
    expect(forbidden).toBeInstanceOf(GoogleApiError);
    expect([forbidden.status, forbidden.reason]).toEqual([403, 'rateLimitExceeded']);
    expect((mapGoogleError(Object.assign(new Error('x'), { code: 'ECONNRESET' })) as GoogleApiError).reason).toBe('ECONNRESET');
    // A refusal raised inside the transport surfaces as itself.
    const refusal = new GoogleEgressRefusedError('POST', 'https://www.googleapis.com');
    expect(mapGoogleError(Object.assign(new Error('wrapped'), { cause: refusal }))).toBe(refusal);
  });

  it('never carries free text from the response into the message', () => {
    const e = mapGoogleError(gaxios(400, { error: { code: 400, errors: [{ reason: 'Dinner w/ Avery Quill' }], message: 'owner@example.com' } }));
    expect(e.message).not.toMatch(/Avery|example/);
  });
});

describe('default treatments', () => {
  it('follows the PLAN table', () => {
    const d = (id: string, o: Record<string, unknown> = {}) => defaultTreatment({ id, accessRole: 'reader', ...o });
    expect(d(CAL.primary, { primary: true, accessRole: 'owner' })).toEqual({ kind: 'primary', treatment: 'attending', partifulLinked: false });
    expect(d('c-personal' + '@group.calendar.google.com', { summary: 'Personal', accessRole: 'owner' }).treatment).toBe('attending');
    expect(d(CAL.partiful, { summary: 'Partiful' })).toEqual({ kind: 'partiful_feed', treatment: 'attending', partifulLinked: true });
    expect(d(CAL.partiful, { summary: 'events', summaryOverride: 'My Partiful' }).kind).toBe('partiful_feed');
    expect(d(CAL.otherFeed, { summary: 'Team schedule' })).toMatchObject({ kind: 'subscribed', treatment: 'classify' });
    expect(d(CAL.community, { summary: 'Neighborhood Board' })).toMatchObject({ kind: 'shared', treatment: 'candidate' });
    expect(d('friend' + '@example.com', { summary: 'friend' })).toMatchObject({ kind: 'shared', treatment: 'candidate' });
    expect(d(CAL.recurring, { summary: 'Recurring Events', accessRole: 'owner' })).toMatchObject({ kind: 'owned', treatment: 'classify' });
    expect(d(CAL.holidays)).toMatchObject({ kind: 'holiday', treatment: 'excluded' });
    expect(d(CAL.birthdays)).toMatchObject({ kind: 'google_virtual', treatment: 'excluded' });
    expect(d('busy' + '@example.com', { accessRole: 'freeBusyReader' })).toMatchObject({ kind: 'unavailable', treatment: 'excluded' });
  });
});

describe('time zones', () => {
  it('converts wall times across DST gaps and overlaps', () => {
    expect(zonedToUtc(2026, 3, 8, 2, 30, 0, 0, 'America/Los_Angeles')).toBe(Date.UTC(2026, 2, 8, 10, 30)); // gap → 03:30 PDT
    expect(zonedToUtc(2026, 11, 1, 1, 30, 0, 0, 'America/Los_Angeles')).toBe(Date.UTC(2026, 10, 1, 8, 30)); // overlap → first (PDT)
    expect(zonedToUtc(2026, 10, 25, 2, 30, 0, 0, 'Europe/Berlin')).toBe(Date.UTC(2026, 9, 25, 0, 30)); // overlap → first (CEST)
    expect(zonedToUtc(2026, 1, 1, 0, 0, 0, 0, 'Asia/Kolkata')).toBe(Date.UTC(2025, 11, 31, 18, 30));
  });

  it('reads offsets as given and floating times in the zone', () => {
    expect(dateTimeToUtc('2026-10-20T19:00:00-07:00', 'Asia/Tokyo')).toBe(Date.UTC(2026, 9, 21, 2));
    expect(dateTimeToUtc('2026-10-20T19:00:00.250Z', 'Asia/Tokyo')).toBe(Date.UTC(2026, 9, 20, 19, 0, 0, 250));
    expect(dateTimeToUtc('2026-10-20T19:00:00', 'Asia/Tokyo')).toBe(Date.UTC(2026, 9, 20, 10));
    expect(dateTimeToUtc('not a time', 'UTC')).toBeNull();
    expect(dateToUtc('2026-10-20', 'America/Los_Angeles')).toBe(Date.UTC(2026, 9, 20, 7));
  });

  it('prefers the event’s own valid zone, then the calendar’s, then UTC', () => {
    expect(resolveTime({ dateTime: '2026-10-20T19:00:00', timeZone: 'Not/AZone' }, 'Asia/Tokyo')).toMatchObject({ tz: 'Asia/Tokyo', at: Date.UTC(2026, 9, 20, 10) });
    expect(resolveTime({ date: '2026-10-20' }, null)).toMatchObject({ tz: null, at: Date.UTC(2026, 9, 20), allDay: true, date: '2026-10-20' });
    expect(resolveTime(null, 'UTC')).toEqual({ at: null, date: null, allDay: false, tz: 'UTC' });
  });
});

describe('event mapping', () => {
  it('finds the Partiful event id in links or the feed UID', () => {
    expect(partifulEventId({ description: 'see https://partiful.com/e/Abc123Def456 for details' })).toBe('Abc123Def456');
    expect(partifulEventId({ location: 'partiful.com/e/Zyx987Wvu654?c=1' })).toBe('Zyx987Wvu654');
    expect(partifulEventId({ iCalUID: 'Qwe456Rty789' + '@partiful.com' })).toBe('Qwe456Rty789');
    expect(partifulEventId({ description: 'no link here', iCalUID: 'abc123' + '@google.com' })).toBeNull();
  });

  it('keeps unknown statuses as confirmed and an open end as the start', () => {
    const r = toRow('cal', { id: 'x', status: 'weird', start: { dateTime: '2026-10-20T19:00:00Z' } }, 'UTC');
    expect(r).toMatchObject({ status: 'confirmed', starts_at: Date.UTC(2026, 9, 20, 19), ends_at: Date.UTC(2026, 9, 20, 19), self_organizer: null, attendees: '[]' });
  });
});
