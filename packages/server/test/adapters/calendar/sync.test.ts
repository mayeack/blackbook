import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { calendarJobs, runCalendarSync } from '../../../src/adapters/calendar/jobs';
import { calendarApi, connectedClient, REFRESH_TOKEN_SECRET, type CalendarApi, type GoogleEvent } from '../../../src/adapters/calendar/google';
import { cursorScope, FUTURE_DAYS, PAST_DAYS, syncCalendars } from '../../../src/adapters/calendar/sync';
import { readCursor } from '../../../src/adapters/common/cursors';
import type { DB } from '../../../src/db/connection';
import { undoBatch } from '../../../src/journal/undo';
import type { LogFields, Logger } from '../../../src/ops/logger';
import { setTreatments } from '../../../src/routes/google';
import type { JobContext } from '../../../src/scheduler/scheduler';
import { buildJobs } from '../../../src/scheduler/jobs/index';
import { setSecret } from '../../../src/security/secrets';
import { memDb } from '../../helpers';
import { allDay, CAL, CLIENT, DAY, FakeGoogle, OWNER, T0, timed } from './fakeGoogle';

const KEY = crypto.randomBytes(32);
const HOUR = 3_600_000;

const fakes: FakeGoogle[] = [];
afterEach(async () => {
  for (const f of fakes.splice(0)) await f.close();
});

function setup(o: { connected?: boolean } = {}) {
  const db = memDb();
  const g = new FakeGoogle().addCalendars();
  fakes.push(g);
  if (o.connected !== false) {
    g.refreshTokens.add('test-refresh-token-1');
    setSecret(db, KEY, REFRESH_TOKEN_SECRET, 'test-refresh-token-1', T0);
  }
  return { db, g };
}

function captureLog(): Logger & { lines: { level: string; event: string; fields?: LogFields }[] } {
  const lines: { level: string; event: string; fields?: LogFields }[] = [];
  const at = (level: string) => (event: string, fields?: LogFields) => void lines.push({ level, event, fields });
  return { lines, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

const ctx = (db: DB, now: number, log: Logger = captureLog()): JobContext => ({
  db,
  jobRunId: 1,
  trigger: 'manual',
  now: () => now,
  log,
  signal: new AbortController().signal,
});

const deps = (g: FakeGoogle) => ({ google: CLIENT, secretsKey: KEY, fetch: g.fetch });

async function sync(db: DB, g: FakeGoogle, now = T0, log?: Logger) {
  const client = connectedClient(db, KEY, CLIENT, g.fetch)!;
  return syncCalendars(db, calendarApi(client), { now, log });
}

const row = (db: DB, googleId: string) =>
  db.prepare('SELECT * FROM calendar_events WHERE google_event_id = ?').get(googleId) as Record<string, unknown> | undefined;
const eventCalls = (g: FakeGoogle, calendarId: string) => g.callsTo(/\/events$/).filter((c) => c.path.includes(encodeURIComponent(calendarId)));

describe('calendar list and treatments', () => {
  it('stores every calendar with its default treatment and never lists events of excluded ones', async () => {
    const { db, g } = setup();
    g.addCalendar({ id: CAL.birthdays, summary: 'Birthdays', accessRole: 'reader' });
    g.addCalendar({ id: CAL.otherFeed, summary: 'Team schedule', accessRole: 'reader' });
    const stats = await sync(db, g);
    const cals = db.prepare('SELECT * FROM gcal_calendar_treatment ORDER BY calendar_id').all() as Record<string, unknown>[];
    const by = Object.fromEntries(cals.map((c) => [c.calendar_id, c]));
    expect(by[CAL.primary]).toMatchObject({ kind: 'primary', treatment: 'attending', partiful_linked: 0, user_set: 0 });
    expect(by[CAL.partiful]).toMatchObject({ kind: 'partiful_feed', treatment: 'attending', partiful_linked: 1 });
    expect(by[CAL.community]).toMatchObject({ kind: 'shared', treatment: 'candidate' });
    expect(by[CAL.recurring]).toMatchObject({ kind: 'owned', treatment: 'classify' });
    expect(by[CAL.holidays]).toMatchObject({ kind: 'holiday', treatment: 'excluded' });
    expect(by[CAL.birthdays]).toMatchObject({ kind: 'google_virtual', treatment: 'excluded' });
    expect(by[CAL.otherFeed]).toMatchObject({ kind: 'subscribed', treatment: 'classify' });
    expect(stats).toMatchObject({ calendars: 7, included: 5, synced: 5, failed: 0 });
    expect(eventCalls(g, CAL.holidays)).toEqual([]);
    expect(eventCalls(g, CAL.birthdays)).toEqual([]);
    expect(readCursor(db, 'gcal', cursorScope(CAL.holidays))).toBeUndefined();
  });

  it('the owner’s choice (a journaled setting) wins, and undoing it restores the default', async () => {
    const { db, g } = setup();
    await sync(db, g);
    const { batchId } = setTreatments(db, [
      { id: CAL.community, treatment: 'excluded' },
      { id: CAL.holidays, treatment: 'attending' },
    ]);
    expect(batchId).not.toBeNull();
    expect(db.prepare('SELECT kind, actor FROM change_batches WHERE id = ?').get(batchId)).toEqual({ kind: 'setting', actor: 'user' });

    g.calls.length = 0;
    await sync(db, g, T0 + 30 * 60_000);
    expect(eventCalls(g, CAL.community)).toEqual([]);
    expect(eventCalls(g, CAL.holidays).length).toBeGreaterThan(0);

    undoBatch(db, batchId!);
    const t = db.prepare('SELECT calendar_id, treatment, user_set FROM gcal_calendar_treatment WHERE calendar_id IN (?, ?) ORDER BY calendar_id').all(CAL.community, CAL.holidays);
    expect(t).toEqual([
      { calendar_id: CAL.community, treatment: 'candidate', user_set: 0 },
      { calendar_id: CAL.holidays, treatment: 'excluded', user_set: 0 },
    ]);
  });

  it('excluding a calendar deletes its synced events and sync token at once; including it again re-lists them', async () => {
    const { db, g } = setup();
    g.put(CAL.community, timed('board-meetup', T0 + 2 * DAY));
    await sync(db, g);
    const events = (id: string) => db.prepare('SELECT count(*) FROM calendar_events WHERE calendar_id = ?').pluck().get(id) as number;
    expect(events(CAL.community)).toBe(1);
    expect(readCursor(db, 'gcal', cursorScope(CAL.community))).toBeDefined();
    const kept = events(CAL.primary);

    const { batchId } = setTreatments(db, [{ id: CAL.community, treatment: 'excluded' }]);
    expect(events(CAL.community)).toBe(0);
    expect(readCursor(db, 'gcal', cursorScope(CAL.community))).toBeUndefined();
    expect(events(CAL.primary)).toBe(kept);
    expect((await sync(db, g, T0 + HOUR)).purged_events).toBe(0);
    expect(events(CAL.community)).toBe(0);

    undoBatch(db, batchId!);
    const back = await sync(db, g, T0 + 2 * HOUR);
    expect(back.full_syncs).toBe(1);
    expect(events(CAL.community)).toBe(1);
  });

  it('a calendar that leaves the list is marked removed, drops out of calendar_events_included, and comes back', async () => {
    const { db, g } = setup();
    g.put(CAL.community, timed('board-meetup', T0 + 2 * DAY));
    await sync(db, g);
    expect(db.prepare('SELECT count(*) FROM calendar_events_included WHERE calendar_id = ?').pluck().get(CAL.community)).toBe(1);

    g.removeCalendar(CAL.community);
    const stats = await sync(db, g, T0 + HOUR);
    expect(stats.removed_calendars).toBe(1);
    expect(stats.purged_events).toBe(1); // its synced events are not kept
    expect(db.prepare('SELECT count(*) FROM calendar_events WHERE calendar_id = ?').pluck().get(CAL.community)).toBe(0);
    expect(db.prepare('SELECT removed_at FROM gcal_calendars WHERE calendar_id = ?').pluck().get(CAL.community)).toBe(T0 + HOUR);
    expect(db.prepare('SELECT count(*) FROM calendar_events_included WHERE calendar_id = ?').pluck().get(CAL.community)).toBe(0);

    g.addCalendars([CAL.community]);
    g.put(CAL.community, timed('board-meetup', T0 + 2 * DAY));
    await sync(db, g, T0 + 2 * HOUR);
    expect(db.prepare('SELECT removed_at FROM gcal_calendars WHERE calendar_id = ?').pluck().get(CAL.community)).toBeNull();
    expect(db.prepare('SELECT count(*) FROM calendar_events_included WHERE calendar_id = ?').pluck().get(CAL.community)).toBe(1);
  });
});

describe('event sync', () => {
  it('first sync: a full listing of −400…+60 days (singleEvents, showDeleted), then the sync token is stored', async () => {
    const { db, g } = setup();
    g.put(CAL.primary, timed('dinner-1', T0 + 3 * DAY, { summary: 'Dinner w/ Avery Quill', description: 'Avery has my ticket', location: 'Juniper Room' }));
    g.put(CAL.primary, timed('old-1', T0 - 300 * DAY));
    g.put(CAL.primary, timed('too-old', T0 - 500 * DAY));
    const stats = await sync(db, g);

    const [first] = eventCalls(g, CAL.primary);
    expect(first!.query.get('singleEvents')).toBe('true');
    expect(first!.query.get('showDeleted')).toBe('true');
    expect(first!.query.get('syncToken')).toBeNull();
    expect(Date.parse(first!.query.get('timeMin')!)).toBe(T0 - PAST_DAYS * DAY);
    expect(Date.parse(first!.query.get('timeMax')!)).toBe(T0 + FUTURE_DAYS * DAY);
    expect(stats.full_syncs).toBe(4);
    expect(stats.inserted).toBe(2);
    expect(row(db, 'too-old')).toBeUndefined();

    // The description stays local: attendee inference reads it.
    expect(row(db, 'dinner-1')).toMatchObject({
      calendar_id: CAL.primary,
      status: 'confirmed',
      summary: 'Dinner w/ Avery Quill',
      description: 'Avery has my ticket',
      location: 'Juniper Room',
      starts_at: T0 + 3 * DAY,
      ends_at: T0 + 3 * DAY + 2 * HOUR,
      all_day: 0,
      tz: 'America/Los_Angeles',
    });
    const cursor = readCursor(db, 'gcal', cursorScope(CAL.primary))!;
    expect(cursor.cursor).toMatch(/^sync-0-\d+$/);
    expect(JSON.parse(cursor.meta!)).toMatchObject({ windowStart: T0 - PAST_DAYS * DAY, windowEnd: T0 + FUTURE_DAYS * DAY });
    expect(db.prepare('SELECT last_synced_at FROM gcal_calendars WHERE calendar_id = ?').pluck().get(CAL.primary)).toBe(T0);
  });

  it('incremental sync sends only the sync token and applies new, changed and deleted events', async () => {
    const { db, g } = setup();
    g.put(CAL.primary, timed('keep', T0 + DAY));
    g.put(CAL.primary, timed('change', T0 + 2 * DAY, { summary: 'Drinks' }));
    g.put(CAL.primary, timed('delete', T0 + 3 * DAY));
    await sync(db, g);
    const before = row(db, 'keep')!;

    g.put(CAL.primary, timed('change', T0 + 2 * DAY + HOUR, { summary: 'Drinks (moved)' }));
    g.cancel(CAL.primary, 'delete');
    g.put(CAL.primary, timed('new', T0 + 4 * DAY));
    g.calls.length = 0;
    const stats = await sync(db, g, T0 + 30 * 60_000);

    const calls = eventCalls(g, CAL.primary);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.query.get('syncToken')).toMatch(/^sync-0-/);
    expect(calls[0]!.query.has('timeMin')).toBe(false);
    expect(calls[0]!.query.has('timeMax')).toBe(false);
    expect(stats).toMatchObject({ inserted: 1, updated: 1, cancelled: 1, full_syncs: 0 });
    expect(row(db, 'change')).toMatchObject({ summary: 'Drinks (moved)', starts_at: T0 + 2 * DAY + HOUR, updated_at: T0 + 30 * 60_000 });
    expect(row(db, 'delete')).toMatchObject({ status: 'cancelled', summary: 'Synthetic event' });
    expect(row(db, 'keep')).toEqual(before);
    expect(readCursor(db, 'gcal', cursorScope(CAL.primary))!.cursor).toBe(`sync-0-6`);
  });

  it('410 Gone: drops the token, does a full resync, and cancels rows the new listing no longer has', async () => {
    const { db, g } = setup();
    g.put(CAL.primary, timed('stays', T0 + DAY));
    g.put(CAL.primary, timed('vanishes', T0 + 2 * DAY));
    g.put(CAL.primary, timed('ancient', T0 - 450 * DAY));
    await sync(db, g);
    // The 'ancient' row predates the window: pretend an older build stored it.
    db.prepare(
      `INSERT INTO calendar_events (id, calendar_id, google_event_id, status, starts_at, attendees, ingested_at, updated_at)
       VALUES ('00000000-0000-7000-8000-000000000001', ?, 'ancient', 'confirmed', ?, '[]', ?, ?)`,
    ).run(CAL.primary, T0 - 450 * DAY, T0, T0);

    g.expireTokens(CAL.primary);
    g.forget(CAL.primary, 'vanishes');
    g.put(CAL.primary, timed('fresh', T0 + 5 * DAY));
    g.calls.length = 0;
    const stats = await sync(db, g, T0 + HOUR);

    const calls = eventCalls(g, CAL.primary);
    expect(calls.map((c) => (c.query.has('syncToken') ? 'token' : 'full'))).toEqual(['token', 'full']);
    expect(stats).toMatchObject({ resyncs: 1, full_syncs: 1, reconciled: 1, inserted: 1 });
    expect(row(db, 'vanishes')!.status).toBe('cancelled');
    expect(row(db, 'stays')!.status).toBe('confirmed');
    expect(row(db, 'ancient')!.status).toBe('confirmed'); // outside the window: left alone
    expect(readCursor(db, 'gcal', cursorScope(CAL.primary))!.cursor).toBe('sync-0-4');
  });

  it('pages through nextPageToken and stores the sync token only from the last page', async () => {
    const { db, g } = setup();
    g.pageSize = 2;
    for (let i = 0; i < 5; i++) g.put(CAL.primary, timed(`p${i}`, T0 + i * DAY));
    const stats = await sync(db, g);
    expect(eventCalls(g, CAL.primary).map((c) => c.query.get('pageToken'))).toEqual([null, 'page-2', 'page-4']);
    expect(stats.inserted).toBe(5);
    expect(readCursor(db, 'gcal', cursorScope(CAL.primary))!.cursor).toBe('sync-0-5');
  });

  it('deleted events: a known one is cancelled, an unknown one is not stored, a cancelled series retires its instances', async () => {
    const { db, g } = setup();
    for (const d of [1, 8, 15]) {
      g.put(CAL.recurring, timed(`weekly_2026101${d}`, T0 + d * DAY, { recurringEventId: 'weekly', summary: 'Climbing' }));
    }
    g.put(CAL.recurring, timed('one-off', T0 + 2 * DAY));
    await sync(db, g);
    expect(db.prepare(`SELECT count(*) FROM calendar_events WHERE recurring_event_id = 'weekly'`).pluck().get()).toBe(3);

    g.cancel(CAL.recurring, 'weekly'); // the series master (never stored itself with singleEvents)
    g.cancel(CAL.recurring, 'one-off');
    g.cancel(CAL.recurring, 'never-seen');
    const stats = await sync(db, g, T0 + HOUR);
    expect(stats).toMatchObject({ cancelled: 4, unknown_cancelled: 2 });
    expect(db.prepare(`SELECT DISTINCT status FROM calendar_events WHERE calendar_id = ?`).pluck().all(CAL.recurring)).toEqual(['cancelled']);
    expect(row(db, 'never-seen')).toBeUndefined();
    expect(row(db, 'weekly')).toBeUndefined();
  });

  it('time zones: offsets, an event’s own zone, floating times and all-day dates in the calendar’s zone', async () => {
    const { db, g } = setup();
    // An event in Tokyo on a Los Angeles calendar.
    g.put(CAL.primary, {
      id: 'tokyo',
      summary: 'Synthetic',
      start: { dateTime: '2026-10-20T19:00:00+09:00', timeZone: 'Asia/Tokyo' },
      end: { dateTime: '2026-10-20T21:00:00+09:00', timeZone: 'Asia/Tokyo' },
    });
    // No offset: read in the event's own zone (CEST, +2).
    g.put(
      CAL.primary,
      { id: 'floating', start: { dateTime: '2026-10-21T09:30:00', timeZone: 'Europe/Berlin' }, end: { dateTime: '2026-10-21T10:30:00', timeZone: 'Europe/Berlin' } },
      Date.UTC(2026, 9, 21, 7, 30),
    );
    // All-day: local midnight in the calendar's zone, end exclusive.
    g.put(CAL.primary, allDay('la-day', '2026-10-24', '2026-10-25'));
    // New York calendar, across the end of DST (Sunday 1 Nov 2026): a 25-hour day.
    g.put(CAL.recurring, allDay('ny-day', '2026-11-01', '2026-11-02'));
    // Offset given, no zone: the calendar's zone is recorded.
    g.put(CAL.recurring, { id: 'utc', start: { dateTime: '2026-10-22T15:00:00Z' }, end: { dateTime: '2026-10-22T16:00:00Z' } });
    await sync(db, g);

    expect(row(db, 'tokyo')).toMatchObject({ starts_at: Date.UTC(2026, 9, 20, 10), ends_at: Date.UTC(2026, 9, 20, 12), tz: 'Asia/Tokyo', all_day: 0 });
    expect(row(db, 'floating')).toMatchObject({ starts_at: Date.UTC(2026, 9, 21, 7, 30), ends_at: Date.UTC(2026, 9, 21, 8, 30), tz: 'Europe/Berlin' });
    expect(row(db, 'la-day')).toMatchObject({
      starts_at: Date.UTC(2026, 9, 24, 7),
      ends_at: Date.UTC(2026, 9, 25, 7),
      all_day: 1,
      start_date: '2026-10-24',
      end_date: '2026-10-25',
      tz: 'America/Los_Angeles',
    });
    const ny = row(db, 'ny-day')!;
    expect(ny).toMatchObject({ starts_at: Date.UTC(2026, 10, 1, 4), ends_at: Date.UTC(2026, 10, 2, 5), tz: 'America/New_York' });
    expect((ny.ends_at as number) - (ny.starts_at as number)).toBe(25 * HOUR);
    expect(row(db, 'utc')).toMatchObject({ starts_at: Date.UTC(2026, 9, 22, 15), tz: 'America/New_York' });
  });

  it('maps attendees, the owner’s RSVP, Gmail reservations and Partiful links; drops rooms', async () => {
    const { db, g } = setup();
    g.put(
      CAL.partiful,
      timed('pf-1', T0 + 6 * DAY, {
        summary: 'Rooftop Potluck',
        description: 'RSVP at https://partiful.com/e/AbCdEf123456XyZ',
        iCalUID: 'AbCdEf123456XyZ' + '@partiful.com',
      }),
    );
    g.put(
      CAL.primary,
      timed('meet', T0 + 7 * DAY, {
        eventType: 'fromGmail',
        summary: 'Reservation at Juniper Room',
        organizer: { email: 'Host.Person@Example.com' },
        creator: { email: OWNER, self: true },
        attendees: [
          { email: OWNER, self: true, responseStatus: 'declined' },
          { email: 'Rowan.Teal@example.com', displayName: 'Rowan Teal', responseStatus: 'accepted', additionalGuests: 1 },
          { email: 'room-4@resource.example.com', displayName: 'Room 4', resource: true, responseStatus: 'accepted' },
        ],
      }),
    );
    await sync(db, g);
    expect(row(db, 'pf-1')).toMatchObject({ partiful_event_id: 'AbCdEf123456XyZ' });
    const meet = row(db, 'meet')!;
    expect(meet).toMatchObject({ event_type: 'fromGmail', self_response: 'declined', organizer_email: 'host.person@example.com', self_organizer: 0 });
    expect(JSON.parse(meet.attendees as string)).toEqual([
      { email: OWNER, name: null, status: 'declined', self: true, organizer: false, optional: false, guests: 0 },
      { email: 'rowan.teal@example.com', name: 'Rowan Teal', status: 'accepted', self: false, organizer: false, optional: false, guests: 1 },
    ]);
    const raw = JSON.parse(meet.raw as string);
    expect(raw.description).toBeUndefined();
    expect(raw.attendees).toBeUndefined();
    expect(raw.eventType).toBe('fromGmail');
    expect(db.prepare(`SELECT treatment, partiful_linked FROM calendar_events_included WHERE google_event_id = 'pf-1'`).get()).toEqual({
      treatment: 'attending',
      partiful_linked: 1,
    });
  });

  it('extends the window weekly so instances of old recurring series beyond +60 days arrive', async () => {
    const { db, g } = setup();
    g.put(CAL.recurring, timed('series_far', T0 + 65 * DAY, { recurringEventId: 'series' }));
    await sync(db, g);
    expect(row(db, 'series_far')).toBeUndefined();

    g.calls.length = 0;
    const later = T0 + 8 * DAY;
    const stats = await sync(db, g, later);
    expect(stats.extensions).toBe(4);
    const [incremental, extension] = eventCalls(g, CAL.recurring);
    expect(incremental!.query.has('syncToken')).toBe(true);
    expect(Date.parse(extension!.query.get('timeMin')!)).toBe(T0 + FUTURE_DAYS * DAY);
    expect(Date.parse(extension!.query.get('timeMax')!)).toBe(later + FUTURE_DAYS * DAY);
    expect(row(db, 'series_far')).toMatchObject({ status: 'confirmed', recurring_event_id: 'series' });
    const cursor = readCursor(db, 'gcal', cursorScope(CAL.recurring))!;
    expect(JSON.parse(cursor.meta!).windowEnd).toBe(later + FUTURE_DAYS * DAY);

    // Within the week: no extension listing.
    g.calls.length = 0;
    await sync(db, g, later + DAY);
    expect(eventCalls(g, CAL.recurring)).toHaveLength(1);
  });

  it('an older copy of an event never overwrites a newer stored one', async () => {
    const db = memDb();
    const ev = (updated: string, summary: string): GoogleEvent => ({
      id: 'e1',
      status: 'confirmed',
      etag: `"${updated}"`,
      updated,
      summary,
      start: { dateTime: '2026-10-20T19:00:00Z' },
      end: { dateTime: '2026-10-20T20:00:00Z' },
    });
    let items = [ev('2026-10-10T10:00:00Z', 'newer')];
    const api: CalendarApi = {
      listCalendars: async () => [{ id: CAL.primary, primary: true, accessRole: 'owner', timeZone: 'UTC' }],
      listEvents: async () => ({ items, nextPageToken: null, nextSyncToken: 'tok', timeZone: 'UTC' }),
    };
    await syncCalendars(db, api, { now: T0 });
    items = [ev('2026-10-09T10:00:00Z', 'older')];
    const stats = await syncCalendars(db, api, { now: T0 + HOUR });
    expect(stats.stale).toBe(1);
    expect(row(db, 'e1')!.summary).toBe('newer');
  });
});

describe('gcal job', () => {
  it('registers one 30-minute job once Google is configured', () => {
    const jobs = calendarJobs({ google: CLIENT, secretsKey: KEY });
    expect(jobs.map((j) => [j.name, j.schedule])).toEqual([['gcal', { kind: 'interval', everyMs: 30 * 60_000 }]]);
    const config = { backupDir: '/tmp/yb-x/b', logDir: '/tmp/yb-x/l', google: CLIENT, secretsKey: KEY };
    expect(buildJobs({ config }).map((j) => j.name)).toContain('gcal');
    expect(buildJobs({ config: { ...config, secretsKey: undefined } }).map((j) => j.name)).not.toContain('gcal');
  });

  it('skips (no network) until Google is connected', async () => {
    const { db, g } = setup({ connected: false });
    const out = await runCalendarSync(ctx(db, T0), deps(g));
    expect(out).toEqual({ status: 'skipped', stats: { not_connected: 1 } });
    expect(g.calls).toEqual([]);
    expect(db.prepare(`SELECT status FROM source_health WHERE source = 'gcal'`).pluck().get()).toBe('disabled');
  });

  it('a revoked grant skips and flags the Sources card auth_required', async () => {
    const { db, g } = setup();
    g.refreshTokens.clear();
    const out = await runCalendarSync(ctx(db, T0), deps(g));
    expect(out).toEqual({ status: 'skipped', stats: { auth_required: 1 } });
    expect(db.prepare(`SELECT status FROM source_health WHERE source = 'gcal'`).pluck().get()).toBe('auth_required');
    expect(g.callsTo(/calendar/)).toEqual([]);
  });

  it('one failing calendar makes the pass partial; the others still sync; logs carry no ids, titles or notes', async () => {
    const { db, g } = setup();
    g.failing.set(CAL.community, 403);
    g.put(CAL.primary, timed('private', T0 + DAY, { summary: 'Dinner w/ Avery Quill', description: 'Avery has my ticket', attendees: [{ email: 'avery.quill@example.com' }] }));
    const log = captureLog();
    const out = await runCalendarSync(ctx(db, T0, log), deps(g));
    expect(out).toMatchObject({ status: 'partial', stats: { failed: 1, synced: 3, inserted: 1 } });
    const health = db.prepare(`SELECT status, details FROM source_health WHERE source = 'gcal'`).get() as { status: string; details: string };
    expect(health.status).toBe('ok');
    expect(JSON.parse(health.details)).toMatchObject({ connected: true, failed: 1, events: 1 });
    expect(log.lines).toEqual([
      { level: 'warn', event: 'gcal.calendar_failed', fields: { error_class: 'GoogleApiError', error_code: 'forbidden', status: 403, counts: { kind_shared: 1 } } },
    ]);
    const text = JSON.stringify(log.lines);
    for (const secret of ['Avery', 'ticket', 'example.com', 'community', 'test-refresh', 'test-access']) expect(text).not.toContain(secret);
  });
});
