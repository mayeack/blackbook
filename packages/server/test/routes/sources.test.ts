import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { uuidv7 } from '@yb/shared';
import { createApp } from '../../src/http/app';
import type { SourcesView, SourceView } from '../../src/routes/sources';
import { cardFor, displayFolder, sourcesView } from '../../src/routes/sources';
import { memDb, seedIdentity, seedPerson, T0 } from '../helpers';
import { DAY } from './world';

const devApp = (db = memDb()) => createApp({ db, auth: { mode: 'dev-bypass', email: 'owner@example.com' } });

const CORE = ['imessage', 'whatsapp', 'beeper', 'instagram_dyi', 'partiful', 'gcal', 'addressbook'];

function seedMessages(db: ReturnType<typeof memDb>, source: string, times: number[]) {
  const conv = uuidv7();
  db.prepare(
    `INSERT INTO conversations (id, source, source_conv_id, kind, created_at, updated_at) VALUES (?, ?, ?, 'direct', ?, ?)`,
  ).run(conv, source, conv, T0, T0);
  const ins = db.prepare(
    `INSERT INTO messages (source, source_msg_id, conversation_id, is_from_me, sent_at, kind, text, ingested_at, updated_at)
     VALUES (?, ?, ?, 1, ?, 'text', 'x', ?, ?)`,
  );
  for (const t of times) ins.run(source, uuidv7(), conv, t, T0, T0);
}

const health = (db: ReturnType<typeof memDb>, source: string, status: string, o: { error?: string; details?: unknown; okAt?: number; checkedAt?: number } = {}) =>
  db
    .prepare(`INSERT INTO source_health (source, status, last_ok_at, newest_data_at, last_error, details, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(source, status, o.okAt ?? null, null, o.error ?? null, o.details ? JSON.stringify(o.details) : null, o.checkedAt ?? T0);

const card = (v: SourcesView, source: string): SourceView => {
  const c = v.sources.find((s) => s.source === source);
  if (!c) throw new Error(`no card ${source}`);
  return c;
};

describe('GET /api/v1/sources', () => {
  it('always shows the core cards, in a fixed order, with setup fixes before anything has reported', async () => {
    const res = await request(devApp()).get('/api/v1/sources');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const view = res.body as SourcesView;
    expect(view.sources.map((s) => s.source)).toEqual(CORE);
    for (const s of view.sources) expect(s).toMatchObject({ status: 'unknown', lastOkAt: null, messages: null, counts: {}, cursors: [] });
    expect(card(view, 'whatsapp').fix).toEqual({ kind: 'link_whatsapp' });
    expect(card(view, 'partiful').fix).toEqual({ kind: 'sign_in_partiful' });
    expect(card(view, 'beeper').fix).toEqual({ kind: 'beeper_setup' });
    expect(card(view, 'instagram_dyi').fix).toEqual({ kind: 'drop_instagram_export', folder: '~/Yeackbot Imports' });
    // No OAuth client in a test server: the owner has to create one first.
    expect(card(view, 'gcal')).toMatchObject({ configured: false, fix: { kind: 'google_not_configured' } });
    expect(card(view, 'imessage').fix).toEqual({ kind: 'collector_setup' });
    expect(card(view, 'addressbook').fix).toBeNull();
  });

  it('joins health, cursors and message counts per source, with errors redacted', async () => {
    const db = memDb();
    health(db, 'whatsapp', 'stale', { okAt: T0 - DAY, details: { snapshotMtime: T0 - DAY, note: 'from +15555550123' } });
    health(db, 'imessage', 'error', { okAt: T0 - 2 * DAY, error: 'send to someone@example.com failed for +1 555 555 0199' });
    const cur = db.prepare('INSERT INTO source_cursors (source, scope, cursor, high_water_at, updated_at) VALUES (?, ?, ?, ?, ?)');
    cur.run('imessage', '', '84123', T0, T0);
    cur.run('beeper', '15555550123@chat', 'a'.repeat(80), null, T0 - 1);
    const now = Date.now();
    seedMessages(db, 'imessage', [now - 1000, now - 3 * DAY, now - 30 * DAY]);

    const view = sourcesView(db, now);
    expect(view.sources.map((s) => s.source)).toEqual(CORE);
    expect(card(view, 'imessage')).toMatchObject({
      status: 'error',
      lastOkAt: T0 - 2 * DAY,
      lastError: 'send to [email] failed for [phone]',
      cursorCount: 1,
      cursors: [{ scope: '', cursor: '84123', highWaterAt: T0, updatedAt: T0 }],
      messages: { total: 3, last24h: 1, last7d: 2, oldestAt: now - 30 * DAY, newestAt: now - 1000 },
      counts: { conversations: 1 },
      // no health row value → falls back to the newest message
      newestDataAt: now - 1000,
      fix: null,
    });
    expect(card(view, 'whatsapp')).toMatchObject({ status: 'stale', details: { snapshotMtime: T0 - DAY, note: 'from [phone]' }, messages: null, cursors: [] });
    const beeper = card(view, 'beeper');
    expect(beeper.status).toBe('unknown');
    expect(beeper.cursors[0]!.scope).not.toContain('5555550123');
    expect(beeper.cursors[0]!.cursor.length).toBeLessThanOrEqual(32);
    // It has a cursor, so it has run: no "set up Beeper" hint.
    expect(beeper.fix).toBeNull();

    const res = await request(devApp(db)).get('/api/v1/sources');
    expect(res.status).toBe(200);
    expect((res.body as SourcesView).sources.map((s) => s.source)).toEqual(CORE);
    expect(res.text).not.toContain('example.com');
    expect(res.text).not.toMatch(/555\s?555\s?01\d\d/);
  });

  it('folds aliases into their card: worst status wins, counts add up, the collector card comes first', () => {
    const db = memDb();
    health(db, 'calendar', 'ok', { okAt: T0, checkedAt: T0 });
    health(db, 'gcal', 'auth_required', { error: 'invalid_grant', checkedAt: T0 - 1 });
    health(db, 'collector', 'ok', { okAt: T0 });
    health(db, 'legacy', 'disabled');
    seedMessages(db, 'beeper', [T0 - DAY]);
    seedMessages(db, 'instagram', [T0 - 2 * DAY, T0]);
    const view = sourcesView(db, T0 + 1, { googleConfigured: true });
    expect(view.sources.map((s) => s.source)).toEqual(['collector', ...CORE, 'legacy']);
    expect(card(view, 'gcal')).toMatchObject({ status: 'auth_required', lastOkAt: T0, checkedAt: T0, configured: true, fix: { kind: 'connect_google' } });
    expect(card(view, 'beeper')).toMatchObject({
      messages: { total: 3, oldestAt: T0 - 2 * DAY, newestAt: T0 },
      counts: { conversations: 2 },
      fix: null,
    });
    expect(card(view, 'legacy')).toMatchObject({ status: 'disabled', fix: null });
    expect(cardFor('ig_dyi')).toBe('instagram_dyi');
    expect(cardFor('something_new')).toBe('something_new');
  });

  it('counts people, identities, Partiful events and guests, calendar events and occasions, contact cards', () => {
    const db = memDb();
    const ana = seedPerson(db, { first_name: 'Ana', last_name: 'Arroyo', display_name: 'Ana Arroyo' });
    const ben = seedPerson(db, { first_name: 'Ben', last_name: 'Bell', display_name: 'Ben Bell' });
    const hid = seedPerson(db, { first_name: 'Hal', last_name: 'Hide', display_name: 'Hal Hide', is_hidden: 1 });
    seedIdentity(db, ana, 'whatsapp_jid', '15555550111@s.whatsapp.test', { source: 'whatsapp' });
    seedIdentity(db, ana, 'phone', '+15555550111', { source: 'whatsapp' });
    seedIdentity(db, ben, 'whatsapp_lid', '987654321@lid', { source: 'whatsapp' });
    seedIdentity(db, hid, 'whatsapp_lid', '987654322@lid', { source: 'whatsapp' });
    seedIdentity(db, ana, 'addressbook_id', 'card-1', { source: 'addressbook' });
    seedIdentity(db, ben, 'addressbook_id', 'card-2', { source: 'addressbook', status: 'detached' });
    seedIdentity(db, ben, 'partiful_user', 'pf-user-1', { source: 'partiful' });

    const event = (id: string, startsAt: number) =>
      db
        .prepare(`INSERT INTO events (id, source, source_event_id, title, starts_at, created_at, updated_at) VALUES (?, 'partiful', ?, 'Party', ?, ?, ?)`)
        .run(id, id, startsAt, T0, T0);
    event('e1', T0 - DAY);
    event('e2', T0 + DAY);
    db.prepare(
      `INSERT INTO event_attendees (id, event_id, person_id, status, source, created_at, updated_at) VALUES (?, 'e1', ?, 'going', 'partiful', ?, ?)`,
    ).run(uuidv7(), ben, T0, T0);
    const cal = db.prepare(
      `INSERT INTO calendar_events (id, calendar_id, google_event_id, status, starts_at, ingested_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    cal.run(uuidv7(), 'cal-a', 'g1', 'confirmed', T0, T0, T0);
    cal.run(uuidv7(), 'cal-b', 'g2', 'confirmed', T0, T0, T0);
    cal.run(uuidv7(), 'cal-b', 'g3', 'cancelled', T0, T0, T0);
    db.prepare(`INSERT INTO occasions (id, starts_at, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(uuidv7(), T0, T0, T0);

    const view = sourcesView(db, T0, { googleConfigured: true });
    // The hidden person's identity counts as an identity, never as a person.
    expect(card(view, 'whatsapp').counts).toEqual({ identities: 4, people: 2 });
    expect(card(view, 'addressbook').counts).toEqual({ identities: 1, people: 1, contactCards: 1 });
    expect(card(view, 'partiful').counts).toEqual({ identities: 1, people: 1, events: 2, upcomingEvents: 1, guests: 1 });
    expect(card(view, 'gcal').counts).toEqual({ calendars: 2, calendarEvents: 2, occasions: 1 });
    // Data but no report yet: no setup nags.
    expect(card(view, 'whatsapp').fix).toBeNull();
    expect(card(view, 'partiful').fix).toBeNull();
    expect(card(view, 'gcal').fix).toBeNull();
  });

  it('picks the fix from status and the scrubbed reason', () => {
    const db = memDb();
    health(db, 'beeper', 'error', { error: 'Instagram account disconnected' });
    health(db, 'whatsapp', 'error', { details: { reason: 'not_linked' } });
    health(db, 'partiful', 'auth_required', { error: 'refresh token rejected' });
    health(db, 'addressbook', 'error', { error: 'Contacts access denied' });
    health(db, 'instagram_dyi', 'stale', { okAt: T0 - 60 * DAY });
    health(db, 'imessage', 'contract_broken', { error: 'collector schema changed' });
    const view = sourcesView(db, T0, { importsDir: '/somewhere/Imports' });
    expect(card(view, 'beeper').fix).toEqual({ kind: 'beeper_disconnected' });
    expect(card(view, 'whatsapp').fix).toEqual({ kind: 'link_whatsapp' });
    expect(card(view, 'partiful').fix).toEqual({ kind: 'sign_in_partiful' });
    expect(card(view, 'addressbook').fix).toEqual({ kind: 'allow_contacts' });
    expect(card(view, 'instagram_dyi').fix).toEqual({ kind: 'drop_instagram_export', folder: '/somewhere/Imports' });
    expect(card(view, 'imessage').fix).toEqual({ kind: 'contract_broken' });
  });

  it('Google: connect after Disconnect (disabled, connected:false); nothing to do right after the OAuth callback', () => {
    const db = memDb();
    health(db, 'gcal', 'disabled', { error: 'Google Calendar is not connected.', details: { connected: false } });
    expect(card(sourcesView(db, T0, { googleConfigured: true }), 'gcal').fix).toEqual({ kind: 'connect_google' });
    db.prepare(`UPDATE source_health SET status = 'unknown', last_error = NULL, details = ? WHERE source = 'gcal'`).run(JSON.stringify({ connected: true }));
    expect(card(sourcesView(db, T0, { googleConfigured: true }), 'gcal').fix).toBeNull();
    // The client still learns the details from /google/status; without the OAuth client nothing else matters.
    expect(card(sourcesView(db, T0), 'gcal').fix).toEqual({ kind: 'google_not_configured' });
  });

  it('shortens the imports folder to ~', () => {
    expect(displayFolder('/home/owner/Yeackbot Imports', '/home/owner')).toBe('~/Yeackbot Imports');
    expect(displayFolder('/home/owner2/x', '/home/owner')).toBe('/home/owner2/x');
    expect(displayFolder(undefined)).toBe('~/Yeackbot Imports');
  });

  it('passes non-object details through (redacted) without breaking the fix lookup', () => {
    const db = memDb();
    health(db, 'whatsapp', 'ok', { details: ['a', 'b'] });
    expect(card(sourcesView(db, T0), 'whatsapp').details).toEqual(['a', 'b']);
  });
});
