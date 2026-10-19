/**
 * Digest routes (preview never sends or writes; send-test is owner-forced or setting-gated and only ever to self)
 * and the delivery jobs' wiring. Fakes only.
 */
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DigestHistory, DigestPreview, DigestSendTestResult } from '@yb/shared';
import { deliveryJobs } from '../../src/delivery/jobs';
import { todayDigest } from '../../src/delivery/preview';
import { BOT_MARKER } from '../../src/delivery/types';
import { csrf } from '../../src/http/csrf';
import { errorHandler } from '../../src/http/errors';
import { nullLogger } from '../../src/ops/logger';
import { digestRoutes, HELLO_TEXT, MAX_TEST_SENDS_PER_HOUR } from '../../src/routes/digest';
import type { JobContext } from '../../src/scheduler/scheduler';
import { FakeOutboundSender, FakePushSender } from '../fakes/delivery';
import { FakeEgress, FakeLlmClient } from '../fakes/llm';
import { buildWorld, DAY_DATE, seedSuggestion, setSettings, typicalDay, zoned, type World } from './world';

let w: World;
let outbound: FakeOutboundSender;
let llm: FakeLlmClient;

const services = () => ({ llm, egress: new FakeEgress(), outbound, push: new FakePushSender() });
function app(): express.Express {
  const a = express();
  a.use(express.json());
  a.use(csrf);
  a.use('/api/v1', digestRoutes({ db: w.db, log: nullLogger, services }));
  a.use(errorHandler(nullLogger));
  return a;
}
const post = (url: string, body: unknown) => request(app()).post(url).set('X-YB', '1').set('Content-Type', 'application/json').send(body as object);

beforeEach(() => {
  w = buildWorld();
  outbound = new FakeOutboundSender({ db: w.db });
  llm = new FakeLlmClient();
  vi.useFakeTimers({ toFake: ['Date'], now: zoned(DAY_DATE, '07:45') });
});
afterEach(() => vi.useRealTimers());

describe('GET /digest/preview', () => {
  it('renders the exact texts, one per suggestion, without sending, spending or writing', async () => {
    typicalDay(w);
    const res = await request(app()).get('/api/v1/digest/preview');
    expect(res.status).toBe(200);
    const p = DigestPreview.parse(res.body);
    expect(p.date).toBe(DAY_DATE);
    expect(p.texts).toHaveLength(4);
    for (const t of p.texts) expect(t.codePointAt(0)).toBe(0x1f168);
    expect(p.texts[0]!.split('\n')[0]).toBe(`${BOT_MARKER} Good morning! 4 things for today.`);
    expect(p.text).toBe(p.texts.join('\n\n'));
    expect(p).toMatchObject({ composer: 'template', wouldSend: false, reasonNotSent: 'disabled', pushBody: 'Your brief is ready · 4 things' });
    expect(p.items.map((i) => i.ordinal)).toEqual([1, 2, 3, 4]);
    expect(p.items[0]).toMatchObject({ kind: 'fading', copy: 'template', target: { type: 'person', id: w.ava, href: `/p/${w.ava}` } });
    expect(p.items[2]!.target).toMatchObject({ type: 'pair', id: w.cleo, otherId: w.dora });
    expect(p.items[3]).toMatchObject({ sensitive: true });
    expect(p.charCount).toBe(p.texts.reduce((n, t) => n + [...t].length, 0));
    expect(outbound.sent).toHaveLength(0);
    expect(llm.calls).toHaveLength(0);
    expect(w.db.prepare('SELECT composed_at FROM digests').pluck().get()).toBeNull();
  });

  it('says why nothing would go out (enabled → would send; quiet day → empty; past catch-up)', async () => {
    typicalDay(w);
    setSettings(w.db, { 'digest.enabled': true });
    expect((await request(app()).get('/api/v1/digest/preview')).body).toMatchObject({ wouldSend: true, reasonNotSent: null });
    expect((await request(app()).get('/api/v1/digest/preview?date=2026-10-20')).body).toMatchObject({ reasonNotSent: 'empty', items: [] });
    expect((await request(app()).get('/api/v1/digest/preview?date=2026-10-20')).body.texts).toEqual([`${BOT_MARKER} All clear! Nothing needs you today.`]);
    vi.setSystemTime(zoned(DAY_DATE, '11:30'));
    expect((await request(app()).get('/api/v1/digest/preview')).body).toMatchObject({ reasonNotSent: 'catch_up_passed' });
    expect((await request(app()).get('/api/v1/digest/preview?date=bad')).status).toBe(400);
  });
});

describe('POST /digest/send-test', () => {
  it('is refused unless allowed in settings, the brief is on, or the owner forces it', async () => {
    const off = await post('/api/v1/digest/send-test', { confirm: true });
    expect(off.status).toBe(403);
    expect(off.body.error.code).toBe('SEND_DISABLED');
    expect((await post('/api/v1/digest/send-test', { mode: 'hello' })).status).toBe(400); // confirm is required
    expect(outbound.sent).toHaveLength(0);

    const forced = await post('/api/v1/digest/send-test', { confirm: true, force: true });
    expect(forced.status).toBe(200);
    expect(DigestSendTestResult.parse(forced.body)).toMatchObject({ status: 'delivered' });
    expect(outbound.sent[0]).toMatchObject({ text: HELLO_TEXT, purpose: 'test', options: { bypassQuietHours: true } });
    expect(outbound.sent[0]!.text.startsWith(BOT_MARKER)).toBe(true);

    setSettings(w.db, { 'delivery.allow_test_send': true });
    typicalDay(w);
    const digest = await post('/api/v1/digest/send-test', { confirm: true, mode: 'digest' });
    expect(digest.status).toBe(200);
    // the test brief goes out exactly like the real one: one text per suggestion, in order
    expect(outbound.sent.slice(1).map((x) => x.text.split('\n')[0])).toEqual([
      `${BOT_MARKER} Good morning! 4 things for today.`,
      `${BOT_MARKER} 2. Reply to Ben O.`,
      `${BOT_MARKER} 3. Introduce Cleo M. and Dora V.?`,
      `${BOT_MARKER} 4. Something personal`,
    ]);
    expect(outbound.sent.slice(1).every((x) => x.purpose === 'test')).toBe(true);
  });

  it('only ever to self: no collector/self handle → 409; at most a few per hour', async () => {
    setSettings(w.db, { 'delivery.allow_test_send': true });
    const real = outbound;
    outbound = new FakeOutboundSender({ configured: false });
    expect((await post('/api/v1/digest/send-test', { confirm: true })).body.error.code).toBe('DELIVERY_NOT_CONFIGURED');
    outbound = real;
    for (let i = 0; i < MAX_TEST_SENDS_PER_HOUR; i++) expect((await post('/api/v1/digest/send-test', { confirm: true })).status).toBe(200);
    expect((await post('/api/v1/digest/send-test', { confirm: true })).status).toBe(429);
    expect(outbound.sent).toHaveLength(MAX_TEST_SENDS_PER_HOUR);
  });
});

describe('GET /digest/history', () => {
  it('lists digests newest first with item counts and wildcards', async () => {
    typicalDay(w, '2026-10-13');
    const wild = seedSuggestion(w.db, { kind: 'dormant', personId: w.dora, isWildcard: true, wildcardGenerator: 'dormant_close' });
    w.db.prepare(`INSERT INTO digests (id, local_date, status) VALUES ('019a0000-0000-7000-8000-0000000000d1', ?, 'skipped')`).run(DAY_DATE);
    w.db.prepare(`INSERT INTO digest_items (digest_id, ordinal, suggestion_id) VALUES ('019a0000-0000-7000-8000-0000000000d1', 1, ?)`).run(wild);
    const res = await request(app()).get('/api/v1/digest/history?limit=5');
    const h = DigestHistory.parse(res.body);
    expect(h.digests.map((d) => [d.localDate, d.itemCount, d.hadWildcard])).toEqual([
      [DAY_DATE, 1, true],
      ['2026-10-13', 4, false],
    ]);
  });
});

describe('delivery jobs', () => {
  it('registers compose (daily) and digest-send (interval); a send tick never texts while disabled', async () => {
    typicalDay(w);
    const jobs = deliveryJobs({ services });
    expect(jobs.map((j) => [j.name, j.schedule.kind])).toEqual([
      ['compose', 'daily'],
      ['digest-send', 'interval'],
    ]);
    const ctx = (at: number): JobContext => ({ db: w.db, jobRunId: 1, trigger: 'manual', now: () => at, log: nullLogger, signal: new AbortController().signal });
    expect(await jobs[0]!.run(ctx(zoned(DAY_DATE, '07:30')))).toMatchObject({ stats: { items: 4 } });
    expect(todayDigest(w.db, DAY_DATE)).toMatchObject({ status: 'ready', imessage: 'pending', push: 'pending' });
    await jobs[1]!.run(ctx(zoned(DAY_DATE, '08:00')));
    expect(outbound.sent).toHaveLength(0);
    expect(todayDigest(w.db, DAY_DATE)).toMatchObject({ status: 'ready', imessage: 'disabled', skipReason: 'disabled' });
    setSettings(w.db, { 'digest.enabled': true });
    await jobs[1]!.run(ctx(zoned(DAY_DATE, '08:01')));
    expect(outbound.sent).toHaveLength(4);
    // The fake LLM answered nothing usable at 07:30, so the template copy went out: 'fallback_sent'.
    expect(todayDigest(w.db, DAY_DATE)).toMatchObject({ status: 'fallback_sent', imessage: 'sent' });
  });
});
