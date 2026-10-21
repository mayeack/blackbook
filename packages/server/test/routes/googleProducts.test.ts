/**
 * Gmail and Google Photos connections (routes/gmail.ts, routes/gphotos.ts, routes/googleProducts.ts) behind the same
 * CSRF/JSON/error middleware as the real app, with an in-memory Google (undici MockAgent, no network) for the
 * consent and revoke calls and a stubbed Picker session module. Synthetic only: example.com / *.example addresses,
 * invented titles, test tokens.
 *
 *   - status: 503 until the OAuth client exists; connected / needs reconnecting / counts;
 *   - the Disconnect rule: a product deletes only its own token, cursors and health; revoke runs only when no other
 *     product holds a token, and then every product is disconnected;
 *   - deleteData: Gmail clears its ledger tables (never occasions); Photos always clears its files and open picks
 *     (cancelled at Google too, through an in-memory Picker, before the token goes), and with deleteData its
 *     screenshot records;
 *   - picking: session create / status with the session module stubbed, and its errors mapped.
 */
import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { GmailDisconnectResult, GmailStatus, GphotosDisconnectResult, GphotosSessionView, GphotosStatus, uuidv7 } from '@yb/shared';
import { GMAIL_SCOPE, GoogleApiError, GoogleAuthError, GOOGLE_PRODUCTS, type FetchLike, type GoogleProduct } from '../../src/adapters/calendar/google';
import { readCursor, recordSourceHealth, writeCursor } from '../../src/adapters/common/cursors';
import { screenshotsDir, writeScreenshot } from '../../src/adapters/gphotos/files';
import { GphotosNotConnectedError } from '../../src/adapters/gphotos/sessions';
import { loadConfig, type AppConfig } from '../../src/config';
import type { DB } from '../../src/db/connection';
import { createApp } from '../../src/http/app';
import { csrf } from '../../src/http/csrf';
import { errorHandler } from '../../src/http/errors';
import type { LogFields, Logger } from '../../src/ops/logger';
import { createGmailRouter } from '../../src/routes/gmail';
import { createGoogleRouter, PRODUCT_SOURCE } from '../../src/routes/google';
import { createGphotosRouter, RECENT_SESSION_MS, type GphotosSessionsApi } from '../../src/routes/gphotos';
import { getSecret, setSecret } from '../../src/security/secrets';
import { CLIENT, FakeGoogle, T0 } from '../adapters/calendar/fakeGoogle';
import { FakePhotos, REFRESH as PHOTOS_REFRESH } from '../adapters/gphotos/fakePhotos';
import { memDb, tempDir } from '../helpers';

const KEY_B64 = crypto.randomBytes(32).toString('base64');
const KEY = Buffer.from(KEY_B64, 'base64');
const base = { VITEST: '1', YB_DATA_DIR: '/tmp/yb-google-products-test', DEV_AUTH_BYPASS: '1' };
const config = loadConfig({
  ...base,
  SECRETS_KEY: KEY_B64,
  GOOGLE_CLIENT_ID: CLIENT.clientId,
  GOOGLE_CLIENT_SECRET: CLIENT.clientSecret,
  GOOGLE_REDIRECT_URI: CLIENT.redirectUri,
});
const AUTH = { mode: 'dev-bypass', email: 'owner@example.com' } as const;
const JSON_HEADERS = { 'x-yb': '1', 'content-type': 'application/json' };
const TOKENS: Record<GoogleProduct, string> = { calendar: 'test-refresh-calendar', gmail: 'test-refresh-gmail', photos: 'test-refresh-photos' };
const SOURCES = Object.values(PRODUCT_SOURCE);

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

function captureLog(): Logger & { lines: { level: string; event: string; fields?: LogFields }[] } {
  const lines: { level: string; event: string; fields?: LogFields }[] = [];
  const at = (level: string) => (event: string, fields?: LogFields) => void lines.push({ level, event, fields });
  return { lines, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

/**
 * `photos`: an in-memory Picker for the Photos router (token refreshes and Picker calls go to it; the revoke still
 * goes to the fake Google, which knows every product's token).
 */
function harness(o: { api?: Partial<GphotosSessionsApi>; config?: AppConfig; photos?: FakePhotos } = {}) {
  const db = memDb();
  const g = new FakeGoogle();
  const data = tempDir('yb-gphotos-');
  cleanups.push(() => g.close(), data.cleanup);
  const log = captureLog();
  const clock = { now: T0 };
  const cfg: AppConfig = { ...(o.config ?? config), dataDir: data.dir };
  const deps = { db, log, config: cfg };
  const photos = o.photos;
  const photosFetch: FetchLike = photos ? (input, init) => (new URL(String(input)).pathname === '/revoke' ? g.fetch : photos.fetch)(input, init) : g.fetch;
  const app = express();
  app.use('/api', csrf);
  app.use('/api', express.json());
  app.use('/api/v1', createGoogleRouter(deps, { fetch: g.fetch, now: () => clock.now }));
  app.use('/api/v1', createGmailRouter(deps, { fetch: g.fetch, now: () => clock.now }));
  app.use('/api/v1', createGphotosRouter(deps, { fetch: photosFetch, now: () => clock.now, api: o.api }));
  app.use(errorHandler(log));
  return { db, g, log, clock, app, dataDir: data.dir };
}

/** What a finished consent leaves behind: the encrypted token (known to the fake Google) and a fresh health row. */
function connect(h: ReturnType<typeof harness>, product: GoogleProduct) {
  h.g.refreshTokens.add(TOKENS[product]);
  setSecret(h.db, KEY, GOOGLE_PRODUCTS[product].secret, TOKENS[product], T0);
  recordSourceHealth(h.db, PRODUCT_SOURCE[product], T0, 'unknown', { error: null, newestDataAt: null, details: { connected: true } });
}

const secrets = (db: DB) => db.prepare('SELECT name FROM secrets ORDER BY name').pluck().all() as string[];
const healthOf = (db: DB, source: string) =>
  db.prepare('SELECT status, details FROM source_health WHERE source = ?').get(source) as { status: string; details: string | null } | undefined;

describe('not configured', () => {
  it('every /gmail and /gphotos route answers 503 until GOOGLE_CLIENT_ID/SECRET are set', async () => {
    const app = createApp({ db: memDb(), auth: AUTH, config: loadConfig({ ...base, SECRETS_KEY: KEY_B64 }) });
    for (const url of ['/api/v1/gmail/status', '/api/v1/gphotos/status', '/api/v1/gphotos/session/sess-1']) {
      const res = await request(app).get(url);
      expect([url, res.status, res.body.error?.code]).toEqual([url, 503, 'GOOGLE_NOT_CONFIGURED']);
    }
    for (const url of ['/api/v1/gmail/disconnect', '/api/v1/gphotos/disconnect', '/api/v1/gphotos/session']) {
      const res = await request(app).post(url).set(JSON_HEADERS).send({});
      expect([url, res.status, res.body.error?.code]).toEqual([url, 503, 'GOOGLE_NOT_CONFIGURED']);
    }
  });
});

describe('GET /gmail/status', () => {
  it('connect wiring: ?product=gmail asks for gmail.readonly, the callback stores the gmail token, status reads it', async () => {
    const h = harness();
    expect((await request(h.app).get('/api/v1/gmail/status')).body).toMatchObject({ configured: true, secretsAvailable: true, connected: false, connectedAt: null, health: null });
    const start = await request(h.app).get('/api/v1/google/connect?product=gmail');
    expect(start.status).toBe(302);
    const url = new URL(start.headers.location!);
    expect(url.searchParams.get('scope')).toBe(GMAIL_SCOPE);
    h.g.grantCode('test-code-gmail', url.searchParams.get('code_challenge')!, { scope: GMAIL_SCOPE, refreshToken: TOKENS.gmail });
    const back = await request(h.app).get(`/api/v1/google/callback?state=${encodeURIComponent(url.searchParams.get('state')!)}&code=test-code-gmail`);
    expect(back.headers.location).toBe('/settings?gmail=connected');
    expect(getSecret(h.db, KEY, GOOGLE_PRODUCTS.gmail.secret)).toBe(TOKENS.gmail);

    const status = GmailStatus.parse((await request(h.app).get('/api/v1/gmail/status')).body);
    expect(status).toMatchObject({ connected: true, connectedAt: T0, needsReconnect: false, lastSyncAt: null, health: { status: 'unknown' } });
    // Calendar is a separate grant: still not connected.
    expect((await request(h.app).get('/api/v1/google/status')).body.connected).toBe(false);
  });

  it('counts the ledger; a refused grant reads as "needs reconnecting" with the error redacted', async () => {
    const h = harness();
    connect(h, 'gmail');
    const msg = h.db.prepare(
      `INSERT INTO gmail_messages (gmail_id, thread_id, internal_at, triage, parse_status, created_at, updated_at) VALUES (?, 't', ?, ?, ?, ?, ?)`,
    );
    msg.run('m1', T0, 'candidate', 'parsed', T0, T0);
    msg.run('m2', T0, 'candidate', 'pending', T0, T0);
    msg.run('m3', T0, 'candidate', 'queued', T0, T0);
    msg.run('m4', T0, 'marketing', 'pending', T0, T0);
    msg.run('m5', T0, 'ignored', 'pending', T0, T0);
    const tk = h.db.prepare(
      `INSERT INTO ticket_events (id, title, title_key, starts_at, ends_at, local_date, status, first_email_at, last_email_at, merged_into_id, created_at, updated_at)
       VALUES (?, 'Show', 'show', ?, ?, '2026-10-20', ?, ?, ?, ?, ?, ?)`,
    );
    tk.run('tk-up', T0 + 86_400_000, null, 'holding', T0, T0, null, T0, T0);
    tk.run('tk-on', T0 - 3_600_000, T0 + 3_600_000, 'holding', T0, T0, null, T0, T0);
    tk.run('tk-sold', T0 + 86_400_000, null, 'sold', T0, T0, null, T0, T0);
    tk.run('tk-past', T0 - 86_400_000, null, 'holding', T0, T0, null, T0, T0);
    tk.run('tk-dup', T0 + 86_400_000, null, 'holding', T0, T0, 'tk-up', T0, T0);
    let s = GmailStatus.parse((await request(h.app).get('/api/v1/gmail/status')).body);
    expect(s.counts).toEqual({ scanned: 5, ticketEmails: 3, parsed: 1, pending: 2, events: 4, upcoming: 2 });

    recordSourceHealth(h.db, 'gmail', T0, 'auth_required', { error: 'invalid_grant for owner@example.com', newestDataAt: null });
    s = GmailStatus.parse((await request(h.app).get('/api/v1/gmail/status')).body);
    expect(s).toMatchObject({ connected: true, needsReconnect: true, health: { status: 'auth_required' } });
    expect(s.health!.lastError).not.toContain('example.com');
  });
});

describe('Disconnect: one product at a time; revoke only when nothing else holds a token', () => {
  it('Gmail with Calendar still connected: no revoke, only the gmail token, cursors and health go', async () => {
    const h = harness();
    connect(h, 'calendar');
    connect(h, 'gmail');
    writeCursor(h.db, 'gmail', 'list', '1', T0);
    writeCursor(h.db, 'gcal', 'cal:primary', 'sync-1', T0);
    expect((await request(createApp({ db: h.db, auth: AUTH, config })).post('/api/v1/gmail/disconnect').send({})).status).toBe(403); // no X-YB

    h.clock.now = T0 + 1000;
    const res = await request(h.app).post('/api/v1/gmail/disconnect').set(JSON_HEADERS).send({});
    expect(res.status).toBe(200);
    expect(GmailDisconnectResult.parse(res.body)).toEqual({ connected: false, revoked: false });
    expect(h.g.revoked).toEqual([]);
    expect(h.g.callsTo(/^\/revoke$/)).toHaveLength(0);
    expect(secrets(h.db)).toEqual([GOOGLE_PRODUCTS.calendar.secret]);
    expect(readCursor(h.db, 'gmail', 'list')).toBeUndefined();
    expect(readCursor(h.db, 'gcal', 'cal:primary')?.cursor).toBe('sync-1');
    expect(healthOf(h.db, 'gmail')).toEqual({ status: 'disabled', details: JSON.stringify({ connected: false }) });
    expect(healthOf(h.db, 'gcal')?.status).toBe('unknown');
    expect((await request(h.app).get('/api/v1/gmail/status')).body).toMatchObject({ connected: false, connectedAt: null });
    expect((await request(h.app).get('/api/v1/google/status')).body.connected).toBe(true);
  });

  it('the last product connected: revokes the grant, then every token is gone and every health row disabled', async () => {
    const h = harness();
    connect(h, 'photos');
    const res = await request(h.app).post('/api/v1/gphotos/disconnect').set(JSON_HEADERS).send({});
    expect(GphotosDisconnectResult.parse(res.body)).toMatchObject({ connected: false, revoked: true });
    expect(h.g.revoked).toEqual([TOKENS.photos]);
    expect(secrets(h.db)).toEqual([]);
    for (const source of SOURCES) expect(healthOf(h.db, source)?.status, source).toBe('disabled');
    expect(JSON.stringify(h.log.lines)).not.toContain(TOKENS.photos);
  });

  it('a revocation Google refuses still disconnects everything locally', async () => {
    const h = harness();
    connect(h, 'gmail');
    h.g.refreshTokens.clear(); // already revoked on Google's side
    const res = await request(h.app).post('/api/v1/gmail/disconnect').set(JSON_HEADERS).send({});
    expect(res.body).toEqual({ connected: false, revoked: false });
    expect(h.g.callsTo(/^\/revoke$/)).toHaveLength(1);
    expect(secrets(h.db)).toEqual([]);
    for (const source of SOURCES) expect(healthOf(h.db, source)?.status, source).toBe('disabled');
    expect(h.log.lines.some((l) => l.event === 'gmail.revoke_failed')).toBe(true);
    expect(JSON.stringify(h.log.lines)).not.toContain(TOKENS.gmail);
  });

  it('/google/disconnect follows the same rule: Gmail or Photos connected → no revoke, they stay connected', async () => {
    const h = harness();
    connect(h, 'calendar');
    connect(h, 'gmail');
    connect(h, 'photos');
    const res = await request(h.app).post('/api/v1/google/disconnect').set(JSON_HEADERS).send({});
    expect(res.body).toEqual({ connected: false, revoked: false });
    expect(h.g.revoked).toEqual([]);
    expect(secrets(h.db)).toEqual([GOOGLE_PRODUCTS.gmail.secret, GOOGLE_PRODUCTS.photos.secret].sort());
    expect(healthOf(h.db, 'gcal')?.status).toBe('disabled');
    expect(healthOf(h.db, 'gmail')?.status).toBe('unknown');
    expect(healthOf(h.db, 'gphotos')?.status).toBe('unknown');

    // Then Gmail: Photos still holds a token, so still no revoke.
    await request(h.app).post('/api/v1/gmail/disconnect').set(JSON_HEADERS).send({});
    expect(h.g.revoked).toEqual([]);
    // Photos is the last one: now the grant is revoked.
    const last = await request(h.app).post('/api/v1/gphotos/disconnect').set(JSON_HEADERS).send({});
    expect(last.body.revoked).toBe(true);
    expect(h.g.revoked).toEqual([TOKENS.photos]);
    expect(secrets(h.db)).toEqual([]);
  });

  it('disconnecting a product that was never connected changes nothing at Google', async () => {
    const h = harness();
    const res = await request(h.app).post('/api/v1/gmail/disconnect').set(JSON_HEADERS).send({});
    expect(res.body).toEqual({ connected: false, revoked: false });
    expect(h.g.callsTo(/^\/revoke$/)).toHaveLength(0);
    expect(healthOf(h.db, 'gmail')?.status).toBe('disabled');
    expect(healthOf(h.db, 'gcal')).toBeUndefined();
    expect((await request(h.app).post('/api/v1/gmail/disconnect').set(JSON_HEADERS).send({ deleteData: 'yes' })).status).toBe(400);
  });
});

describe('deleteData', () => {
  function seedLedger(db: DB) {
    const tk = db.prepare(
      `INSERT INTO ticket_events (id, title, title_key, starts_at, local_date, status, first_email_at, last_email_at, merged_into_id, created_at, updated_at)
       VALUES (?, 'Show', 'show', ?, '2026-10-20', 'holding', ?, ?, ?, ?, ?)`,
    );
    tk.run('tk-1', T0, T0, T0, null, T0, T0);
    tk.run('tk-2', T0, T0, T0, 'tk-1', T0, T0);
    db.prepare(
      `INSERT INTO gmail_messages (gmail_id, thread_id, internal_at, triage, parse_status, ticket_event_id, created_at, updated_at)
       VALUES ('m1', 't1', ?, 'candidate', 'parsed', 'tk-1', ?, ?)`,
    ).run(T0, T0, T0);
    db.prepare(
      `INSERT INTO ticket_parties (gmail_id, direction, name, quantity, ticket_event_id, created_at, updated_at)
       VALUES ('m1', 'sent_to', 'Avery Quill', 2, 'tk-1', ?, ?)`,
    ).run(T0, T0);
    const occ = uuidv7();
    db.prepare(`INSERT INTO occasions (id, kind, title, starts_at, created_at, updated_at) VALUES (?, 'social', 'Show', ?, ?, ?)`).run(occ, T0, T0, T0);
    db.prepare(`INSERT INTO occasion_sources (occasion_id, source, source_ref, created_at) VALUES (?, 'ticket', 'tk-1', ?)`).run(occ, T0);
    return occ;
  }
  const count = (db: DB, table: string) => db.prepare(`SELECT count(*) FROM ${table}`).pluck().get() as number;

  it('Gmail: deletes the messages, parties and ticket events; occasions are left for the next occasions pass', async () => {
    const h = harness();
    connect(h, 'gmail');
    connect(h, 'calendar');
    seedLedger(h.db);
    // Without deleteData the ledger stays.
    await request(h.app).post('/api/v1/gmail/disconnect').set(JSON_HEADERS).send({});
    expect(count(h.db, 'ticket_events')).toBe(2);

    connect(h, 'gmail');
    const res = await request(h.app).post('/api/v1/gmail/disconnect').set(JSON_HEADERS).send({ deleteData: true });
    expect(GmailDisconnectResult.parse(res.body)).toEqual({ connected: false, revoked: false, deleted: { messages: 1, tickets: 2, parties: 1 } });
    for (const t of ['gmail_messages', 'ticket_parties', 'ticket_events']) expect(count(h.db, t), t).toBe(0);
    expect(count(h.db, 'occasions')).toBe(1);
    expect(count(h.db, `occasion_sources WHERE source = 'ticket'`)).toBe(1);
    expect(JSON.stringify(h.log.lines)).not.toContain('Avery');
  });

  it('Photos: files and open picks always go (waiting rows expire); deleteData also deletes the screenshot records', async () => {
    const h = harness();
    connect(h, 'photos');
    connect(h, 'calendar');
    const session = h.db.prepare(
      `INSERT INTO gphotos_sessions (id, status, picker_uri, created_at, updated_at) VALUES (?, ?, 'https://photos.google.com/picker/x', ?, ?)`,
    );
    session.run('sess-open', 'open', T0, T0);
    session.run('sess-picked', 'picked', T0, T0);
    session.run('sess-done', 'done', T0, T0);
    const shot = h.db.prepare(`INSERT INTO contact_screenshots (id, source, source_ref, session_id, status, created_at, updated_at) VALUES (?, 'gphotos', ?, ?, ?, ?, ?)`);
    const waiting = uuidv7();
    const read = uuidv7();
    shot.run(waiting, 'item-1', 'sess-picked', 'downloaded', T0, T0);
    shot.run(read, 'item-2', 'sess-done', 'no_contact', T0, T0);
    writeScreenshot(h.dataDir, waiting, Buffer.from('not really a png'));
    fs.writeFileSync(path.join(screenshotsDir(h.dataDir), 'notes.txt'), 'not ours');

    h.clock.now = T0 + 5000;
    const res = await request(h.app).post('/api/v1/gphotos/disconnect').set(JSON_HEADERS).send({});
    expect(GphotosDisconnectResult.parse(res.body)).toEqual({ connected: false, revoked: false, filesDeleted: 1, sessionsCancelled: 2 });
    expect(fs.readdirSync(screenshotsDir(h.dataDir))).toEqual(['notes.txt']);
    expect(h.db.prepare('SELECT id, status FROM gphotos_sessions ORDER BY id').all()).toEqual([
      { id: 'sess-done', status: 'done' },
      { id: 'sess-open', status: 'cancelled' },
      { id: 'sess-picked', status: 'cancelled' },
    ]);
    expect(h.db.prepare('SELECT id, status FROM contact_screenshots ORDER BY source_ref').all()).toEqual([
      { id: waiting, status: 'expired' },
      { id: read, status: 'no_contact' },
    ]);
    expect(secrets(h.db)).toEqual([GOOGLE_PRODUCTS.calendar.secret]);

    const again = await request(h.app).post('/api/v1/gphotos/disconnect').set(JSON_HEADERS).send({ deleteData: true });
    expect(GphotosDisconnectResult.parse(again.body)).toEqual({ connected: false, revoked: false, filesDeleted: 0, sessionsCancelled: 0, deleted: { screenshots: 2 } });
    expect(count(h.db, 'contact_screenshots')).toBe(0);
  });

  it('Photos: an open pick is cancelled at Google too, before the token goes (then the grant is revoked)', async () => {
    const photos = new FakePhotos(() => T0);
    cleanups.push(() => photos.close());
    const h = harness({ photos });
    h.g.refreshTokens.add(PHOTOS_REFRESH);
    setSecret(h.db, KEY, GOOGLE_PRODUCTS.photos.secret, PHOTOS_REFRESH, T0);
    const started = await request(h.app).post('/api/v1/gphotos/session').set(JSON_HEADERS).send({});
    expect(started.status).toBe(200);
    const sessionId = started.body.sessionId as string;
    expect(photos.sessions.get(sessionId)?.deleted).toBe(false);

    const res = await request(h.app).post('/api/v1/gphotos/disconnect').set(JSON_HEADERS).send({});
    expect(GphotosDisconnectResult.parse(res.body)).toEqual({ connected: false, revoked: true, filesDeleted: 0, sessionsCancelled: 1 });
    expect(photos.sessions.get(sessionId)?.deleted).toBe(true);
    expect(photos.callsTo('DELETE', /^\/v1\/sessions\//)).toHaveLength(1);
    expect(h.g.revoked).toEqual([PHOTOS_REFRESH]);
    expect(h.db.prepare('SELECT status FROM gphotos_sessions WHERE id = ?').pluck().get(sessionId)).toBe('cancelled');
    expect(secrets(h.db)).toEqual([]);
    expect(JSON.stringify(h.log.lines)).not.toContain(PHOTOS_REFRESH);
  });

  it('Photos: a token that can’t be decrypted still disconnects (picks cancelled locally only)', async () => {
    const h = harness();
    connect(h, 'photos');
    h.db.prepare(`INSERT INTO gphotos_sessions (id, status, picker_uri, created_at, updated_at) VALUES ('sess-x', 'open', 'https://photos.google.com/picker/x', ?, ?)`).run(T0, T0);
    h.db.prepare(`UPDATE secrets SET tag = x'00' WHERE name = ?`).run(GOOGLE_PRODUCTS.photos.secret);
    const res = await request(h.app).post('/api/v1/gphotos/disconnect').set(JSON_HEADERS).send({});
    expect(res.status).toBe(200);
    expect(GphotosDisconnectResult.parse(res.body)).toEqual({ connected: false, revoked: false, filesDeleted: 0, sessionsCancelled: 1 });
    expect(h.g.callsTo(/^\/revoke$/)).toHaveLength(0);
    expect(secrets(h.db)).toEqual([]);
  });
});

describe('picking screenshots', () => {
  const view = (o: Partial<ReturnType<GphotosSessionsApi['pickerSessionStatus']> & object> = {}) => ({
    id: 'sess-1',
    status: 'open' as const,
    itemsTotal: 0,
    itemsNew: 0,
    processed: 0,
    linked: 0,
    createdAt: T0,
    expiresAt: T0 + 3_600_000,
    ...o,
  });

  it('POST /gphotos/session starts a Picker session through the session module, with the server’s deps', async () => {
    const calls: { deps: Record<string, unknown>; now: number | undefined }[] = [];
    const h = harness({
      api: {
        startPickerSession: async (_db, deps, now) => {
          calls.push({ deps: deps as unknown as Record<string, unknown>, now });
          return { sessionId: 'sess-1', pickerUri: 'https://photos.google.com/picker/sess-1', expiresAt: T0 + 3_600_000 };
        },
      },
    });
    // Not connected yet: nothing is started.
    const early = await request(h.app).post('/api/v1/gphotos/session').set(JSON_HEADERS).send({});
    expect([early.status, early.body.error.code]).toEqual([409, 'NOT_CONNECTED']);
    expect(calls).toHaveLength(0);

    connect(h, 'photos');
    expect((await request(createApp({ db: h.db, auth: AUTH, config })).post('/api/v1/gphotos/session').send({})).status).toBe(403);
    const res = await request(h.app).post('/api/v1/gphotos/session').set(JSON_HEADERS).send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sessionId: 'sess-1', pickerUri: 'https://photos.google.com/picker/sess-1', expiresAt: T0 + 3_600_000 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.now).toBe(T0);
    expect(calls[0]!.deps).toMatchObject({ secretsKey: KEY, google: config.google, dataDir: h.dataDir, collectorUrl: config.collectorUrl, collectorTokenFile: config.collectorTokenFile });
    expect(typeof calls[0]!.deps.fetch).toBe('function');
  });

  it('maps the session module’s errors: not connected / reconnect → 409, Google down → 502', async () => {
    const errors: Error[] = [new GphotosNotConnectedError(), new GoogleAuthError('invalid_grant'), new GoogleApiError(503, 'backendError')];
    const h = harness({
      api: {
        startPickerSession: async () => {
          throw errors.shift()!;
        },
      },
    });
    connect(h, 'photos');
    const post = () => request(h.app).post('/api/v1/gphotos/session').set(JSON_HEADERS).send({});
    const r1 = await post();
    expect([r1.status, r1.body.error.code]).toEqual([409, 'NOT_CONNECTED']);
    const r2 = await post();
    expect([r2.status, r2.body.error.code]).toEqual([409, 'RECONNECT']);
    const r3 = await post();
    expect([r3.status, r3.body.error.code]).toEqual([502, 'GOOGLE_UNAVAILABLE']);
    expect(h.log.lines.filter((l) => l.event === 'gphotos.session_failed').map((l) => l.fields?.error_class)).toEqual(['GoogleAuthError', 'GoogleApiError']);
  });

  it('GET /gphotos/session/:id: the module’s progress; unknown → 404, a malformed id → 400, an odd status reads as failed', async () => {
    const seen: string[] = [];
    const h = harness({
      api: {
        pickerSessionStatus: (_db, id) => {
          seen.push(id);
          if (id === 'sess-1') return view({ status: 'picked', itemsTotal: 12, itemsNew: 9 });
          if (id === 'sess-odd') return view({ id: 'sess-odd', status: 'weird' as never });
          return null;
        },
      },
    });
    const ok = await request(h.app).get('/api/v1/gphotos/session/sess-1');
    expect(GphotosSessionView.parse(ok.body)).toEqual(view({ status: 'picked', itemsTotal: 12, itemsNew: 9 }));
    expect((await request(h.app).get('/api/v1/gphotos/session/sess-odd')).body.status).toBe('failed');
    expect((await request(h.app).get('/api/v1/gphotos/session/nope')).status).toBe(404);
    expect((await request(h.app).get('/api/v1/gphotos/session/bad%20id')).status).toBe(400);
    expect(seen).toEqual(['sess-1', 'sess-odd', 'nope']);
  });

  it('GET /gphotos/status: the overview plus the session in progress (or one that finished within the hour)', async () => {
    const h = harness({
      api: {
        gphotosOverview: () => ({ connected: true, lastPickAt: T0 - 1000, screenshots: 7, linked: 4, pendingOcr: 2 }),
        pickerSessionStatus: (_db, id) => view({ id, status: 'done', itemsTotal: 3, itemsNew: 3, processed: 1 }),
      },
    });
    connect(h, 'photos');
    let s = GphotosStatus.parse((await request(h.app).get('/api/v1/gphotos/status')).body);
    expect(s).toMatchObject({ configured: true, connected: true, connectedAt: T0, needsReconnect: false, lastPickAt: T0 - 1000, counts: { screenshots: 7, linked: 4, pendingOcr: 2 }, session: null });

    const session = h.db.prepare(`INSERT INTO gphotos_sessions (id, status, picker_uri, created_at, updated_at) VALUES (?, ?, 'https://photos.google.com/picker/x', ?, ?)`);
    session.run('sess-old', 'done', T0 - 2 * RECENT_SESSION_MS, T0 - 2 * RECENT_SESSION_MS);
    expect(GphotosStatus.parse((await request(h.app).get('/api/v1/gphotos/status')).body).session).toBeNull();
    session.run('sess-new', 'done', T0 - 60_000, T0 - 60_000);
    s = GphotosStatus.parse((await request(h.app).get('/api/v1/gphotos/status')).body);
    expect(s.session).toMatchObject({ id: 'sess-new', status: 'done', processed: 1 });
  });

  it('the real session module answers status from the tables (no Google call)', async () => {
    const h = harness();
    connect(h, 'photos');
    h.db.prepare(`INSERT INTO gphotos_sessions (id, status, picker_uri, items_total, items_new, created_at, updated_at) VALUES ('sess-r', 'picked', 'https://photos.google.com/picker/r', 2, 2, ?, ?)`).run(T0, T0);
    const s = GphotosStatus.parse((await request(h.app).get('/api/v1/gphotos/status')).body);
    expect(s.session).toMatchObject({ id: 'sess-r', status: 'picked', itemsTotal: 2, itemsNew: 2, processed: 0, linked: 0 });
    expect(h.g.calls).toHaveLength(0);
  });
});
