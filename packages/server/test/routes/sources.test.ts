import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import request from 'supertest';
import { uuidv7 } from '@yb/shared';
import { loadConfig } from '../../src/config';
import { createApp } from '../../src/http/app';
import type { SourcesView, SourceView } from '../../src/routes/sources';
import { cardFor, displayFolder, sourcesView } from '../../src/routes/sources';
import { memDb, seedIdentity, seedPerson, T0 } from '../helpers';
import { DAY } from './world';

const devApp = (db = memDb()) => createApp({ db, auth: { mode: 'dev-bypass', email: 'owner@example.com' } });

const CORE = ['imessage', 'whatsapp', 'beeper', 'instagram_dyi', 'partiful', 'gcal', 'addressbook', 'gmail', 'gphotos', 'calls'];

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
    // Gmail and Google Photos ride on the same OAuth client.
    expect(card(view, 'gmail')).toMatchObject({ configured: false, fix: { kind: 'google_not_configured' } });
    expect(card(view, 'gphotos')).toMatchObject({ configured: false, fix: { kind: 'google_not_configured' } });
    expect(card(view, 'calls').fix).toEqual({ kind: 'collector_setup' });
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

  it('Gmail and Google Photos: connected straight from their own secret; counts from the ledger and the screenshots', () => {
    const db = memDb();
    const opts = { googleConfigured: true, secretsAvailable: true };
    // Not connected: connect each one (its own consent), even with no health row yet.
    expect(card(sourcesView(db, T0, opts), 'gmail')).toMatchObject({ configured: true, status: 'unknown', fix: { kind: 'connect_gmail' } });
    expect(card(sourcesView(db, T0, opts), 'gphotos')).toMatchObject({ configured: true, status: 'unknown', fix: { kind: 'connect_gphotos' } });

    // A stored token (any bytes: only its presence is read) is "connected": nothing to do.
    const secret = db.prepare(`INSERT INTO secrets (name, ciphertext, iv, tag, updated_at) VALUES (?, x'00', x'00', x'00', ?)`);
    secret.run('gmail.refresh_token', T0);
    secret.run('gphotos.refresh_token', T0);
    expect(card(sourcesView(db, T0, opts), 'gmail').fix).toBeNull();
    expect(card(sourcesView(db, T0, opts), 'gphotos').fix).toBeNull();

    // Google refused the grant: connect again.
    health(db, 'gmail', 'auth_required', { error: 'invalid_grant' });
    health(db, 'gphotos', 'error', { error: 'token revoked' });
    expect(card(sourcesView(db, T0, opts), 'gmail').fix).toEqual({ kind: 'connect_gmail' });
    expect(card(sourcesView(db, T0, opts), 'gphotos').fix).toEqual({ kind: 'connect_gphotos' });

    // Counts: messages looked at, ticket mail, live ticket events; screenshots and those linked; screenshot people.
    const msg = db.prepare(
      `INSERT INTO gmail_messages (gmail_id, thread_id, internal_at, triage, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    msg.run('m1', 't1', T0, 'candidate', T0, T0);
    msg.run('m2', 't2', T0, 'marketing', T0, T0);
    msg.run('m3', 't3', T0, 'ignored', T0, T0);
    const tk = db.prepare(
      `INSERT INTO ticket_events (id, title, title_key, starts_at, local_date, status, first_email_at, last_email_at, merged_into_id, created_at, updated_at)
       VALUES (?, 'Show', 'show', ?, '2026-10-20', 'holding', ?, ?, ?, ?, ?)`,
    );
    tk.run('tk-1', T0, T0, T0, null, T0, T0);
    tk.run('tk-2', T0, T0, T0, 'tk-1', T0, T0);
    const shot = db.prepare(
      `INSERT INTO contact_screenshots (id, source, source_ref, status, person_id, created_at, updated_at) VALUES (?, 'gphotos', ?, ?, ?, ?, ?)`,
    );
    const pat = seedPerson(db, { first_name: 'Pat', last_name: 'Quill', display_name: 'Pat Quill' });
    seedIdentity(db, pat, 'phone', '+12125550142', { source: 'screenshot' });
    shot.run(uuidv7(), 'item-1', 'linked', pat, T0, T0);
    shot.run(uuidv7(), 'item-2', 'no_contact', null, T0, T0);
    // Linked to someone hidden: read, but not counted as linked (Settings counts visible people only too).
    const hid = seedPerson(db, { first_name: 'Hal', last_name: 'Hidden', display_name: 'Hal Hidden', is_hidden: 1 });
    shot.run(uuidv7(), 'item-3', 'linked', hid, T0, T0);
    const view = sourcesView(db, T0, opts);
    expect(card(view, 'gmail').counts).toEqual({ emailsScanned: 3, ticketEmails: 1, tickets: 1 });
    expect(card(view, 'gphotos').counts).toEqual({ screenshots: 3, screenshotsLinked: 1, identities: 1, people: 1 });
    expect(cardFor('screenshot')).toBe('gphotos');
    expect(view.sources.map((s) => s.source)).toEqual(CORE);
  });

  it('Gmail and Google Photos without SECRETS_KEY: the set-the-key guidance, never a Connect button into a 503', async () => {
    const db = memDb();
    const opts = { googleConfigured: true, secretsAvailable: false };
    expect(card(sourcesView(db, T0, opts), 'gmail')).toMatchObject({ configured: true, fix: { kind: 'google_secrets_missing' } });
    expect(card(sourcesView(db, T0, opts), 'gphotos')).toMatchObject({ configured: true, fix: { kind: 'google_secrets_missing' } });
    // A refused grant can't be reconnected without the key either.
    db.prepare(`INSERT INTO secrets (name, ciphertext, iv, tag, updated_at) VALUES ('gmail.refresh_token', x'00', x'00', x'00', ?)`).run(T0);
    health(db, 'gmail', 'auth_required', { error: 'invalid_grant' });
    expect(card(sourcesView(db, T0, opts), 'gmail').fix).toEqual({ kind: 'google_secrets_missing' });
    // No OAuth client still comes first.
    expect(card(sourcesView(db, T0, { secretsAvailable: false }), 'gmail').fix).toEqual({ kind: 'google_not_configured' });

    // Through the real app: an OAuth client but no SECRETS_KEY, where /google/connect answers 503.
    const env = { VITEST: '1', YB_DATA_DIR: '/tmp/yb-sources-route-test', DEV_AUTH_BYPASS: '1' };
    const google = {
      GOOGLE_CLIENT_ID: 'test-client-id.apps.example',
      GOOGLE_CLIENT_SECRET: 'test-client-secret',
      GOOGLE_REDIRECT_URI: 'https://yeackbot.example/api/v1/google/callback',
    };
    const appWith = (config: ReturnType<typeof loadConfig>) => createApp({ db: memDb(), auth: { mode: 'dev-bypass', email: 'owner@example.com' }, config });
    const app = appWith(loadConfig({ ...env, ...google }));
    const view = (await request(app).get('/api/v1/sources')).body as SourcesView;
    expect(card(view, 'gmail').fix).toEqual({ kind: 'google_secrets_missing' });
    expect(card(view, 'gphotos').fix).toEqual({ kind: 'google_secrets_missing' });
    expect((await request(app).get('/api/v1/google/connect?product=gmail')).status).toBe(503);
    // With the key set, the Connect buttons come back.
    const keyed = loadConfig({ ...env, ...google, SECRETS_KEY: crypto.randomBytes(32).toString('base64') });
    const ok = (await request(appWith(keyed)).get('/api/v1/sources')).body as SourcesView;
    expect(card(ok, 'gmail').fix).toEqual({ kind: 'connect_gmail' });
    expect(card(ok, 'gphotos').fix).toEqual({ kind: 'connect_gphotos' });
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
