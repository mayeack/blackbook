import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { CALENDAR_SCOPE, GMAIL_REFRESH_TOKEN_SECRET, REFRESH_TOKEN_SECRET } from '../../src/adapters/calendar/google';
import { runCalendarSync } from '../../src/adapters/calendar/jobs';
import { STATE_TTL_MS } from '../../src/adapters/calendar/oauth';
import { upsertCalendars } from '../../src/adapters/calendar/sync';
import { readCursor, writeCursor } from '../../src/adapters/common/cursors';
import { loadConfig } from '../../src/config';
import type { DB } from '../../src/db/connection';
import { createApp } from '../../src/http/app';
import { csrf } from '../../src/http/csrf';
import { errorHandler } from '../../src/http/errors';
import { undoBatch } from '../../src/journal/undo';
import type { LogFields, Logger } from '../../src/ops/logger';
import { createGoogleRouter } from '../../src/routes/google';
import { getSecret, setSecret } from '../../src/security/secrets';
import { calendarEntries, CAL, CLIENT, DAY, FakeGoogle, s256, T0, timed } from '../adapters/calendar/fakeGoogle';
import { memDb } from '../helpers';

const KEY_B64 = crypto.randomBytes(32).toString('base64');
const KEY = Buffer.from(KEY_B64, 'base64');
const base = { VITEST: '1', YB_DATA_DIR: '/tmp/yb-google-route-test', DEV_AUTH_BYPASS: '1' };
const config = loadConfig({
  ...base,
  SECRETS_KEY: KEY_B64,
  GOOGLE_CLIENT_ID: CLIENT.clientId,
  GOOGLE_CLIENT_SECRET: CLIENT.clientSecret,
  GOOGLE_REDIRECT_URI: CLIENT.redirectUri,
});
const AUTH = { mode: 'dev-bypass', email: 'owner@example.com' } as const;
const JSON_HEADERS = { 'x-yb': '1', 'content-type': 'application/json' };

const fakes: FakeGoogle[] = [];
afterEach(async () => {
  for (const f of fakes.splice(0)) await f.close();
});

function captureLog(): Logger & { lines: { level: string; event: string; fields?: LogFields }[] } {
  const lines: { level: string; event: string; fields?: LogFields }[] = [];
  const at = (level: string) => (event: string, fields?: LogFields) => void lines.push({ level, event, fields });
  return { lines, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

/** The Google router behind the same CSRF/JSON/error middleware as the real app, with a MockAgent fetch and a clock. */
function harness(o: { db?: DB; secretsKey?: Buffer | null } = {}) {
  const db = o.db ?? memDb();
  const g = new FakeGoogle();
  fakes.push(g);
  const log = captureLog();
  const clock = { now: T0 };
  const app = express();
  app.use('/api', csrf);
  app.use('/api', express.json());
  const cfg = o.secretsKey === undefined ? config : { ...config, secretsKey: o.secretsKey };
  app.use('/api/v1', createGoogleRouter({ db, log, config: cfg }, { fetch: g.fetch, now: () => clock.now }));
  app.use(errorHandler(log));
  return { db, g, log, clock, app };
}

/** GET /connect → {state, challenge} from the consent URL. */
async function connect(app: express.Express) {
  const res = await request(app).get('/api/v1/google/connect');
  expect(res.status).toBe(302);
  const url = new URL(res.headers.location!);
  return { url, state: url.searchParams.get('state')!, challenge: url.searchParams.get('code_challenge')! };
}

async function connectFully(h: ReturnType<typeof harness>, code = 'test-auth-code-1') {
  const { state, challenge } = await connect(h.app);
  h.g.grantCode(code, challenge);
  const res = await request(h.app).get(`/api/v1/google/callback?state=${encodeURIComponent(state)}&code=${code}&scope=${encodeURIComponent(CALENDAR_SCOPE)}`);
  return { res, state, challenge };
}

describe('not configured', () => {
  it('every /google route answers 503 until GOOGLE_CLIENT_ID/SECRET are set', async () => {
    for (const cfg of [undefined, loadConfig({ ...base, SECRETS_KEY: KEY_B64 })]) {
      const app = createApp({ db: memDb(), auth: AUTH, config: cfg });
      const gets = ['/api/v1/google/status', '/api/v1/google/connect', '/api/v1/google/callback?state=x&code=y'];
      for (const url of gets) {
        const res = await request(app).get(url);
        expect([url, res.status, res.body.error]).toEqual([url, 503, { code: 'GOOGLE_NOT_CONFIGURED', message: 'Google OAuth client not configured' }]);
      }
      for (const url of ['/api/v1/google/calendars', '/api/v1/google/disconnect']) {
        const res = await request(app).post(url).set(JSON_HEADERS).send({});
        expect([url, res.status, res.body.error?.code]).toEqual([url, 503, 'GOOGLE_NOT_CONFIGURED']);
      }
    }
  });
});

describe('GET /google/connect', () => {
  it('redirects to Google consent: calendar.readonly only, offline, prompt=consent, PKCE S256, random state', async () => {
    const app = createApp({ db: memDb(), auth: AUTH, config });
    const res = await request(app).get('/api/v1/google/connect');
    expect(res.status).toBe(302);
    const url = new URL(res.headers.location!);
    expect(`${url.origin}${url.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const p = url.searchParams;
    expect(p.get('client_id')).toBe(CLIENT.clientId);
    expect(p.get('redirect_uri')).toBe(CLIENT.redirectUri);
    expect(p.get('response_type')).toBe('code');
    expect(p.get('scope')).toBe(CALENDAR_SCOPE);
    expect(p.get('access_type')).toBe('offline');
    expect(p.get('prompt')).toBe('consent');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(res.headers['cache-control']).toBe('no-store');

    const again = new URL((await request(app).get('/api/v1/google/connect')).headers.location!).searchParams;
    expect(again.get('state')).not.toBe(p.get('state'));
    expect(again.get('code_challenge')).not.toBe(p.get('code_challenge'));
  });

  it('refuses to start without SECRETS_KEY (the token could not be stored)', async () => {
    const { app } = harness({ secretsKey: null });
    const res = await request(app).get('/api/v1/google/connect');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SECRETS_UNAVAILABLE');
  });
});

describe('GET /google/callback', () => {
  it('verifies the state, exchanges the code with the PKCE verifier, and stores the refresh token encrypted', async () => {
    const h = harness();
    const { res, challenge, state } = await connectFully(h);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/settings?google=connected');

    const [token] = h.g.callsTo(/^\/token$/);
    const body = new URLSearchParams(token!.body);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('redirect_uri')).toBe(CLIENT.redirectUri);
    expect(s256(body.get('code_verifier')!)).toBe(challenge);

    const stored = h.db.prepare('SELECT ciphertext, iv, tag, updated_at FROM secrets WHERE name = ?').get(REFRESH_TOKEN_SECRET) as {
      ciphertext: Buffer;
      updated_at: number;
    };
    expect(stored.ciphertext.includes(Buffer.from('test-refresh-token-1'))).toBe(false);
    expect(stored.updated_at).toBe(T0);
    expect(getSecret(h.db, KEY, REFRESH_TOKEN_SECRET)).toBe('test-refresh-token-1');
    expect(() => getSecret(h.db, crypto.randomBytes(32), REFRESH_TOKEN_SECRET)).toThrow(/could not be decrypted/);

    const status = await request(h.app).get('/api/v1/google/status');
    expect(status.body).toMatchObject({ configured: true, secretsAvailable: true, connected: true, connectedAt: T0, calendars: [] });
    expect(status.body.health).toMatchObject({ status: 'unknown' });

    // Nothing secret reaches the logs.
    const text = JSON.stringify(h.log.lines);
    for (const s of ['test-refresh-token-1', 'test-access', 'test-auth-code-1', state, body.get('code_verifier')!, CLIENT.clientSecret]) {
      expect(text).not.toContain(s);
    }
  });

  it('the stored token is what the gcal job then syncs with', async () => {
    const h = harness();
    h.g.addCalendars();
    h.g.put(CAL.primary, timed('dinner', T0 + DAY));
    await connectFully(h);
    const out = await runCalendarSync(
      { db: h.db, jobRunId: 1, trigger: 'manual', now: () => T0 + 60_000, log: h.log, signal: new AbortController().signal },
      { google: CLIENT, secretsKey: KEY, fetch: h.g.fetch },
    );
    expect(out).toMatchObject({ status: 'ok', stats: { calendars: 5, included: 4, inserted: 1 } });
    const refresh = h.g.callsTo(/^\/token$/).map((c) => new URLSearchParams(c.body).get('grant_type'));
    expect(refresh).toEqual(['authorization_code', 'refresh_token']);
    const status = (await request(h.app).get('/api/v1/google/status')).body;
    expect(status.health).toMatchObject({ status: 'ok', lastOkAt: T0 + 60_000 });
    expect(status).toMatchObject({ connected: true, needsReconnect: false, account: 'owner@example.com', lastSyncAt: T0 + 60_000 });
    expect(status.treatments).toEqual(['attending', 'candidate', 'classify', 'excluded']);

    // Google revokes the grant: the next pass flags a reconnect.
    h.g.refreshTokens.clear();
    await runCalendarSync(
      { db: h.db, jobRunId: 2, trigger: 'manual', now: () => T0 + 31 * 60_000, log: h.log, signal: new AbortController().signal },
      { google: CLIENT, secretsKey: KEY, fetch: h.g.fetch },
    );
    expect((await request(h.app).get('/api/v1/google/status')).body).toMatchObject({ connected: true, needsReconnect: true });
    expect(status.calendars.find((c: { id: string }) => c.id === CAL.primary)).toMatchObject({ events: 1, lastSyncedAt: T0 + 60_000 });
  });

  it('a state works once and only for 10 minutes; unknown or missing states are refused without calling Google', async () => {
    const h = harness();
    const first = await connectFully(h);
    expect(first.res.headers.location).toBe('/settings?google=connected');
    const replay = await request(h.app).get(`/api/v1/google/callback?state=${encodeURIComponent(first.state)}&code=test-auth-code-1`);
    expect(replay.headers.location).toBe('/settings?google=expired');

    const unknown = await request(h.app).get('/api/v1/google/callback?state=forged-state-value&code=whatever');
    expect(unknown.headers.location).toBe('/settings?google=expired');
    const missing = await request(h.app).get('/api/v1/google/callback?code=whatever');
    expect(missing.headers.location).toBe('/settings?google=invalid');

    const { state, challenge } = await connect(h.app);
    h.g.grantCode('test-auth-code-2', challenge);
    h.clock.now += STATE_TTL_MS + 1;
    const late = await request(h.app).get(`/api/v1/google/callback?state=${encodeURIComponent(state)}&code=test-auth-code-2`);
    expect(late.headers.location).toBe('/settings?google=expired');
    expect(h.g.callsTo(/^\/token$/)).toHaveLength(1);
  });

  it('a denied consent, a bad code, a missing scope or no refresh token stores nothing', async () => {
    const h = harness();
    const denied = await connect(h.app);
    const r1 = await request(h.app).get(`/api/v1/google/callback?state=${encodeURIComponent(denied.state)}&error=access_denied`);
    expect(r1.headers.location).toBe('/settings?google=denied');
    expect(h.g.calls).toEqual([]);

    const bad = await connect(h.app); // no code granted at "Google": invalid_grant
    const r2 = await request(h.app).get(`/api/v1/google/callback?state=${encodeURIComponent(bad.state)}&code=not-granted`);
    expect(r2.headers.location).toBe('/settings?google=error');
    expect(h.log.lines).toContainEqual({ level: 'warn', event: 'gcal.oauth_exchange_failed', fields: { error_class: 'GoogleAuthError', error_code: 'invalid_grant', status: undefined } });

    const narrow = await connect(h.app);
    h.g.grantCode('test-auth-code-3', narrow.challenge, { scope: 'openid email' });
    const r3 = await request(h.app).get(`/api/v1/google/callback?state=${encodeURIComponent(narrow.state)}&code=test-auth-code-3`);
    expect(r3.headers.location).toBe('/settings?google=scope');

    const noRefresh = await connect(h.app);
    h.g.grantCode('test-auth-code-4', noRefresh.challenge, { refreshToken: null });
    const r4 = await request(h.app).get(`/api/v1/google/callback?state=${encodeURIComponent(noRefresh.state)}&code=test-auth-code-4`);
    expect(r4.headers.location).toBe('/settings?google=error');

    expect(h.db.prepare('SELECT count(*) FROM secrets').pluck().get()).toBe(0);
  });
});

describe('POST /google/disconnect', () => {
  it('revokes the grant, deletes the secret and the sync tokens', async () => {
    const h = harness();
    await connectFully(h);
    writeCursor(h.db, 'gcal', `cal:${CAL.primary}`, 'sync-0-3', T0);
    writeCursor(h.db, 'beeper', 'chat:1', '7', T0);

    const csrfBlocked = await request(createApp({ db: h.db, auth: AUTH, config })).post('/api/v1/google/disconnect').send({});
    expect(csrfBlocked.status).toBe(403); // no X-YB header

    const res = await request(h.app).post('/api/v1/google/disconnect').set(JSON_HEADERS).send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ connected: false, revoked: true });
    expect(h.g.revoked).toEqual(['test-refresh-token-1']);
    expect(h.db.prepare('SELECT count(*) FROM secrets').pluck().get()).toBe(0);
    expect(readCursor(h.db, 'gcal', `cal:${CAL.primary}`)).toBeUndefined();
    expect(readCursor(h.db, 'beeper', 'chat:1')?.cursor).toBe('7');
    expect((await request(h.app).get('/api/v1/google/status')).body).toMatchObject({ connected: false, connectedAt: null, health: { status: 'disabled' } });
  });

  it('with deleteData, also deletes every synced calendar and event (counts only in the answer)', async () => {
    const h = harness();
    await connectFully(h);
    upsertCalendars(h.db, Object.values(calendarEntries()) as never, T0);
    h.db
      .prepare(
        `INSERT INTO calendar_events (id, calendar_id, google_event_id, summary, starts_at, ingested_at, updated_at) VALUES ('ce-1', ?, 'g-1', 'Dinner', ?, ?, ?)`,
      )
      .run(CAL.primary, T0, T0, T0);
    const calendars = h.db.prepare('SELECT count(*) FROM gcal_calendars').pluck().get() as number;
    const res = await request(h.app).post('/api/v1/google/disconnect').set(JSON_HEADERS).send({ deleteData: true });
    expect(res.body).toEqual({ connected: false, revoked: true, deleted: { events: 1, calendars } });
    expect(h.db.prepare('SELECT (SELECT count(*) FROM calendar_events) + (SELECT count(*) FROM gcal_calendars)').pluck().get()).toBe(0);
    expect((await request(h.app).post('/api/v1/google/disconnect').set(JSON_HEADERS).send({ deleteData: 'yes' })).status).toBe(400);
  });

  it('revokes only when Gmail and Photos hold no token; a revoke disables all three health rows', async () => {
    // Gmail still connected: Google's revoke would take it down too, so only the calendar token goes.
    const h = harness();
    await connectFully(h);
    h.g.refreshTokens.add('test-refresh-gmail');
    setSecret(h.db, KEY, GMAIL_REFRESH_TOKEN_SECRET, 'test-refresh-gmail', T0);
    const kept = await request(h.app).post('/api/v1/google/disconnect').set(JSON_HEADERS).send({});
    expect(kept.body).toEqual({ connected: false, revoked: false });
    expect(h.g.revoked).toEqual([]);
    expect(h.db.prepare('SELECT name FROM secrets').pluck().all()).toEqual([GMAIL_REFRESH_TOKEN_SECRET]);
    expect(h.db.prepare(`SELECT source, status FROM source_health ORDER BY source`).all()).toEqual([{ source: 'gcal', status: 'disabled' }]);

    // Calendar alone: the grant is revoked and every product reads as disconnected.
    const solo = harness();
    await connectFully(solo);
    const res = await request(solo.app).post('/api/v1/google/disconnect').set(JSON_HEADERS).send({});
    expect(res.body).toEqual({ connected: false, revoked: true });
    expect(solo.db.prepare(`SELECT source, status FROM source_health ORDER BY source`).all()).toEqual([
      { source: 'gcal', status: 'disabled' },
      { source: 'gmail', status: 'disabled' },
      { source: 'gphotos', status: 'disabled' },
    ]);
  });

  it('still disconnects locally when Google refuses the revocation', async () => {
    const h = harness();
    await connectFully(h);
    h.g.refreshTokens.clear(); // already revoked on Google's side
    const res = await request(h.app).post('/api/v1/google/disconnect').set(JSON_HEADERS).send({});
    expect(res.body).toEqual({ connected: false, revoked: false });
    expect(h.db.prepare('SELECT count(*) FROM secrets').pluck().get()).toBe(0);
    expect(JSON.stringify(h.log.lines)).not.toContain('test-refresh-token-1');
  });
});

describe('/google/status and POST /google/calendars', () => {
  function seeded() {
    const h = harness();
    upsertCalendars(h.db, Object.values(calendarEntries()) as never, T0);
    return h;
  }

  it('lists calendars with their treatments (primary first, removed last)', async () => {
    const h = seeded();
    const res = await request(h.app).get('/api/v1/google/status');
    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(false);
    const cals = res.body.calendars as Record<string, unknown>[];
    expect(cals.map((c) => c.id)).toEqual([CAL.primary, CAL.holidays, CAL.community, CAL.partiful, CAL.recurring]);
    expect(cals[0]).toEqual({
      id: CAL.primary,
      name: 'owner@example.com',
      kind: 'primary',
      primary: true,
      accessRole: 'owner',
      timeZone: 'America/Los_Angeles',
      treatment: 'attending',
      defaultTreatment: 'attending',
      userSet: false,
      partifulLinked: false,
      removed: false,
      included: true,
      events: 0,
      lastSyncedAt: null,
    });
    expect(cals.find((c) => c.id === CAL.partiful)).toMatchObject({ treatment: 'attending', partifulLinked: true });
  });

  it('sets treatments as one undoable settings batch; "default" clears the choice', async () => {
    const h = seeded();
    const res = await request(h.app)
      .post('/api/v1/google/calendars')
      .set(JSON_HEADERS)
      .send({ calendars: [{ id: CAL.community, treatment: 'attending' }, { id: CAL.partiful, treatment: 'excluded', partifulLinked: false }] });
    expect(res.status).toBe(200);
    expect(res.body.batchId).toEqual(expect.any(String));
    const by = Object.fromEntries((res.body.calendars as Record<string, unknown>[]).map((c) => [c.id, c]));
    expect(by[CAL.community]).toMatchObject({ treatment: 'attending', defaultTreatment: 'candidate', userSet: true });
    expect(by[CAL.partiful]).toMatchObject({ treatment: 'excluded', partifulLinked: false, userSet: true });
    const batch = h.db.prepare('SELECT kind, actor, title FROM change_batches WHERE id = ?').get(res.body.batchId);
    expect(batch).toEqual({ kind: 'setting', actor: 'user', title: 'Changed how 2 calendars are used' });

    // 'default' keeps partifulLinked (still a choice) but follows the default treatment again.
    const reset = await request(h.app).post('/api/v1/google/calendars').set(JSON_HEADERS).send({ calendars: [{ id: CAL.partiful, treatment: 'default' }] });
    expect(reset.body.calendars.find((c: { id: string }) => c.id === CAL.partiful)).toMatchObject({ treatment: 'attending', partifulLinked: false, userSet: true });
    const cleared = await request(h.app).post('/api/v1/google/calendars').set(JSON_HEADERS).send({ calendars: [{ id: CAL.community, treatment: 'default' }] });
    expect(cleared.body.calendars.find((c: { id: string }) => c.id === CAL.community)).toMatchObject({ treatment: 'candidate', userSet: false });

    // Undo the first batch: both choices go back to what they were before it.
    undoBatch(h.db, res.body.batchId, { cascade: true });
    const after = (await request(h.app).get('/api/v1/google/status')).body.calendars as Record<string, unknown>[];
    expect(after.filter((c) => c.userSet)).toEqual([]);
  });

  it('validates the body, rejects unknown calendars and needs the CSRF header', async () => {
    const h = seeded();
    const bad = await request(h.app).post('/api/v1/google/calendars').set(JSON_HEADERS).send({ calendars: [{ id: CAL.primary, treatment: 'sometimes' }] });
    expect(bad.status).toBe(400);
    const empty = await request(h.app).post('/api/v1/google/calendars').set(JSON_HEADERS).send({ calendars: [] });
    expect(empty.status).toBe(400);
    const unknown = await request(h.app).post('/api/v1/google/calendars').set(JSON_HEADERS).send({ calendars: [{ id: 'nope', treatment: 'excluded' }] });
    expect(unknown.status).toBe(404);
    expect(h.db.prepare('SELECT count(*) FROM settings').pluck().get()).toBe(0);

    const real = createApp({ db: h.db, auth: AUTH, config });
    const noHeader = await request(real).post('/api/v1/google/calendars').set('content-type', 'application/json').send({ calendars: [{ id: CAL.primary, treatment: 'excluded' }] });
    expect(noHeader.status).toBe(403);
    const ok = await request(real).post('/api/v1/google/calendars').set(JSON_HEADERS).send({ calendars: [{ id: CAL.primary, treatment: 'excluded' }] });
    expect(ok.status).toBe(200);
  });
});
