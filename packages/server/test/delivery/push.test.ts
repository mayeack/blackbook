/**
 * Web push: the real VAPID sender against an undici MockAgent (no push service is ever reached), VAPID keys in the
 * secrets table, the device store, and the push routes with a FakePushSender.
 */
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockAgent } from 'undici';
import webpush from 'web-push';
import type { PushPayload } from '@yb/shared';
import {
  createPushSender,
  ensureVapidKeys,
  isAllowedPushEndpoint,
  listPushDevices,
  loadVapidKeys,
  pushToDevices,
  upsertSubscription,
  VAPID_SECRET_NAME,
  WebPushSender,
} from '../../src/delivery/push';
import { pushSenderFor } from '../../src/delivery/pushResolve';
import { csrf } from '../../src/http/csrf';
import { errorHandler } from '../../src/http/errors';
import { nullLogger } from '../../src/ops/logger';
import { pushRoutes } from '../../src/routes/push';
import { readSetting } from '../../src/settings/registry';
import { FakePushSender } from '../fakes/delivery';
import { FakeEgress, FakeLlmClient } from '../fakes/llm';
import { FakeOutboundSender } from '../fakes/delivery';
import { memDb } from '../helpers';
import { setSettings } from './world';

const APPLE = 'https://web.push.apple.com';
const FCM = 'https://fcm.googleapis.com';
const payload: PushPayload = { kind: 'digest', title: 'Yeackbot', body: 'Your brief is ready · 4 things', url: '/today', tag: 'digest-2026-10-14' };

function subscriptionKeys(): { p256dh: string; auth: string } {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') };
}

const SECRETS_KEY = crypto.randomBytes(32);

describe('WebPushSender (MockAgent)', () => {
  let agent: MockAgent;
  const hits: { path: string; headers: Record<string, string>; bytes: number }[] = [];
  let status = 201;

  beforeEach(() => {
    hits.length = 0;
    status = 201;
    agent = new MockAgent();
    agent.disableNetConnect();
    for (const origin of [APPLE, FCM]) {
      agent
        .get(origin)
        .intercept({ path: () => true, method: 'POST' })
        .reply((opts) => {
          hits.push({ path: opts.path, headers: opts.headers as Record<string, string>, bytes: Buffer.byteLength(opts.body as Buffer) });
          return { statusCode: opts.path.includes('dead') ? 410 : status, data: '' };
        })
        .persist();
    }
  });
  afterEach(async () => agent.close());

  const sender = () => new WebPushSender({ vapid: { ...webpush.generateVAPIDKeys(), subject: 'https://yeackbot.com' }, dispatcher: agent });

  it('encrypts the payload (aes128gcm) with a VAPID JWT and reports 201 as ok', async () => {
    const r = await sender().send({ id: 's1', endpoint: `${APPLE}/QFakeDevice1`, ...subscriptionKeys() }, payload, { ttlSeconds: 3600, urgency: 'normal' });
    expect(r).toEqual({ ok: true, statusCode: 201 });
    expect(hits).toHaveLength(1);
    const h = hits[0]!.headers;
    expect(h['content-encoding']).toBe('aes128gcm');
    expect(h.authorization).toMatch(/^vapid t=.+, k=.+/);
    expect(h.ttl).toBe('3600');
    expect(h.topic).toBe('digest-2026-10-14');
    expect(hits[0]!.bytes).toBeGreaterThan(0);
  });

  it('410 is gone; unknown hosts and bad payloads never reach the network', async () => {
    const s = sender();
    expect(await s.send({ id: 's2', endpoint: `${FCM}/fcm/send/dead`, ...subscriptionKeys() }, payload)).toMatchObject({ ok: false, gone: true, statusCode: 410 });
    expect(await s.send({ id: 's3', endpoint: 'https://push.example.com/x', ...subscriptionKeys() }, payload)).toMatchObject({ ok: false, error: 'endpoint_not_allowed' });
    expect(await s.send({ id: 's4', endpoint: `${APPLE}/x`, ...subscriptionKeys() }, { ...payload, url: 'https://evil.example.net' })).toMatchObject({
      ok: false,
      error: 'invalid_payload',
    });
    expect(await s.send({ id: 's5', endpoint: `${APPLE}/x`, p256dh: 'bad', auth: 'bad' }, payload)).toMatchObject({ ok: false, error: 'invalid_subscription' });
    expect(hits).toHaveLength(1);
  });

  it('endpoint allowlist: https on known push services only', () => {
    expect(isAllowedPushEndpoint(`${APPLE}/abc`)).toBe(true);
    expect(isAllowedPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/abc')).toBe(true);
    expect(isAllowedPushEndpoint('https://wns2-by3p.notify.windows.com/w/?token=abc')).toBe(true);
    expect(isAllowedPushEndpoint('http://web.push.apple.com/abc')).toBe(false);
    expect(isAllowedPushEndpoint('https://web.push.apple.com.evil.example/abc')).toBe(false);
    expect(isAllowedPushEndpoint('https://127.0.0.1:4321/v1/imessage/send')).toBe(false);
  });

  it('fan-out records successes and deletes gone subscriptions', async () => {
    const db = memDb();
    upsertSubscription(db, { endpoint: `${APPLE}/live`, keys: subscriptionKeys(), userAgent: 'iPhone Safari' });
    upsertSubscription(db, { endpoint: `${FCM}/fcm/send/dead`, keys: subscriptionKeys() });
    const r = await pushToDevices(db, sender(), payload);
    expect(r).toEqual({ sent: 1, failed: 1, removed: 1 });
    const devices = listPushDevices(db);
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ endpointHost: 'web.push.apple.com', userAgent: 'iPhone Safari', failures: 0 });
    expect(devices[0]!.lastOkAt).not.toBeNull();
    expect(JSON.stringify(devices)).not.toContain('/live');
  });
});

describe('VAPID keys in the secrets table', () => {
  it('are generated once, encrypted, and reused; nothing without SECRETS_KEY', () => {
    const db = memDb();
    expect(ensureVapidKeys(db, null)).toBeNull();
    const a = ensureVapidKeys(db, SECRETS_KEY)!;
    expect(a.publicKey).toMatch(/^[A-Za-z0-9_-]{80,90}$/);
    const raw = db.prepare('SELECT ciphertext FROM secrets WHERE name = ?').pluck().get(VAPID_SECRET_NAME) as Buffer;
    expect(raw.toString('utf8')).not.toContain(a.privateKey);
    expect(ensureVapidKeys(db, SECRETS_KEY)).toEqual(a);
    expect(loadVapidKeys(db, SECRETS_KEY)).toEqual(a);
    // A wrong key never rotates the stored pair.
    expect(ensureVapidKeys(db, crypto.randomBytes(32))).toBeNull();
    expect(loadVapidKeys(db, SECRETS_KEY)).toEqual(a);
  });

  it('pushSenderFor: injected services win; secrets-backed sender is registered for jobs', () => {
    const db = memDb();
    expect(pushSenderFor({ db }).configured).toBe(false);
    expect(pushSenderFor({ db, config: { secretsKey: SECRETS_KEY } }).configured).toBe(false); // nothing stored, no generate
    const s = pushSenderFor({ db, config: { secretsKey: SECRETS_KEY } }, { generate: true });
    expect(s.configured).toBe(true);
    // A job (no SECRETS_KEY) gets the same registered sender.
    expect(pushSenderFor({ db })).toBe(s);
    const fake = new FakePushSender();
    const services = () => ({ llm: new FakeLlmClient(), egress: new FakeEgress(), outbound: new FakeOutboundSender(), push: fake });
    expect(pushSenderFor({ db, services })).toBe(fake);
    expect(createPushSender({ vapid: null }).configured).toBe(false);
  });
});

describe('push routes', () => {
  const app = (db = memDb(), push: FakePushSender | null = new FakePushSender()) => {
    const services = push ? () => ({ llm: new FakeLlmClient(), egress: new FakeEgress(), outbound: new FakeOutboundSender(), push }) : undefined;
    const a = express();
    a.use(express.json());
    a.use(csrf);
    a.use('/api/v1', pushRoutes({ db, log: nullLogger, services }));
    a.use(errorHandler(nullLogger));
    return { a, db, push };
  };
  const post = (a: express.Express, url: string, body: unknown) => request(a).post(url).set('X-YB', '1').set('Content-Type', 'application/json').send(body as object);

  it('vapid → subscribe (first device turns push on, journaled) → devices → test → unsubscribe', async () => {
    const { a, db, push } = app();
    expect(readSetting(db, 'push.enabled')).toBe(false);
    const v = await request(a).get('/api/v1/push/vapid');
    expect(v.body).toEqual({ publicKey: 'BFakeVapidPublicKeyForTestsOnly', configured: true, enabled: false });

    const sub = { endpoint: `${APPLE}/QFakeDeviceA`, keys: subscriptionKeys(), userAgent: 'Mozilla/5.0 (iPhone)' };
    const s1 = await post(a, '/api/v1/push/subscribe', sub);
    expect(s1.status).toBe(200);
    expect(readSetting(db, 'push.enabled')).toBe(true);
    expect(db.prepare(`SELECT count(*) FROM change_batches WHERE kind = 'setting'`).pluck().get()).toBe(1);
    // Re-subscribing the same endpoint is an update, not a new device.
    expect((await post(a, '/api/v1/push/subscribe', sub)).body.id).toBe(s1.body.id);

    const devices = await request(a).get('/api/v1/push/devices');
    expect(devices.body.devices).toHaveLength(1);
    expect(JSON.stringify(devices.body)).not.toContain('QFakeDeviceA');

    const t = await post(a, '/api/v1/push/test', {});
    expect(t.body).toEqual({ sent: 1, failed: 0, removed: 0 });
    expect(push!.sent[0]!.payload).toMatchObject({ kind: 'test', title: 'Yeackbot', url: '/settings' });
    expect((await post(a, '/api/v1/push/test', { endpoint: `${APPLE}/someone-else` })).status).toBe(404);

    push!.fail(sub.endpoint, 410);
    expect((await post(a, '/api/v1/push/test', {})).body).toEqual({ sent: 0, failed: 1, removed: 1 });
    expect((await request(a).get('/api/v1/push/devices')).body.devices).toHaveLength(0);

    await post(a, '/api/v1/push/subscribe', sub);
    expect((await post(a, '/api/v1/push/unsubscribe', { endpoint: sub.endpoint })).body).toEqual({ ok: true });
    expect((await request(a).get('/api/v1/push/devices')).body.devices).toHaveLength(0);
  });

  it('respects an explicit push.enabled=false; refuses unknown push hosts and non-https; 409 without VAPID', async () => {
    const { a, db } = app();
    setSettings(db, { 'push.enabled': false });
    await post(a, '/api/v1/push/subscribe', { endpoint: `${APPLE}/QFakeDeviceB`, keys: subscriptionKeys() });
    expect(readSetting(db, 'push.enabled')).toBe(false);
    expect((await post(a, '/api/v1/push/subscribe', { endpoint: 'https://push.example.com/x', keys: subscriptionKeys() })).body.error.code).toBe('PUSH_ENDPOINT_NOT_ALLOWED');
    expect((await post(a, '/api/v1/push/subscribe', { endpoint: 'http://web.push.apple.com/x', keys: subscriptionKeys() })).status).toBe(400);
    const none = app(memDb(), null).a;
    expect((await request(none).get('/api/v1/push/vapid')).body).toEqual({ publicKey: null, configured: false, enabled: false });
    expect((await post(none, '/api/v1/push/subscribe', { endpoint: `${APPLE}/x`, keys: subscriptionKeys() })).status).toBe(409);
    expect((await post(none, '/api/v1/push/test', {})).status).toBe(409);
  });

  it('GET /push/vapid generates the secrets-backed key pair once', async () => {
    const db = memDb();
    const a = express();
    a.use(express.json());
    a.use('/api/v1', pushRoutes({ db, log: nullLogger, config: { secretsKey: SECRETS_KEY } as never }));
    const first = await request(a).get('/api/v1/push/vapid');
    expect(first.body.configured).toBe(true);
    expect((await request(a).get('/api/v1/push/vapid')).body.publicKey).toBe(first.body.publicKey);
    expect(JSON.stringify(first.body)).not.toContain(loadVapidKeys(db, SECRETS_KEY)!.privateKey);
  });
});
