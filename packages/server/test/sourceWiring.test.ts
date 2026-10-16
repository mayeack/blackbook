import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import path from 'node:path';
import request from 'supertest';
import { sourceRun } from '../src/adapters/common/context';
import { cursorMeta, readCursor, recordSourceHealth, writeCursor } from '../src/adapters/common/cursors';
import { DEFAULT_BEEPER_URL, DEFAULT_BROWSER_CDP_URL, DEFAULT_GOOGLE_REDIRECT_URI, loadConfig } from '../src/config';
import { createApp } from '../src/http/app';
import { withBatch } from '../src/journal/batch';
import { buildJobs, sourceJobDeps } from '../src/scheduler/jobs/index';
import { memDb, T0 } from './helpers';

const base = { VITEST: '1', YB_DATA_DIR: '/tmp/yb-source-wiring-test', DEV_AUTH_BYPASS: '1' };

describe('source config', () => {
  it('defaults: loopback Beeper and CDP, the yeackbot.com Google callback, ~/Yeackbot Imports; no Google client', () => {
    const c = loadConfig(base);
    expect(c.beeper).toEqual({ url: DEFAULT_BEEPER_URL, token: null });
    expect(c.browserCdpUrl).toBe(DEFAULT_BROWSER_CDP_URL);
    expect(c.google).toBeNull();
    expect(path.basename(c.importsDir)).toBe('Yeackbot Imports');
    // Blank lines in .env mean "default".
    expect(loadConfig({ ...base, BEEPER_URL: '', BROWSER_CDP_URL: ' ' }).beeper.url).toBe(DEFAULT_BEEPER_URL);
  });

  it('validates the new settings', () => {
    expect(() => loadConfig({ ...base, BEEPER_URL: 'http://192.0.2.1:23373' })).toThrow(/loopback/);
    expect(() => loadConfig({ ...base, BROWSER_CDP_URL: 'http://192.0.2.1:4331' })).toThrow(/loopback/);
    expect(() => loadConfig({ ...base, GOOGLE_CLIENT_ID: 'id-only' })).toThrow(/set together/);
    const g = loadConfig({ ...base, GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csecret' }).google;
    expect(g).toEqual({ clientId: 'cid', clientSecret: 'csecret', redirectUri: DEFAULT_GOOGLE_REDIRECT_URI });
    expect(loadConfig({ ...base, IMPORTS_DIR: '~/Exports' }).importsDir).toMatch(/\/Exports$/);
  });
});

describe('job registry', () => {
  const paths = { backupDir: '/tmp/yb-x/backups', logDir: '/tmp/yb-x/logs' };

  it('registers no source jobs without their configuration', () => {
    expect(Object.values(sourceJobDeps({ config: paths })).every((d) => d === null)).toBe(true);
    expect(buildJobs({ config: paths }).map((j) => j.name)).toEqual(['backup', 'logs-prune']);
  });

  it('gates each source on what it needs', () => {
    const plain = loadConfig(base);
    const s = sourceJobDeps({ config: plain });
    expect(s.imessage && s.whatsapp && s.addressbook).toBeTruthy();
    expect(s.beeper).toBeNull(); // no token anywhere yet
    expect(s.calendar).toBeNull(); // no OAuth client
    expect(s.instagramDyi?.importsDir).toBe(plain.importsDir);
    expect(s.partiful?.browserCdpUrl).toBe(DEFAULT_BROWSER_CDP_URL);
    expect(s.matcher).not.toBeNull();
    expect(s.occasions).not.toBeNull();

    const key = crypto.randomBytes(32).toString('base64');
    const full = loadConfig({ ...base, SECRETS_KEY: key, GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csecret' });
    const f = sourceJobDeps({ config: full });
    expect(f.beeper).toMatchObject({ url: DEFAULT_BEEPER_URL, token: null });
    expect(f.calendar?.google.clientId).toBe('cid');
    expect(sourceJobDeps({ config: loadConfig({ ...base, BEEPER_TOKEN: 'synthetic' }) }).beeper?.token).toBe('synthetic');
    // Every source's jobs are registered through the real registry, in order, with their cadences.
    expect(buildJobs({ config: full }).map((j) => [j.name, j.schedule])).toEqual([
      ['backup', { kind: 'daily', at: '02:15' }],
      ['logs-prune', { kind: 'daily', at: '04:45' }],
      ['imessage-tail', { kind: 'interval', everyMs: 10_000 }],
      ['imessage-overlap', { kind: 'daily', at: '02:30' }],
      ['addressbook', expect.anything()],
      ['whatsapp', expect.anything()],
      ['beeper-instagram', { kind: 'interval', everyMs: 30 * 60_000 }],
      ['instagram-dyi', expect.anything()],
      ['partiful', { kind: 'daily', at: '02:00' }],
      ['partiful-contacts', { kind: 'weekly', dow: 0, at: '03:30' }],
      ['gcal', expect.anything()],
      ['identity-match', expect.anything()],
      ['occasions', { kind: 'daily', at: '03:00' }],
    ]);
  });
});

describe('route stubs', () => {
  it('/events is no longer a stub (the occasions pipeline landed; tests in routes/events.test.ts)', async () => {
    const app = createApp({ db: memDb(), auth: { mode: 'dev-bypass', email: 'owner@example.com' } });
    expect((await request(app).get('/api/v1/events')).status).toBe(200);
    expect((await request(app).get('/api/v1/events/abc')).status).toBe(400);
  });
});

describe('adapter bookkeeping', () => {
  it('cursors: per source and scope, high-water only moves forward, meta kept unless replaced', () => {
    const db = memDb();
    writeCursor(db, 'beeper', 'chat:1', '10', T0, { highWaterAt: 5, meta: { full: true } });
    writeCursor(db, 'beeper', 'chat:1', '20', T0 + 1, { highWaterAt: 3 });
    writeCursor(db, 'whatsapp', 'chat:1', '7', T0);
    const c = readCursor(db, 'beeper', 'chat:1')!;
    expect(c).toMatchObject({ cursor: '20', high_water_at: 5 });
    expect(cursorMeta<{ full: boolean }>(c).full).toBe(true);
    expect(readCursor(db, 'whatsapp', 'chat:1')?.cursor).toBe('7');
  });

  it('source health: last_ok_at only on ok, error cleared on ok', () => {
    const db = memDb();
    recordSourceHealth(db, 'beeper', T0, 'auth_required', { error: 'token_missing' });
    recordSourceHealth(db, 'beeper', T0 + 1, 'ok', { details: { chats: 3 } });
    expect(db.prepare(`SELECT status, last_ok_at, last_error, details FROM source_health WHERE source = 'beeper'`).get()).toEqual({
      status: 'ok',
      last_ok_at: T0 + 1,
      last_error: null,
      details: '{"chats":3}',
    });
  });

  it('a source run is created lazily and dropped when nothing was journaled', () => {
    const db = memDb();
    const idle = sourceRun(db, 'beeper', { now: T0 });
    idle.finish();
    expect(db.prepare('SELECT count(*) FROM runs').pluck().get()).toBe(0);
    const busy = sourceRun(db, 'beeper', { now: T0 });
    withBatch(db, { runId: busy.ctx.runId(), kind: 'setting', title: 'synthetic', actor: 'agent' }, (t) =>
      t.insert('settings', { key: 'k', value: '1' }),
    );
    busy.finish('ok');
    expect(db.prepare('SELECT kind, status FROM runs').all()).toEqual([{ kind: 'ingest', status: 'ok' }]);
  });
});
