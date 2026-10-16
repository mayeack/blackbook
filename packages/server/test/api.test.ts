import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { ActivityPage, UndoResult } from '@yb/shared';
import { createApp } from '../src/http/app';
import { withBatch } from '../src/journal/batch';
import { createPerson, memDb, newRun, tempDir } from './helpers';

const devApp = (db = memDb(), extra: Partial<Parameters<typeof createApp>[0]> = {}) =>
  createApp({ db, auth: { mode: 'dev-bypass', email: 'owner@example.com' }, ...extra });

const post = (app: ReturnType<typeof devApp>, url: string, body: object = {}) =>
  request(app).post(url).set('X-YB', '1').set('Content-Type', 'application/json').send(body);

describe('HTTP basics', () => {
  it('/healthz: no auth, only {ok:true}, no-store', async () => {
    const res = await request(devApp()).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.text).toBe('{"ok":true}');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('sets a strict CSP and no-store on the API', async () => {
    const res = await request(devApp()).get('/api/v1/me');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ email: 'owner@example.com', via: 'dev-bypass' });
    expect(res.headers['content-security-policy']).toMatch(/default-src 'self'/);
    expect(res.headers['content-security-policy']).toMatch(/frame-ancestors 'none'/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('unknown API routes are JSON 404s', async () => {
    const res = await request(devApp()).get('/api/v1/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('rate limits per CF-Connecting-IP', async () => {
    const app = devApp(memDb(), { rateLimits: { general: 2, ask: 1 } });
    // /healthz: the limiter runs before auth (and dev bypass refuses tunnel-header traffic on API routes).
    for (let i = 0; i < 2; i++) expect((await request(app).get('/healthz').set('CF-Connecting-IP', '203.0.113.7')).status).toBe(200);
    const limited = await request(app).get('/healthz').set('CF-Connecting-IP', '203.0.113.7');
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect((await request(app).get('/healthz').set('CF-Connecting-IP', '203.0.113.8')).status).toBe(200);
  });
});

describe('CSRF', () => {
  it('mutating API requests need JSON and X-YB: 1', async () => {
    const app = devApp();
    const url = '/api/v1/activity/01a13ba4-0000-7000-8000-000000000000/undo';
    const noHeader = await request(app).post(url).set('Content-Type', 'application/json').send({});
    expect(noHeader.status).toBe(403);
    expect(noHeader.body.error.code).toBe('CSRF');
    const wrongHeader = await request(app).post(url).set('X-YB', 'yes').set('Content-Type', 'application/json').send({});
    expect(wrongHeader.status).toBe(403);
    const form = await request(app).post(url).set('X-YB', '1').type('form').send('cascade=true');
    expect(form.status).toBe(415);
    const text = await request(app).post(url).set('X-YB', '1').set('Content-Type', 'text/plain').send('{}');
    expect(text.status).toBe(415);
    const ok = await post(app, url);
    expect(ok.status).toBe(404); // passed CSRF, reached the route: no such batch
    expect(ok.body.error.code).toBe('NOT_FOUND');
  });

  it('GET is unaffected', async () => {
    expect((await request(devApp()).get('/api/v1/activity')).status).toBe(200);
  });
});

describe('activity + undo API', () => {
  it('pages batches newest first, grouped by run, and undoes with cascade/dry-run', async () => {
    const db = memDb();
    const app = devApp(db);
    const night = newRun(db);
    const p = createPerson(db, night, { display_name: 'Nova Quell' });
    const b1 = withBatch(db, { runId: night, kind: 'person_update', title: 'Set company', actor: 'agent', subjectPersonId: p }, (t) =>
      t.update('people', { id: p }, { company: 'A' }),
    ).batchId;
    const user = newRun(db, 'user');
    const b2 = withBatch(db, { runId: user, kind: 'user_edit', title: 'Edited company', actor: 'user', subjectPersonId: p }, (t) =>
      t.update('people', { id: p }, { company: 'B' }),
    ).batchId;

    const page = ActivityPage.parse((await request(app).get('/api/v1/activity?limit=2')).body);
    expect(page.groups.map((g) => g.run.id)).toEqual([user, night]);
    expect(page.groups[0]!.batches.map((b) => b.id)).toEqual([b2]);
    expect(page.nextCursor).not.toBeNull();
    const rest = ActivityPage.parse((await request(app).get(`/api/v1/activity?cursor=${page.nextCursor}`)).body);
    expect(rest.groups.flatMap((g) => g.batches.map((b) => b.kind))).toEqual(['create_person']);
    expect(rest.nextCursor).toBeNull();
    expect((await request(app).get('/api/v1/activity?cursor=abc')).status).toBe(400);

    const refused = await post(app, `/api/v1/activity/${b1}/undo`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('CASCADE_REQUIRED');
    expect(refused.body.error.details.dependents).toHaveLength(1);

    const preview = UndoResult.parse((await post(app, `/api/v1/activity/${b1}/undo?dryRun=1`)).body);
    expect(preview.dryRun).toBe(true);
    expect(preview.cascaded).toEqual([b2]);
    expect(db.prepare('SELECT company FROM people WHERE id = ?').pluck().get(p)).toBe('B');

    const done = UndoResult.parse((await post(app, `/api/v1/activity/${b1}/undo`, { cascade: true })).body);
    expect(done.undone.map((u) => u.batchId)).toEqual([b2, b1]);
    expect(db.prepare('SELECT company FROM people WHERE id = ?').pluck().get(p)).toBeNull();
    expect((await post(app, `/api/v1/activity/${b1}/undo`)).body.error.code).toBe('ALREADY_UNDONE');
    expect((await post(app, `/api/v1/activity/${b1}/undo`, { cascade: 'yes' })).status).toBe(400);

    const runPreview = UndoResult.parse((await post(app, `/api/v1/runs/${night}/undo?dryRun=1`)).body);
    expect(runPreview.countsByKind).toEqual({ create_person: 1 });
    const runDone = UndoResult.parse((await post(app, `/api/v1/runs/${night}/undo`)).body);
    expect(runDone.undone).toHaveLength(1);
    expect(db.prepare('SELECT status FROM people WHERE id = ?').pluck().get(p)).toBe('suppressed');
  });
});

describe('static PWA', () => {
  it.each([
    ['a plain directory', ''],
    ['a path with a dot-directory (e.g. .claude/worktrees)', path.join('.hidden', 'dist')],
  ])('serves install assets without auth and the SPA behind Access with fallbacks from %s', async (_label, sub) => {
    const { dir: base, cleanup } = tempDir();
    const dir = path.join(base, sub);
    fs.mkdirSync(dir, { recursive: true });
    try {
      fs.writeFileSync(path.join(dir, 'apple-touch-icon.png'), 'png');
      fs.mkdirSync(path.join(dir, 'assets'));
      fs.mkdirSync(path.join(dir, 'icons'));
      fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>yeackbot</title>');
      fs.writeFileSync(path.join(dir, 'assets', 'app-abc123.js'), 'console.log(1)');
      fs.writeFileSync(path.join(dir, 'manifest.webmanifest'), '{"name":"yeackbot"}');
      fs.writeFileSync(path.join(dir, 'icons', 'icon-192.png'), 'png');
      const app = createApp({ db: memDb(), auth: { mode: 'access', team: 't', aud: 'a', allowedEmail: 'owner@example.com', jwks: async () => Promise.reject(new Error('no')) }, webDist: dir });
      const manifest = await request(app).get('/manifest.webmanifest');
      expect(manifest.status).toBe(200);
      expect(manifest.headers['content-type']).toMatch(/manifest\+json/);
      expect((await request(app).get('/icons/icon-192.png')).status).toBe(200);
      expect((await request(app).get('/icons/missing.png')).status).toBe(404);
      expect((await request(app).get('/apple-touch-icon.png')).status).toBe(200);
      expect((await request(app).get('/')).status).toBe(401);

      const dev = devApp(memDb(), { webDist: dir });
      const asset = await request(dev).get('/assets/app-abc123.js');
      expect(asset.headers['cache-control']).toMatch(/immutable/);
      const deep = await request(dev).get('/people/123').set('Accept', 'text/html');
      expect(deep.status).toBe(200);
      expect(deep.text).toMatch(/yeackbot/);
      expect(deep.headers['cache-control']).toBe('no-cache');
      const root = await request(dev).get('/').set('Accept', 'text/html');
      expect(root.status).toBe(200);
      expect(root.text).toMatch(/yeackbot/);
    } finally {
      cleanup();
    }
  });
});
