/**
 * Web Push API for the PWA (owner only; mutating routes need JSON + X-YB: 1):
 *
 *   GET  /push/vapid        → PushVapid          the VAPID public key (generated once into the secrets table when
 *                                                .env has none and SECRETS_KEY is set), configured, push.enabled
 *   GET  /push/devices      → PushDevices        endpoint HOST only, never the endpoint (it is a capability)
 *   POST /push/subscribe    PushSubscribe → PushSubscribeResult
 *        https endpoints on known push services only. The first device ever subscribed turns push.enabled on
 *        (journaled, undoable) unless the owner already set it explicitly.
 *   POST /push/unsubscribe  PushUnsubscribe → OkResult
 *   POST /push/test         PushTest → PushTestResult   a generic test notification to this owner's own subscribed
 *                                                       devices (or the one endpoint, which must be subscribed)
 */
import { Router } from 'express';
import {
  PushSubscribe,
  PushTest,
  PushUnsubscribe,
  type OkResult,
  type PushDevices,
  type PushSubscribeResult,
  type PushTestResult,
  type PushVapid,
} from '@yb/shared';
import { deleteSubscription, isAllowedPushEndpoint, listPushDevices, pushDeviceCount, pushToDevices, upsertSubscription } from '../delivery/push';
import { pushSenderFor } from '../delivery/pushResolve';
import { HttpError, notFound } from '../http/errors';
import { errorFields } from '../ops/logger';
import { readSetting, writeSettings } from '../settings/registry';
import type { RouteDeps } from './index';

const notConfigured = () =>
  new HttpError(409, 'PUSH_NOT_CONFIGURED', 'Push isn’t set up on the server yet (VAPID keys need SECRETS_KEY or VAPID_* in .env).');

export function pushRoutes(deps: RouteDeps): Router {
  const { db } = deps;
  const r = Router();
  // Load (never generate) secrets-backed VAPID keys now, so the delivery job (which has no SECRETS_KEY) can push.
  try {
    pushSenderFor(deps);
  } catch (e) {
    deps.log.warn('push.vapid_load_failed', { error_class: errorFields(e).error_class });
  }

  r.get('/push/vapid', (_req, res) => {
    const sender = pushSenderFor(deps, { generate: true });
    res.json({ publicKey: sender.publicKey, configured: sender.configured, enabled: readSetting(db, 'push.enabled') } satisfies PushVapid);
  });

  r.get('/push/devices', (_req, res) => {
    res.json({ devices: listPushDevices(db) } satisfies PushDevices);
  });

  r.post('/push/subscribe', (req, res) => {
    const body = PushSubscribe.parse(req.body);
    if (!pushSenderFor(deps).configured) throw notConfigured();
    if (!isAllowedPushEndpoint(body.endpoint)) throw new HttpError(400, 'PUSH_ENDPOINT_NOT_ALLOWED', 'That push service isn’t supported.');
    const before = pushDeviceCount(db);
    const { id, created } = upsertSubscription(db, { endpoint: body.endpoint, keys: body.keys, expirationTime: body.expirationTime ?? null, userAgent: body.userAgent });
    const explicitlySet = db.prepare(`SELECT 1 FROM settings WHERE key = 'push.enabled'`).get() !== undefined;
    if (created && before === 0 && !explicitlySet) {
      try {
        writeSettings(db, { 'push.enabled': true }, { actor: 'user', title: 'Turned on push notifications' });
      } catch (e) {
        deps.log.warn('push.enable_failed', { error_class: errorFields(e).error_class });
      }
    }
    deps.log.info('push.subscribed', { ids: [id], counts: { created: created ? 1 : 0, devices: before + (created ? 1 : 0) } });
    res.json({ id } satisfies PushSubscribeResult);
  });

  r.post('/push/unsubscribe', (req, res) => {
    const body = PushUnsubscribe.parse(req.body);
    deleteSubscription(db, body.endpoint);
    res.json({ ok: true } satisfies OkResult);
  });

  r.post('/push/test', async (req, res) => {
    const body = PushTest.parse(req.body ?? {});
    const sender = pushSenderFor(deps);
    if (!sender.configured) throw notConfigured();
    if (body.endpoint && !db.prepare('SELECT 1 FROM push_subscriptions WHERE endpoint = ?').get(body.endpoint)) throw notFound('Device');
    const result = await pushToDevices(
      db,
      sender,
      { kind: 'test', title: 'Yeackbot', body: 'Test notification · push works', url: '/settings', tag: 'test' },
      { endpoint: body.endpoint, log: deps.log, ttlSeconds: 600, urgency: 'high' },
    );
    res.json(result satisfies PushTestResult);
  });

  return r;
}
