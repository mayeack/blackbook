/**
 * Delivery decisions, tick by tick, with fakes only (nothing is ever sent anywhere): ships disabled, sends once at
 * digest.time to the owner, catch-up, quiet hours, pause, empty days, heartbeat, pipeline-failure notice, push.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@yb/shared';
import { outboundTextHash } from '../../src/adapters/imessage/mapping';
import { composeDigest } from '../../src/delivery/compose';
import { upsertSubscription } from '../../src/delivery/push';
import { deliveryTick, emptyStreak, type DeliveryDeps } from '../../src/delivery/send';
import { BOT_MARKER, checkOutboundText } from '../../src/delivery/types';
import { FakeOutboundSender, FakePushSender } from '../fakes/delivery';
import { FakeEgress, FakeLlmClient } from '../fakes/llm';
import { seedPerson } from '../helpers';
import { buildWorld, DAY, DAY_DATE, seedDigest, seedSuggestion, setSettings, typicalDay, zoned, type World } from './world';

let w: World;
let now: number;
let outbound: FakeOutboundSender;
let push: FakePushSender;

const deps = (o: Partial<DeliveryDeps> = {}): DeliveryDeps => ({
  db: w.db,
  services: { llm: new FakeLlmClient({ configured: false }), egress: new FakeEgress(), outbound },
  push,
  now: () => now,
  ...o,
});
const tickAt = (hhmm: string, date = DAY_DATE, o: Partial<DeliveryDeps> = {}) => {
  now = zoned(date, hhmm);
  return deliveryTick(deps(o));
};
const digestRow = (date = DAY_DATE) => w.db.prepare('SELECT * FROM digests WHERE local_date = ?').get(date) as Record<string, unknown>;
const KEYS = { p256dh: 'BFakeP256dhKeyForTestsOnly', auth: 'FakeAuthForTests' };

beforeEach(() => {
  w = buildWorld();
  outbound = new FakeOutboundSender({ db: w.db, now: () => now, selfHandle: 'owner@example.com' });
  push = new FakePushSender();
});

describe('digest delivery', () => {
  it('ships disabled: nothing is texted, the brief stays on Today, and after catch-up it is skipped as disabled', async () => {
    typicalDay(w);
    expect((await tickAt('08:00')).imessage).toBe('disabled');
    expect(outbound.sent).toHaveLength(0);
    expect(digestRow()).toMatchObject({ status: 'ready', imessage_status: 'disabled', skip_reason: 'disabled', push_status: 'disabled' });
    expect(digestRow().imessage_text).toMatch(/^\u{1F168} Wed Oct 14 · 4 for today/u);
    await tickAt('11:00');
    expect(digestRow()).toMatchObject({ status: 'skipped', skip_reason: 'disabled' });
    expect(outbound.sent).toHaveLength(0);
  });

  it('enabled: waits for digest.time, sends once to self, records the outbound row and marks items delivered', async () => {
    const { ids } = typicalDay(w);
    setSettings(w.db, { 'digest.enabled': true });
    expect((await tickAt('07:59')).action).toBe('before_time');
    const r = await tickAt('08:00');
    expect(r).toMatchObject({ action: 'delivered', imessage: 'sent' });
    expect(outbound.sent).toHaveLength(1);
    const sent = outbound.sent[0]!;
    expect(sent).toMatchObject({ purpose: 'digest' });
    expect(sent.text.startsWith(BOT_MARKER)).toBe(true);
    expect(checkOutboundText(sent.text)).toEqual([]);
    expect(sent.options.digestId).toBe(digestRow().id);
    expect(digestRow()).toMatchObject({ status: 'sent', sent_at: now, outbound_id: sent.outboundId, imessage_status: 'sent', skip_reason: null });
    expect(w.db.prepare('SELECT text_hash FROM outbound_messages WHERE id = ?').pluck().get(sent.outboundId)).toBe(outboundTextHash(sent.text));
    expect(w.db.prepare(`SELECT count(*) FROM suggestions WHERE status = 'delivered' AND delivered_at = ?`).pluck().get(now)).toBe(ids.length);
    for (const t of ['08:01', '09:00', '10:59']) expect((await tickAt(t)).action).toBe('final');
    expect(outbound.sent).toHaveLength(1);
  });

  it('sends the composed text (07:30 compose), recomposing if the ranker’s picks changed', async () => {
    const { digestId } = typicalDay(w);
    setSettings(w.db, { 'digest.enabled': true });
    now = zoned(DAY_DATE, '07:30');
    await composeDigest(w.db, { llm: new FakeLlmClient({ configured: false }), egress: new FakeEgress() }, { localDate: DAY_DATE, now });
    const extra = seedSuggestion(w.db, { kind: 'dormant', personId: w.dora });
    w.db.prepare('INSERT INTO digest_items (digest_id, ordinal, suggestion_id) VALUES (?, 5, ?)').run(digestId, extra);
    await tickAt('08:00');
    expect(outbound.sent[0]!.text).toContain('· 5 for today');
    expect(outbound.sent[0]!.text).toMatch(/^5 Dora V\. · /m);
  });

  it('catch-up: a Mac that was down sends late until digest.catch_up_until, then Today only', async () => {
    typicalDay(w);
    setSettings(w.db, { 'digest.enabled': true });
    await tickAt('10:45');
    expect(outbound.sent).toHaveLength(1);

    const w2 = buildWorld({ enabled: true });
    w = w2;
    outbound = new FakeOutboundSender({ db: w.db, now: () => now });
    typicalDay(w);
    expect(await tickAt('11:00')).toMatchObject({ action: 'skipped', imessage: 'skipped' });
    expect(digestRow()).toMatchObject({ status: 'skipped', skip_reason: 'catch_up_passed' });
    expect(outbound.sent).toHaveLength(0);
  });

  it('quiet hours and pause hold the brief; resume before catch-up still sends', async () => {
    typicalDay(w);
    setSettings(w.db, { 'digest.enabled': true, quiet_hours: { start: '10:00', end: '07:00' }, 'digest.paused_until': zoned(DAY_DATE, '09:00') });
    expect(await tickAt('08:00')).toMatchObject({ action: 'waiting', imessage: 'skipped', reason: 'paused' });
    expect(await tickAt('10:15')).toMatchObject({ action: 'waiting', imessage: 'pending', reason: 'quiet_hours' });
    setSettings(w.db, { quiet_hours: { start: '22:00', end: '07:00' } });
    expect(await tickAt('10:20')).toMatchObject({ action: 'delivered' });
    expect(outbound.sent).toHaveLength(1);
  });

  it('no collector / self handle: retried each tick, then skipped with that reason', async () => {
    typicalDay(w);
    setSettings(w.db, { 'digest.enabled': true });
    outbound = new FakeOutboundSender({ configured: false });
    expect(await tickAt('08:00')).toMatchObject({ action: 'waiting', imessage: 'not_configured', reason: 'collector_unavailable' });
    await tickAt('11:30');
    expect(digestRow()).toMatchObject({ status: 'skipped', skip_reason: 'collector_unavailable' });
  });

  it('a ghost or failed send is final (never retried into a double send); a full circuit waits', async () => {
    typicalDay(w);
    setSettings(w.db, { 'digest.enabled': true });
    outbound = new FakeOutboundSender({ db: w.db, now: () => now, status: 'ghost' });
    expect(await tickAt('08:00')).toMatchObject({ action: 'failed', imessage: 'failed' });
    expect(digestRow()).toMatchObject({ status: 'failed', skip_reason: 'ghost' });
    await tickAt('08:01');
    expect(outbound.sent).toHaveLength(1);
  });
});

describe('empty days, heartbeat and failure notices', () => {
  it('an empty digest is skipped silently; a missing row becomes an empty one after the grace period', async () => {
    setSettings(w.db, { 'digest.enabled': true });
    seedDigest(w.db, DAY_DATE, []);
    expect(await tickAt('08:00')).toMatchObject({ action: 'skipped', reason: 'empty' });
    expect(digestRow()).toMatchObject({ status: 'skipped', skip_reason: 'empty' });
    expect(await tickAt('08:05', '2026-10-15')).toMatchObject({ action: 'no_digest_yet' });
    expect(await tickAt('08:25', '2026-10-15')).toMatchObject({ action: 'skipped', reason: 'empty' });
    expect(digestRow('2026-10-15')).toMatchObject({ status: 'skipped', skip_reason: 'empty' });
    expect(outbound.sent).toHaveLength(0);
  });

  it('a late ranker (Mac asleep at 07:16) keeps the day: delivery waits until catch-up, then a late ranking takes over', async () => {
    setSettings(w.db, { 'digest.enabled': true });
    // the suggestions job last covered yesterday and isn't failing
    w.db.prepare(`INSERT INTO job_state (job, last_success_local_date, consecutive_failures) VALUES ('suggestions', '2026-10-13', 0)`).run();
    expect(await tickAt('09:00')).toMatchObject({ action: 'no_digest_yet', reason: 'ranker_pending' });
    expect(digestRow()).toBeUndefined();
    // a failing ranker doesn't hold the day hostage: the empty day is closed (and the streak counts it)
    w.db.prepare(`UPDATE job_state SET consecutive_failures = 2 WHERE job = 'suggestions'`).run();
    expect(await tickAt('09:05')).toMatchObject({ action: 'skipped', reason: 'empty' });
    // …and a placeholder like that is taken over when the ranking finally lands
    const { takeOverPlaceholder } = await import('../../src/pipeline/suggestions/stage');
    expect(takeOverPlaceholder(w.db, DAY_DATE)).toBe(true);
    expect(digestRow()).toMatchObject({ status: 'composing', skip_reason: null, imessage_status: null });
    expect(outbound.sent).toHaveLength(0);
  });

  it('every third consecutive empty day sends one heartbeat line', async () => {
    setSettings(w.db, { 'digest.enabled': true });
    seedPerson(w.db, { display_name: 'Ezra Pell', first_name: 'Ezra', last_name: 'Pell', created_at: zoned('2026-10-13', '12:00') });
    await tickAt('08:30', '2026-10-12');
    await tickAt('08:30', '2026-10-13');
    expect(outbound.sent).toHaveLength(0);
    expect(emptyStreak(w.db, '2026-10-14')).toBe(3);
    expect(await tickAt('08:30', '2026-10-14')).toMatchObject({ action: 'heartbeat_sent' });
    expect(outbound.sent.map((s) => [s.purpose, s.text])).toEqual([['heartbeat', `${BOT_MARKER} All quiet 3 days · 1 person added, nothing urgent.`]]);
    expect(digestRow('2026-10-14').notice_outbound_id).toBe(outbound.sent[0]!.outboundId);
    await tickAt('08:30', '2026-10-15');
    await tickAt('08:30', '2026-10-16');
    expect(outbound.sent).toHaveLength(1);
    await tickAt('08:30', '2026-10-17');
    expect(outbound.sent).toHaveLength(2);
  });

  it('a failed nightly stage sends one notice on an empty day, and a health line on a full one', async () => {
    setSettings(w.db, { 'digest.enabled': true });
    const failAt = zoned(DAY_DATE, '06:55');
    w.db.prepare(`INSERT INTO job_runs (job, started_at, finished_at, status, error_class) VALUES ('ties', ?, ?, 'error', 'Error')`).run(failAt, failAt + 1000);
    w.db.prepare(`INSERT INTO job_state (job, last_run_at, consecutive_failures) VALUES ('ties', ?, 1)`).run(failAt);
    seedDigest(w.db, DAY_DATE, []);
    expect(await tickAt('08:00')).toMatchObject({ action: 'notice_sent' });
    expect(outbound.sent[0]).toMatchObject({ purpose: 'alert', text: `${BOT_MARKER} Last night's run failed at ties · yeackbot.com/sources` });
    expect(digestRow()).toMatchObject({ status: 'skipped', skip_reason: 'pipeline_failed' });
    expect(checkOutboundText(outbound.sent[0]!.text)).toEqual([]);

    typicalDay(w, '2026-10-15');
    w.db.prepare(`UPDATE job_runs SET started_at = ? WHERE job = 'ties'`).run(zoned('2026-10-15', '06:55'));
    await tickAt('08:00', '2026-10-15');
    expect(outbound.sent[1]!.text).toContain("⚠ Last night's run failed at ties · see Sources");
    expect(outbound.sent[1]!.text.match(/yeackbot\.com/g)).toHaveLength(1);
  });
});

describe('push ping', () => {
  it('pings subscribed devices once with a generic body, even with the iMessage brief off; gone devices are removed', async () => {
    typicalDay(w);
    setSettings(w.db, { 'push.enabled': true });
    upsertSubscription(w.db, { endpoint: 'https://web.push.apple.com/QFakeLive', keys: KEYS });
    upsertSubscription(w.db, { endpoint: 'https://web.push.apple.com/QFakeDead', keys: KEYS });
    push.fail('https://web.push.apple.com/QFakeDead', 410);
    const r = await tickAt('08:00');
    expect(r).toMatchObject({ imessage: 'disabled', push: 'sent', pushed: { sent: 1, failed: 1, removed: 1 } });
    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]!.payload).toEqual({ kind: 'digest', title: 'Yeackbot', body: 'Your brief is ready · 4 things', url: '/today', tag: `digest-${DAY_DATE}` });
    expect(digestRow().push_sent_at).toBe(now);
    expect(w.db.prepare('SELECT count(*) FROM push_subscriptions').pluck().get()).toBe(1);
    await tickAt('08:05');
    expect(push.sent).toHaveLength(1);
  });

  it('names only with push.names_in_notifications; nothing without push.enabled or devices', async () => {
    typicalDay(w);
    upsertSubscription(w.db, { endpoint: 'https://web.push.apple.com/QFakeLive', keys: KEYS });
    expect(await tickAt('08:00')).toMatchObject({ push: 'disabled' });
    expect(push.sent).toHaveLength(0);
    setSettings(w.db, { 'push.enabled': true, 'push.names_in_notifications': true });
    await tickAt('08:01');
    expect(push.sent[0]!.payload.body).toBe('Your brief is ready · Ava & Ben +2');
  });

  it('pre-event pings are left to the intel job: the delivery tick never sends one', async () => {
    setSettings(w.db, { 'push.enabled': true });
    upsertSubscription(w.db, { endpoint: 'https://web.push.apple.com/QFakeLive', keys: KEYS });
    const occ = uuidv7();
    const at = zoned(DAY_DATE, '10:30');
    w.db.prepare(`INSERT INTO occasions (id, kind, title, starts_at, created_at, updated_at) VALUES (?, 'social', 'Rooftop Social', ?, ?, ?)`).run(occ, at, at, at);
    seedSuggestion(w.db, { kind: 'pre_event_brief', personId: w.ava, occasionId: occ });
    expect((await tickAt('07:31')).healthPushes).toBe(0);
    expect(push.sent.filter((p) => p.payload.kind === 'pre_event')).toHaveLength(0);
  });

  it('a newly opened critical alert gets one generic health push', async () => {
    setSettings(w.db, { 'push.enabled': true });
    upsertSubscription(w.db, { endpoint: 'https://web.push.apple.com/QFakeLive', keys: KEYS });
    w.db.prepare(`INSERT INTO alerts (id, source, severity, message, opened_at) VALUES (?, 'beeper', 'critical', 'synthetic', ?)`).run(uuidv7(), zoned(DAY_DATE, '05:00'));
    expect((await tickAt('07:10')).healthPushes).toBe(1);
    expect(push.sent[0]!.payload).toMatchObject({ kind: 'health', body: 'Instagram needs attention · open Sources', url: '/sources' });
    expect((await tickAt('07:11')).healthPushes).toBe(0);
    // quiet hours hold it
    w.db.prepare(`INSERT INTO alerts (id, source, severity, message, opened_at) VALUES (?, 'partiful', 'critical', 'synthetic', ?)`).run(uuidv7(), zoned(DAY_DATE, '05:00'));
    expect((await tickAt('23:00')).healthPushes).toBe(0);
    expect(push.sent).toHaveLength(1);
    expect(DAY).toBeGreaterThan(0);
  });
});
