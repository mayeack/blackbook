import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { uuidv7 } from '@yb/shared';
import { connectedClient, GPHOTOS_REFRESH_TOKEN_SECRET, type FetchLike } from '../../../src/adapters/calendar/google';
import { screenshotsDir } from '../../../src/adapters/gphotos/files';
import { recordSourceHealth } from '../../../src/adapters/common/cursors';
import {
  disconnectGphotos,
  DOWNLOADS_PER_PASS,
  FILE_TTL_MS,
  gphotosJobs,
  GPHOTOS_INTERVAL_MS,
  runGphotos,
  UPDATE_COLLECTOR_TEXT,
} from '../../../src/adapters/gphotos/jobs';
import { pickerApi } from '../../../src/adapters/gphotos/picker';
import { gphotosOverview, GphotosNotConnectedError, pickerSessionStatus, startPickerSession, type GphotosDeps } from '../../../src/adapters/gphotos/sessions';
import type { DB } from '../../../src/db/connection';
import { gphotosStatus } from '../../../src/routes/gphotos';
import type { LogFields, Logger } from '../../../src/ops/logger';
import type { JobContext } from '../../../src/scheduler/scheduler';
import { deleteSecret, setSecret } from '../../../src/security/secrets';
import { memDb, seedIdentity, seedPerson, tempDir } from '../../helpers';
import { COLLECTOR, FakeOcrCollector } from '../../screenshots/fakeCollector';
import {
  CARD_EMAIL,
  CARD_NAME,
  CARD_PHONE,
  CHAT_PHONE,
  chatWithNumber,
  contactCard,
  IG_HANDLE,
  IG_NAME,
  igProfile,
  plainPhoto,
} from '../../screenshots/fixtures';
import { CLIENT, FakePhotos, fakeImage, MEDIA_HOST, REFRESH, T0, type FakeItem } from './fakePhotos';

const KEY = crypto.randomBytes(32);
const SEC = 1000;
const MIN = 60 * SEC;
const MiB = 1024 * 1024;
const OWNER_PHONE = '+12125550100';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

type CapturedLog = Logger & { lines: { level: string; event: string; fields?: LogFields }[] };
function captureLog(): CapturedLog {
  const lines: CapturedLog['lines'] = [];
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

const SCENARIOS = { ig: igProfile(), card: contactCard(), chat: chatWithNumber(), plain: plainPhoto(), empty: [] };

function setup(o: { connected?: boolean } = {}) {
  const db = memDb();
  if (o.connected !== false) setSecret(db, KEY, GPHOTOS_REFRESH_TOKEN_SECRET, REFRESH, T0);
  db.prepare(`INSERT INTO settings (key, value, created_at, updated_at) VALUES ('tz', ?, ?, ?)`).run(JSON.stringify('America/New_York'), T0, T0);
  const me = seedPerson(db, { kind: 'me', display_name: 'Owner Example', first_name: 'Owner', last_name: 'Example' });
  seedIdentity(db, me, 'phone', OWNER_PHONE);
  const t = tempDir();
  /** Google's clock (a new session's expireTime is an hour after it). */
  const clock = { now: T0 };
  const g = new FakePhotos(() => clock.now);
  const col = new FakeOcrCollector(SCENARIOS);
  const tokenFile = FakeOcrCollector.tokenFile(t.dir);
  const deps: GphotosDeps = {
    secretsKey: KEY,
    google: CLIENT,
    fetch: g.fetch,
    dataDir: t.dir,
    collectorUrl: COLLECTOR,
    collectorTokenFile: tokenFile,
    collectorDispatcher: col.agent,
  };
  cleanups.push(t.cleanup, () => g.close(), () => col.close());
  return { db, g, col, deps, dir: t.dir, me, clock };
}

/** The owner started a session at T0 and picked `items` (each served as the named OCR scenario). */
async function picked(s: ReturnType<typeof setup>, items: (FakeItem & { scenario?: string })[]) {
  const started = await startPickerSession(s.db, s.deps, T0);
  s.g.pick(started.sessionId, items);
  for (const it of s.g.sessions.get(started.sessionId)!.items) {
    const scenario = items.find((i) => i.id === it.id)?.scenario;
    if (scenario) s.g.serve(it.path!, { body: fakeImage(scenario) });
  }
  return started.sessionId;
}

/** deps whose fetch runs `before` ahead of the nth media download: the owner acting while the pass awaits Google. */
function onMediaDownload(s: ReturnType<typeof setup>, n: number, before: () => Promise<void> | void): GphotosDeps {
  let seen = 0;
  const fetch: FetchLike = async (input, init) => {
    if (String(input instanceof URL ? input.href : input).startsWith(MEDIA_HOST) && ++seen === n) await before();
    return s.g.fetch(input, init);
  };
  return { ...s.deps, fetch };
}

const people = (db: DB) => db.prepare('SELECT count(*) FROM people').pluck().get() as number;

const shots = (db: DB) =>
  db.prepare('SELECT * FROM contact_screenshots ORDER BY source_ref').all() as {
    id: string;
    source_ref: string;
    session_id: string;
    status: string;
    kind: string | null;
    person_id: string | null;
    found: string;
    taken_at: number | null;
    error_class: string | null;
    attempts: number;
  }[];
const health = (db: DB) =>
  db.prepare(`SELECT status, last_error, details FROM source_health WHERE source = 'gphotos'`).get() as
    | { status: string; last_error: string | null; details: string }
    | undefined;
const files = (dir: string) => (fs.existsSync(screenshotsDir(dir)) ? fs.readdirSync(screenshotsDir(dir)).sort() : []);
const mode = (p: string) => fs.statSync(p).mode & 0o777;

describe('gphotos job: end to end', () => {
  it('polls, downloads, OCRs, resolves, deletes files and the session', async () => {
    const s = setup();
    const { db, g, col, dir } = s;
    const started = await startPickerSession(db, s.deps, T0);
    expect(started).toEqual({ sessionId: 'sess-1', pickerUri: 'https://photos.google.com/picker/sess-1', expiresAt: T0 + 3_600_000 });
    expect(pickerSessionStatus(db, 'sess-1')).toMatchObject({ status: 'open', itemsTotal: 0, processed: 0, linked: 0 });

    // Not due yet (pollInterval 5 s): no Google call.
    const callsBefore = g.calls.length;
    await runGphotos(ctx(db, T0 + 2 * SEC), s.deps);
    expect(g.calls.length).toBe(callsBefore);

    // Due, nothing picked yet.
    await runGphotos(ctx(db, T0 + 10 * SEC), s.deps);
    expect(g.callsTo('GET', /^\/v1\/sessions\/sess-1$/)).toHaveLength(1);
    expect(g.callsTo('GET', /^\/v1\/mediaItems$/)).toHaveLength(0);

    g.pick('sess-1', [
      { id: 'media-ig' },
      { id: 'media-card', createTime: '2026-10-19T03:30:00Z' },
      { id: 'media-chat' },
      { id: 'media-plain' },
      { id: 'media-video', type: 'VIDEO', mimeType: 'video/mp4' },
    ]);
    const its = g.sessions.get('sess-1')!.items;
    for (const [i, sc] of ['ig', 'card', 'chat', 'plain'].entries()) g.serve(its[i]!.path!, { body: fakeImage(sc) });

    const log = captureLog();
    const out = await runGphotos(ctx(db, T0 + 30 * SEC, log), s.deps);
    expect(out).toMatchObject({ status: 'ok' });
    expect(out && out.stats).toMatchObject({ downloaded: 4, skipped_not_photo: 1, sessions_done: 1, ocr: 4, linked: 2, created: 2, ambiguous: 1, no_contact: 1 });

    // Session: deleted on Google's side, done here.
    expect(g.sessions.get('sess-1')!.deleted).toBe(true);
    expect(pickerSessionStatus(db, 'sess-1')).toMatchObject({ status: 'done', itemsTotal: 5, itemsNew: 4, processed: 4, linked: 2 });

    const rows = shots(db);
    expect(rows.map((r) => [r.source_ref, r.status, r.kind])).toEqual([
      ['media-card', 'linked', 'contact_card'],
      ['media-chat', 'ambiguous', 'message'],
      ['media-ig', 'linked', 'instagram_profile'],
      ['media-plain', 'no_contact', 'other'],
    ]);
    const card = rows[0]!;
    expect(card.taken_at).toBe(Date.parse('2026-10-19T03:30:00Z'));
    const cardPerson = db.prepare('SELECT display_name, status, origin FROM people WHERE id = ?').get(card.person_id) as Record<string, string>;
    expect(cardPerson).toEqual({ display_name: CARD_NAME, status: 'provisional', origin: 'screenshot' });
    expect(JSON.parse(card.found)).toEqual({ phones: 1, emails: 1, handles: 0, name: true, via: 'phone' });
    const ig = rows[2]!;
    expect(JSON.parse(ig.found)).toMatchObject({ handles: 1, followers: 1234, via: 'instagram_username' });
    expect(db.prepare('SELECT display_name FROM people WHERE id = ?').pluck().get(ig.person_id)).toBe(IG_NAME);
    expect(JSON.parse(rows[1]!.found)).toMatchObject({ phones: 1, reason: 'not_a_card' });

    // One import run journaled the new people.
    const runs = db.prepare(`SELECT kind, status FROM runs WHERE kind = 'import'`).all();
    expect(runs).toEqual([{ kind: 'import', status: 'ok' }]);
    expect(db.prepare(`SELECT count(*) FROM change_batches WHERE kind = 'create_person'`).pluck().get()).toBe(2);

    // Files: OCR'd → deleted; the directory stays 0700.
    expect(files(dir)).toEqual([]);
    expect(mode(screenshotsDir(dir))).toBe(0o700);
    expect(col.ocrCalls()).toBe(4);

    expect(health(db)).toMatchObject({ status: 'ok', last_error: null });
    expect(JSON.parse(health(db)!.details)).toMatchObject({ connected: true, screenshots: 4, linked: 2, pending: 0 });
    expect(gphotosOverview(db)).toEqual({ connected: true, lastPickAt: T0, screenshots: 4, linked: 2, pendingOcr: 0 });

    // Logs: counts only — no name, handle, phone, email or OCR text.
    const logged = JSON.stringify(log.lines);
    for (const pii of [CARD_NAME, IG_NAME, IG_HANDLE, CARD_PHONE, CARD_EMAIL, CHAT_PHONE, '555-0142', 'synth pop', 'Coffee', 'media-card', 'sess-1']) {
      expect(logged).not.toContain(pii);
    }
    expect(log.lines.map((l) => l.event)).toEqual(['gphotos.pass']);

    // Nothing ever went to an LLM.
    expect(db.prepare('SELECT count(*) FROM llm_requests').pluck().get()).toBe(0);

    // Idle afterwards: a cheap no-op.
    const calls = g.calls.length;
    expect(await runGphotos(ctx(db, T0 + 2 * MIN), s.deps)).toEqual({ status: 'skipped', stats: { idle: 1 } });
    expect(g.calls.length).toBe(calls);
  });

  it('names files by the contact_screenshots id (0600), never the Picker id; an old collector leaves them waiting', async () => {
    const s = setup();
    s.col.version = 'old';
    await picked(s, [
      { id: 'media-card', scenario: 'card' },
      { id: 'media-ig', scenario: 'ig' },
    ]);
    const out = await runGphotos(ctx(s.db, T0 + 10 * SEC), s.deps);
    expect(out).toMatchObject({ status: 'partial' });
    const rows = shots(s.db);
    expect(rows.map((r) => r.status)).toEqual(['downloaded', 'downloaded']);
    expect(files(s.dir)).toEqual(rows.map((r) => `${r.id}.img`).sort());
    for (const f of files(s.dir)) {
      expect(f).not.toContain('media');
      expect(mode(path.join(screenshotsDir(s.dir), f))).toBe(0o600);
    }
    expect(mode(screenshotsDir(s.dir))).toBe(0o700);
    expect(health(s.db)).toMatchObject({ status: 'error', last_error: UPDATE_COLLECTOR_TEXT });
    expect(gphotosOverview(s.db).pendingOcr).toBe(2);

    // Within 15 minutes the OCR step isn't retried; the health stays.
    const ocrCalls = s.col.requests.length;
    await runGphotos(ctx(s.db, T0 + 5 * MIN), s.deps);
    expect(s.col.requests.length).toBe(ocrCalls);
    expect(health(s.db)).toMatchObject({ status: 'error', last_error: UPDATE_COLLECTOR_TEXT });

    // The collector is updated: the files are read and removed.
    s.col.version = 'new';
    const out2 = await runGphotos(ctx(s.db, T0 + 20 * MIN), s.deps);
    expect(out2).toMatchObject({ status: 'ok' });
    expect(shots(s.db).map((r) => r.status)).toEqual(['linked', 'linked']);
    expect(files(s.dir)).toEqual([]);
    expect(health(s.db)).toMatchObject({ status: 'ok' });
  });

  it('a file still waiting after 7 days is deleted and its row expired', async () => {
    const s = setup();
    s.col.version = 'old';
    await picked(s, [{ id: 'media-card', scenario: 'card' }]);
    await runGphotos(ctx(s.db, T0 + 10 * SEC), s.deps);
    expect(files(s.dir)).toHaveLength(1);
    await runGphotos(ctx(s.db, T0 + 10 * SEC + FILE_TTL_MS), s.deps);
    expect(shots(s.db)[0]).toMatchObject({ status: 'expired', error_class: 'ttl' });
    expect(files(s.dir)).toEqual([]);
  });

  it('prunes orphan files and leftover tmp files, leaving foreign files alone', async () => {
    const s = setup();
    fs.mkdirSync(screenshotsDir(s.dir), { recursive: true, mode: 0o700 });
    const orphan = uuidv7(T0);
    fs.writeFileSync(path.join(screenshotsDir(s.dir), `${orphan}.img`), 'x');
    fs.writeFileSync(path.join(screenshotsDir(s.dir), `${uuidv7(T0)}.img.tmp`), 'x');
    fs.writeFileSync(path.join(screenshotsDir(s.dir), 'README.txt'), 'x');
    const out = await runGphotos(ctx(s.db, T0), s.deps);
    expect(out && out.stats).toMatchObject({ pruned_files: 2 });
    expect(files(s.dir)).toEqual(['README.txt']);
  });

  it('re-requests an image over 4 MiB at =w960-h960; one still too large fails without a file', async () => {
    const s = setup();
    const id = await picked(s, [{ id: 'media-big' }, { id: 'media-huge' }]);
    const [big, huge] = s.g.sessions.get(id)!.items;
    s.g.serve(big!.path!, { size: 'w1280-h1280', body: Buffer.alloc(4 * MiB + 1, 1) }, { size: 'w960-h960', body: fakeImage('card') });
    s.g.serve(huge!.path!, { body: Buffer.alloc(4 * MiB + 1, 2) });
    await runGphotos(ctx(s.db, T0 + 10 * SEC), s.deps);
    const media = s.g.calls.filter((c) => c.host === 'lh3.googleusercontent.com').map((c) => c.path.split('=')[1]);
    expect(media).toEqual(['w1280-h1280', 'w960-h960', 'w1280-h1280', 'w960-h960']);
    const rows = shots(s.db);
    expect(rows.map((r) => [r.source_ref, r.status, r.error_class])).toEqual([
      ['media-big', 'linked', null],
      ['media-huge', 'failed', 'too_large'],
    ]);
    expect(files(s.dir)).toEqual([]);
  });

  it('a non-image response is a failed row, never a file', async () => {
    const s = setup();
    const id = await picked(s, [{ id: 'media-html' }]);
    s.g.serve(s.g.sessions.get(id)!.items[0]!.path!, { body: Buffer.from('<html></html>'), contentType: 'text/html' });
    await runGphotos(ctx(s.db, T0 + 10 * SEC), s.deps);
    expect(shots(s.db)[0]).toMatchObject({ status: 'failed', error_class: 'not_image' });
    expect(files(s.dir)).toEqual([]);
  });

  it('a 413 from the collector is a final failure (payload_too_large) and the file goes', async () => {
    const s = setup();
    s.col.failures.set('card', { status: 413, code: 'payload_too_large' });
    await picked(s, [{ id: 'media-card', scenario: 'card' }]);
    await runGphotos(ctx(s.db, T0 + 10 * SEC), s.deps);
    expect(shots(s.db)[0]).toMatchObject({ status: 'failed', error_class: 'payload_too_large' });
    expect(files(s.dir)).toEqual([]);
    // Final: the next pass doesn't touch it.
    const n = s.col.requests.length;
    await runGphotos(ctx(s.db, T0 + 20 * SEC), s.deps);
    expect(s.col.requests.length).toBe(n);
  });

  it('an unreadable image fails at once; a 5xx retries, failing after 3 attempts', async () => {
    const s = setup();
    s.col.failures.set('card', { status: 500, code: 'internal' });
    await picked(s, [
      { id: 'media-card', scenario: 'card' },
      { id: 'media-weird', scenario: 'no-such-scenario' },
    ]);
    await runGphotos(ctx(s.db, T0 + 10 * SEC), s.deps);
    expect(shots(s.db).map((r) => [r.source_ref, r.status, r.attempts])).toEqual([
      ['media-card', 'downloaded', 1],
      ['media-weird', 'failed', 1],
    ]);
    expect(shots(s.db)[1]!.error_class).toBe('image_unreadable');
    await runGphotos(ctx(s.db, T0 + 2 * MIN), s.deps);
    await runGphotos(ctx(s.db, T0 + 3 * MIN), s.deps);
    expect(shots(s.db)[0]).toMatchObject({ status: 'failed', attempts: 3, error_class: 'http_500' });
    expect(files(s.dir)).toEqual([]);
  });

  it('a collector that is not running leaves the files waiting with a health error', async () => {
    const s = setup();
    fs.rmSync(s.deps.collectorTokenFile!);
    await picked(s, [{ id: 'media-card', scenario: 'card' }]);
    const out = await runGphotos(ctx(s.db, T0 + 10 * SEC), s.deps);
    expect(out).toMatchObject({ status: 'partial', stats: { collector_unavailable: 1 } });
    expect(shots(s.db)[0]).toMatchObject({ status: 'downloaded', attempts: 0 });
    expect(files(s.dir)).toHaveLength(1);
    expect(health(s.db)?.status).toBe('error');
  });

  it('never downloads a media item twice (persistent id), even from a later session', async () => {
    const s = setup();
    await picked(s, [{ id: 'media-card', scenario: 'card' }]);
    await runGphotos(ctx(s.db, T0 + 10 * SEC), s.deps);
    const media = () => s.g.calls.filter((c) => c.host === 'lh3.googleusercontent.com').length;
    expect(media()).toBe(1);
    const second = await startPickerSession(s.db, s.deps, T0 + MIN);
    s.g.pick(second.sessionId, [{ id: 'media-card' }]);
    await runGphotos(ctx(s.db, T0 + 2 * MIN), s.deps);
    expect(media()).toBe(1);
    expect(pickerSessionStatus(s.db, second.sessionId)).toMatchObject({ status: 'done', itemsTotal: 1, itemsNew: 0 });
    expect(shots(s.db)).toHaveLength(1);
  });
});

describe('gphotos job: refusals, expiry and auth', () => {
  it('a base URL off the allowlist → health warning, the session is kept and retried later', async () => {
    const s = setup();
    await picked(s, [{ id: 'media-evil', baseUrl: 'https://evil.example/test-1' }]);
    const out = await runGphotos(ctx(s.db, T0 + 10 * SEC), s.deps);
    expect(out).toMatchObject({ status: 'partial', stats: { refused: 1 } });
    expect(s.g.sessions.get('sess-1')!.deleted).toBe(false);
    expect(s.g.callsTo('DELETE', /sessions/)).toHaveLength(0);
    expect(s.db.prepare('SELECT status, error_class, poll_after FROM gphotos_sessions').get()).toEqual({
      status: 'picked',
      error_class: 'download_refused',
      poll_after: T0 + 10 * SEC + 5 * MIN,
    });
    expect(health(s.db)?.status).toBe('error');
    expect(health(s.db)?.last_error).toMatch(/refused/);
    expect(JSON.parse(health(s.db)!.details)).toMatchObject({ refused: 1 });
    expect(shots(s.db)).toEqual([]);
    // Not retried before poll_after.
    const n = s.g.calls.length;
    await runGphotos(ctx(s.db, T0 + 2 * MIN), s.deps);
    expect(s.g.calls.length).toBe(n);
  });

  it('a redirect from the media host is refused the same way', async () => {
    const s = setup();
    const id = await picked(s, [{ id: 'media-redirect' }]);
    s.g.serve(s.g.sessions.get(id)!.items[0]!.path!, { redirectTo: 'https://evil.example/elsewhere' });
    const out = await runGphotos(ctx(s.db, T0 + 10 * SEC), s.deps);
    expect(out).toMatchObject({ status: 'partial', stats: { refused: 1 } });
    expect(s.g.sessions.get(id)!.deleted).toBe(false);
    expect(s.db.prepare('SELECT status FROM gphotos_sessions').pluck().get()).toBe('picked');
  });

  it('a 5xx download keeps the session for the next pass', async () => {
    const s = setup();
    const id = await picked(s, [{ id: 'media-card' }]);
    const p = s.g.sessions.get(id)!.items[0]!.path!;
    s.g.serve(p, { status: 503, body: Buffer.from('busy') });
    await runGphotos(ctx(s.db, T0 + 10 * SEC), s.deps);
    expect(s.db.prepare('SELECT status, error_class FROM gphotos_sessions').get()).toEqual({ status: 'picked', error_class: 'download_failed' });
    s.g.serve(p, { body: fakeImage('card') });
    await runGphotos(ctx(s.db, T0 + 2 * MIN), s.deps);
    expect(s.db.prepare('SELECT status FROM gphotos_sessions').pluck().get()).toBe('done');
    expect(shots(s.db)[0]!.status).toBe('linked');
  });

  it('a session past its expireTime, or one Google says to stop polling, expires', async () => {
    const s = setup();
    await startPickerSession(s.db, s.deps, T0);
    const n = s.g.calls.length;
    await runGphotos(ctx(s.db, T0 + 2 * 3_600_000), s.deps);
    expect(s.g.calls.length).toBe(n);
    expect(pickerSessionStatus(s.db, 'sess-1')?.status).toBe('expired');

    await startPickerSession(s.db, s.deps, T0);
    s.g.sessions.get('sess-2')!.timeoutIn = '0s';
    await runGphotos(ctx(s.db, T0 + 10 * SEC), s.deps);
    expect(pickerSessionStatus(s.db, 'sess-2')?.status).toBe('expired');
  });

  it('a session Google no longer knows fails', async () => {
    const s = setup();
    await startPickerSession(s.db, s.deps, T0);
    s.g.sessions.get('sess-1')!.deleted = true;
    await runGphotos(ctx(s.db, T0 + 10 * SEC), s.deps);
    expect(s.db.prepare('SELECT status, error_class FROM gphotos_sessions').get()).toEqual({ status: 'failed', error_class: 'not_found' });
  });

  it('a revoked grant → auth_required, skipped, session kept', async () => {
    const s = setup();
    await startPickerSession(s.db, s.deps, T0);
    s.g.refreshTokens.clear();
    const out = await runGphotos(ctx(s.db, T0 + 10 * SEC), s.deps);
    expect(out).toMatchObject({ status: 'skipped', stats: { auth_required: 1 } });
    expect(health(s.db)?.status).toBe('auth_required');
    expect(pickerSessionStatus(s.db, 'sess-1')?.status).toBe('open');
  });

  it('disconnected with an open session → the session fails, health disabled', async () => {
    const s = setup();
    await startPickerSession(s.db, s.deps, T0);
    deleteSecret(s.db, GPHOTOS_REFRESH_TOKEN_SECRET);
    await runGphotos(ctx(s.db, T0 + 10 * SEC), s.deps);
    expect(s.db.prepare('SELECT status, error_class FROM gphotos_sessions').get()).toEqual({ status: 'failed', error_class: 'not_connected' });
    expect(health(s.db)?.status).toBe('disabled');
  });
});

describe('gphotos job: limits, duplicates and health', () => {
  it(`downloads at most ${DOWNLOADS_PER_PASS} a pass; the session stays picked until every item is in`, async () => {
    const s = setup();
    s.col.version = 'old'; // keep OCR out of the way: the files wait
    const n = DOWNLOADS_PER_PASS + 5;
    const id = await picked(s, Array.from({ length: n }, (_, i) => ({ id: `media-${i}` })));
    for (const it of s.g.sessions.get(id)!.items) s.g.serve(it.path!, { body: fakeImage('plain') });
    const first = await runGphotos(ctx(s.db, T0 + 10 * SEC), s.deps);
    expect(first && first.stats).toMatchObject({ downloaded: DOWNLOADS_PER_PASS });
    expect(s.g.callsTo('GET', /^\/v1\/mediaItems$/)).toHaveLength(Math.ceil(n / 100));
    expect(pickerSessionStatus(s.db, id)).toMatchObject({ status: 'picked', itemsTotal: n, itemsNew: DOWNLOADS_PER_PASS });
    expect(s.g.sessions.get(id)!.deleted).toBe(false);
    const second = await runGphotos(ctx(s.db, T0 + 20 * SEC), s.deps);
    expect(second && second.stats).toMatchObject({ downloaded: 5, sessions_done: 1 });
    expect(pickerSessionStatus(s.db, id)).toMatchObject({ status: 'done', itemsNew: n });
    expect(s.g.sessions.get(id)!.deleted).toBe(true);
    expect(files(s.dir)).toHaveLength(n);
  });

  it('an item listed twice is downloaded once', async () => {
    const s = setup();
    const id = await picked(s, [{ id: 'media-card', scenario: 'card' }]);
    const sess = s.g.sessions.get(id)!;
    sess.items.push({ ...sess.items[0]! });
    await runGphotos(ctx(s.db, T0 + 10 * SEC), s.deps);
    expect(s.g.calls.filter((c) => c.host === 'lh3.googleusercontent.com')).toHaveLength(1);
    expect(shots(s.db)).toHaveLength(1);
  });

  it('a Picker answer of the wrong shape fails the session and flags contract_broken', async () => {
    const s = setup();
    await startPickerSession(s.db, s.deps, T0);
    s.g.overrides.set('/v1/sessions/sess-1', { id: 'not a valid id' });
    const out = await runGphotos(ctx(s.db, T0 + 10 * SEC), s.deps);
    expect(out).toMatchObject({ status: 'partial', stats: { contract_broken: 1 } });
    expect(s.db.prepare('SELECT status, error_class FROM gphotos_sessions').get()).toEqual({ status: 'failed', error_class: 'contract' });
    expect(health(s.db)?.status).toBe('contract_broken');
  });

  it('a token that cannot be decrypted keeps the sessions, still reads waiting files, and says so', async () => {
    const s = setup();
    await picked(s, [{ id: 'media-card', scenario: 'card' }]);
    s.col.version = 'old';
    await runGphotos(ctx(s.db, T0 + 10 * SEC), s.deps); // downloaded, waiting for OCR
    s.col.version = 'new';
    await startPickerSession(s.db, s.deps, T0 + MIN);
    const wrongKey = { ...s.deps, secretsKey: crypto.randomBytes(32) };
    const out = await runGphotos(ctx(s.db, T0 + 20 * MIN), wrongKey);
    expect(out).toMatchObject({ status: 'partial', stats: { token_unreadable: 1, linked: 1 } });
    expect(pickerSessionStatus(s.db, 'sess-2')?.status).toBe('open');
    expect(health(s.db)).toMatchObject({ status: 'error' });
    expect(health(s.db)?.last_error).toMatch(/can’t be read/);
  });

  it('disconnected with files still waiting: they are read, and the health says disabled', async () => {
    const s = setup();
    s.col.version = 'old';
    await picked(s, [{ id: 'media-card', scenario: 'card' }]);
    await runGphotos(ctx(s.db, T0 + 10 * SEC), s.deps);
    // The pick is done; Google Photos is then disconnected outside the routes (the secret is gone).
    expect(pickerSessionStatus(s.db, 'sess-1')?.status).toBe('done');
    deleteSecret(s.db, GPHOTOS_REFRESH_TOKEN_SECRET);
    s.col.version = 'new';
    await runGphotos(ctx(s.db, T0 + 20 * MIN), s.deps);
    expect(shots(s.db)[0]!.status).toBe('linked');
    expect(health(s.db)).toMatchObject({ status: 'disabled' });
    expect(JSON.parse(health(s.db)!.details)).toMatchObject({ connected: false });
  });

  it('auth_required stays until Google answers again or the owner reconnects', async () => {
    const s = setup();
    await startPickerSession(s.db, s.deps, T0);
    s.g.refreshTokens.clear();
    await runGphotos(ctx(s.db, T0 + 10 * SEC), s.deps);
    expect(health(s.db)?.status).toBe('auth_required');
    // The session runs out without another Google call: nothing proved the grant works again.
    await runGphotos(ctx(s.db, T0 + 2 * 3_600_000), s.deps);
    expect(pickerSessionStatus(s.db, 'sess-1')?.status).toBe('expired');
    expect(health(s.db)?.status).toBe('auth_required');
    // Reconnecting resets the health (routes/google.ts callback); a later pass is ok again.
    recordSourceHealth(s.db, 'gphotos', T0 + 3 * 3_600_000, 'unknown', { newestDataAt: null });
    fs.mkdirSync(screenshotsDir(s.dir), { recursive: true });
    fs.writeFileSync(path.join(screenshotsDir(s.dir), `${uuidv7(T0)}.img`), 'x'); // an orphan: work to do
    await runGphotos(ctx(s.db, T0 + 3 * 3_600_000 + MIN), s.deps);
    expect(health(s.db)?.status).toBe('ok');
  });
});

describe('gphotos sessions API', () => {
  it('startPickerSession needs a connection, and flags a revoked grant', async () => {
    const off = setup({ connected: false });
    await expect(startPickerSession(off.db, off.deps, T0)).rejects.toBeInstanceOf(GphotosNotConnectedError);
    expect(gphotosOverview(off.db)).toEqual({ connected: false, lastPickAt: null, screenshots: 0, linked: 0, pendingOcr: 0 });
    const on = setup();
    on.g.refreshTokens.clear();
    await expect(startPickerSession(on.db, on.deps, T0)).rejects.toMatchObject({ name: 'GoogleAuthError' });
    expect(health(on.db)?.status).toBe('auth_required');
  });

  it('pickerSessionStatus is null for an unknown id; linked counts only visible people', async () => {
    const s = setup();
    expect(pickerSessionStatus(s.db, 'nope')).toBeNull();
    await picked(s, [{ id: 'media-card', scenario: 'card' }]);
    await runGphotos(ctx(s.db, T0 + 10 * SEC), s.deps);
    expect(pickerSessionStatus(s.db, 'sess-1')?.linked).toBe(1);
    s.db.prepare('UPDATE people SET is_hidden = 1 WHERE id = ?').run(shots(s.db)[0]!.person_id);
    expect(pickerSessionStatus(s.db, 'sess-1')?.linked).toBe(0);
    expect(gphotosOverview(s.db).linked).toBe(0);
    expect(gphotosOverview(s.db).screenshots).toBe(1);
  });

  it('the job is registered every 60 s', () => {
    const s = setup();
    const jobs = gphotosJobs(s.deps);
    expect(jobs.map((j) => [j.name, j.schedule])).toEqual([['gphotos', { kind: 'interval', everyMs: GPHOTOS_INTERVAL_MS }]]);
    expect(GPHOTOS_INTERVAL_MS).toBe(60_000);
  });

  it('the registered job runs through its own collector client', async () => {
    const s = setup();
    await picked(s, [{ id: 'media-card', scenario: 'card' }]);
    const [job] = gphotosJobs(s.deps);
    await job!.run(ctx(s.db, T0 + 10 * SEC));
    expect(shots(s.db)[0]!.status).toBe('linked');
  });
});

describe('disconnectGphotos', () => {
  it('cancels open sessions, deletes the files and expires waiting rows; deleteData drops the rows', async () => {
    const s = setup();
    s.col.version = 'old';
    await picked(s, [{ id: 'media-card', scenario: 'card' }]);
    await runGphotos(ctx(s.db, T0 + 10 * SEC), s.deps);
    await startPickerSession(s.db, s.deps, T0 + MIN);
    expect(files(s.dir)).toHaveLength(1);
    const api = pickerApi(connectedClient(s.db, KEY, CLIENT, s.g.fetch, 'photos')!);
    const r = await disconnectGphotos(s.db, { dataDir: s.dir, api, now: T0 + 2 * MIN });
    expect(r).toEqual({ sessions: 1, files: 1, screenshots: 0 });
    expect(s.g.sessions.get('sess-2')!.deleted).toBe(true);
    expect(pickerSessionStatus(s.db, 'sess-2')?.status).toBe('cancelled');
    expect(files(s.dir)).toEqual([]);
    expect(shots(s.db)[0]).toMatchObject({ status: 'expired', error_class: 'disconnected' });
    expect(await disconnectGphotos(s.db, { dataDir: s.dir, deleteData: true })).toEqual({ sessions: 0, files: 0, screenshots: 1 });
    expect(shots(s.db)).toEqual([]);
  });

  it('works without an API (already disconnected)', async () => {
    const s = setup();
    await startPickerSession(s.db, s.deps, T0);
    expect(await disconnectGphotos(s.db, { dataDir: s.dir })).toEqual({ sessions: 1, files: 0, screenshots: 0 });
    expect(s.g.sessions.get('sess-1')!.deleted).toBe(false);
  });
});

describe('gphotos job: the disconnect fence, re-picks and stale sessions', () => {
  it('a disconnect during a download pass fences it: nothing is written, read or linked after it, the session stays cancelled', async () => {
    for (const deleteData of [true, false]) {
      const s = setup();
      await picked(s, [
        { id: 'media-card', scenario: 'card' },
        { id: 'media-ig', scenario: 'ig' },
        { id: 'media-chat', scenario: 'chat' },
      ]);
      const before = people(s.db);
      // The route while the 2nd download is in flight: Calendar is still connected (no revoke), so the pass's client
      // keeps working after the photos token is deleted.
      const deps = onMediaDownload(s, 2, async () => {
        const api = pickerApi(connectedClient(s.db, KEY, CLIENT, s.g.fetch, 'photos')!);
        await disconnectGphotos(s.db, { dataDir: s.dir, deleteData, api, now: T0 + 10 * SEC });
        deleteSecret(s.db, GPHOTOS_REFRESH_TOKEN_SECRET);
      });
      const out = await runGphotos(ctx(s.db, T0 + 10 * SEC), deps);
      expect(out && out.stats).toMatchObject({ fenced: 1 });
      expect(pickerSessionStatus(s.db, 'sess-1')?.status).toBe('cancelled');
      expect(shots(s.db).map((r) => [r.source_ref, r.status, r.error_class])).toEqual(deleteData ? [] : [['media-card', 'expired', 'disconnected']]);
      expect(files(s.dir)).toEqual([]);
      expect(s.col.ocrCalls()).toBe(0);
      expect(people(s.db)).toBe(before);
      // The 3rd item was never fetched.
      expect(s.g.calls.filter((c) => c.host === 'lh3.googleusercontent.com')).toHaveLength(2);
      // The pass reports what it ends on: Photos no longer connected.
      expect(health(s.db)?.status).toBe('disabled');
      expect(JSON.parse(health(s.db)!.details)).toMatchObject({ connected: false, screenshots: deleteData ? 0 : 1, pending: 0 });
    }
  });

  it('re-picking a screenshot that was never read downloads it again under its row; one that can never be read stays skipped', async () => {
    const s = setup();
    s.col.version = 'old';
    const first = await picked(s, [{ id: 'media-card', scenario: 'card' }, { id: 'media-huge' }, { id: 'media-empty' }]);
    const [, huge, empty] = s.g.sessions.get(first)!.items;
    s.g.serve(huge!.path!, { body: Buffer.alloc(4 * MiB + 1, 2) });
    s.g.serve(empty!.path!, { body: Buffer.alloc(0) });
    await runGphotos(ctx(s.db, T0 + 10 * SEC), s.deps);
    expect(shots(s.db).map((r) => [r.source_ref, r.status, r.error_class])).toEqual([
      ['media-card', 'downloaded', null],
      ['media-empty', 'failed', 'empty'],
      ['media-huge', 'failed', 'too_large'],
    ]);
    const ids = shots(s.db).map((r) => r.id);
    // The collector is updated only after the 7-day rule expired the waiting file.
    const later = T0 + 10 * SEC + FILE_TTL_MS;
    await runGphotos(ctx(s.db, later), s.deps);
    expect(shots(s.db)[0]).toMatchObject({ status: 'expired', error_class: 'ttl' });
    s.col.version = 'new';

    s.clock.now = later + MIN;
    const second = await startPickerSession(s.db, s.deps, later + MIN);
    s.g.pick(second.sessionId, [{ id: 'media-card' }, { id: 'media-huge' }, { id: 'media-empty' }]);
    const again = s.g.sessions.get(second.sessionId)!.items;
    s.g.serve(again[0]!.path!, { body: fakeImage('card') });
    s.g.serve(again[1]!.path!, { body: Buffer.alloc(4 * MiB + 1, 2) });
    s.g.serve(again[2]!.path!, { body: fakeImage('plain') });
    const media = s.g.calls.filter((c) => c.host === 'lh3.googleusercontent.com').length;
    const out = await runGphotos(ctx(s.db, later + 2 * MIN), s.deps);
    expect(out && out.stats).toMatchObject({ downloaded: 2, sessions_done: 1, linked: 1, no_contact: 1 });
    // media-huge is not fetched again.
    expect(s.g.calls.filter((c) => c.host === 'lh3.googleusercontent.com').map((c) => c.path.split('=')[0]).slice(media)).toEqual([
      again[0]!.path,
      again[2]!.path,
    ]);
    expect(shots(s.db).map((r) => [r.id, r.source_ref, r.session_id, r.status, r.error_class, r.attempts])).toEqual([
      [ids[0], 'media-card', second.sessionId, 'linked', null, 1],
      [ids[1], 'media-empty', second.sessionId, 'no_contact', null, 1],
      [ids[2], 'media-huge', first, 'failed', 'too_large', 0],
    ]);
    expect(files(s.dir)).toEqual([]);
    expect(pickerSessionStatus(s.db, second.sessionId)).toMatchObject({ status: 'done', itemsTotal: 3, itemsNew: 2, processed: 2, linked: 1 });
    expect(pickerSessionStatus(s.db, first)).toMatchObject({ itemsNew: 1, processed: 1 });
  });

  it('a screenshot a disconnect expired is downloaded again when picked after reconnecting', async () => {
    const s = setup();
    s.col.version = 'old';
    await picked(s, [{ id: 'media-card', scenario: 'card' }]);
    await runGphotos(ctx(s.db, T0 + 10 * SEC), s.deps);
    await disconnectGphotos(s.db, { dataDir: s.dir, now: T0 + MIN });
    expect(shots(s.db)[0]).toMatchObject({ status: 'expired', error_class: 'disconnected' });
    s.col.version = 'new';
    const second = await startPickerSession(s.db, s.deps, T0 + 2 * MIN);
    s.g.pick(second.sessionId, [{ id: 'media-card' }]);
    s.g.serve(s.g.sessions.get(second.sessionId)!.items[0]!.path!, { body: fakeImage('card') });
    await runGphotos(ctx(s.db, T0 + 20 * MIN), s.deps); // past the 15-minute retry of the old collector
    expect(shots(s.db).map((r) => [r.session_id, r.status])).toEqual([[second.sessionId, 'linked']]);
    expect(pickerSessionStatus(s.db, second.sessionId)).toMatchObject({ status: 'done', itemsNew: 1, processed: 1, linked: 1 });
  });

  it('a session past its expiry ends even while the token can’t be read', async () => {
    const s = setup();
    await startPickerSession(s.db, s.deps, T0);
    const wrongKey = { ...s.deps, secretsKey: crypto.randomBytes(32) };
    const out = await runGphotos(ctx(s.db, T0 + 5 * 3_600_000), wrongKey);
    expect(out).toMatchObject({ status: 'partial', stats: { token_unreadable: 1, sessions_expired: 1 } });
    expect(pickerSessionStatus(s.db, 'sess-1')?.status).toBe('expired');
    expect(gphotosStatus(s.db, true, T0 + 5 * 3_600_000).session).toMatchObject({ id: 'sess-1', status: 'expired' });
    expect(health(s.db)?.last_error).toMatch(/can’t be read/);
    // Nothing left to do: the job goes idle.
    expect(await runGphotos(ctx(s.db, T0 + 6 * 3_600_000), wrongKey)).toEqual({ status: 'skipped', stats: { idle: 1 } });
  });

  it('after a deleteData disconnect a finished pick no longer reads as still being read', async () => {
    const s = setup();
    await picked(s, [
      { id: 'media-card', scenario: 'card' },
      { id: 'media-ig', scenario: 'ig' },
      { id: 'media-plain', scenario: 'plain' },
    ]);
    await runGphotos(ctx(s.db, T0 + 10 * SEC), s.deps);
    expect(pickerSessionStatus(s.db, 'sess-1')).toMatchObject({ status: 'done', itemsNew: 3, processed: 3 });
    await disconnectGphotos(s.db, { dataDir: s.dir, deleteData: true, now: T0 + 10 * MIN });
    // Reconnected within the hour: the status answer still carries the finished pick.
    const view = gphotosStatus(s.db, true, T0 + 20 * MIN).session!;
    expect(view).toMatchObject({ id: 'sess-1', status: 'done', itemsNew: 0, processed: 0, linked: 0 });
    // The web keeps polling a 'done' session while processed < itemsNew (lib/googleProducts.ts sessionActive).
    expect(view.processed < view.itemsNew).toBe(false);
  });
});
