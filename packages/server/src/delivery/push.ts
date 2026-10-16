/**
 * Web Push (VAPID) to the owner's own subscribed PWA devices (delivery/types.ts PushSender), plus the device store
 * and the fan-out every caller uses.
 *
 *   - VAPID keys: VAPID_* in .env when set; otherwise generated ONCE (web-push) and kept AES-GCM encrypted in the
 *     secrets table ('vapid.keys'). The private key is never logged or returned.
 *   - Requests are built by web-push (aes128gcm payload encryption + VAPID JWT) and sent with undici, so tests use
 *     a MockAgent and nothing ever reaches a real push service.
 *   - Endpoints must be https on a known push service (Apple, Google FCM, Mozilla, Windows): a subscription can't
 *     make the server POST anywhere else.
 *   - Payload bodies are generic ("Your brief is ready · 4 things"); names only with push.names_in_notifications.
 *   - 404/410 from the push service = the subscription is gone: the row is deleted (the PWA resubscribes).
 */
import { PushPayload, uuidv7, type PushDevice } from '@yb/shared';
import { Agent, request, type Dispatcher } from 'undici';
import webpush, { type RequestDetails } from 'web-push';
import type { DB } from '../db/connection';
import { errorFields, nullLogger, type Logger } from '../ops/logger';
import { getSecret, setSecret } from '../security/secrets';
import type { PushSendResult, PushSender, PushTarget } from './types';

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export interface PushSenderOptions {
  /** VAPID keys (null = push not configured). Never log the private key. */
  vapid: VapidKeys | null;
  log?: Logger;
  /** undici dispatcher (tests pass a MockAgent). */
  dispatcher?: Dispatcher;
  timeoutMs?: number;
}

export const disabledPushSender: PushSender = {
  configured: false,
  publicKey: null,
  send: async () => ({ ok: false, gone: false, statusCode: null, error: 'not_configured' }),
};

/** The VAPID `sub` claim when .env doesn't set one (a contact URL for push services; no personal data). */
export const DEFAULT_VAPID_SUBJECT = 'https://yeackbot.com';
export const VAPID_SECRET_NAME = 'vapid.keys';

/** Push services a subscription endpoint may point at (host or a subdomain of it). */
export const PUSH_HOST_ALLOWLIST: readonly string[] = [
  'web.push.apple.com',
  'fcm.googleapis.com',
  'android.googleapis.com',
  'push.services.mozilla.com',
  'notify.windows.com',
];

/** https + a known push service host. */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false;
  const host = u.hostname.toLowerCase();
  return PUSH_HOST_ALLOWLIST.some((h) => host === h || host.endsWith(`.${h}`));
}

/** Host of an endpoint (what the devices list shows; never the full endpoint, which is a capability). */
export function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).hostname.toLowerCase();
  } catch {
    return 'unknown';
  }
}

/** Topic header: ≤32 URL-safe base64 chars. */
const topicOf = (tag: string | undefined): string | undefined => {
  const t = tag?.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
  return t ? t : undefined;
};

export class WebPushSender implements PushSender {
  readonly configured = true;
  readonly publicKey: string;
  private readonly dispatcher: Dispatcher;
  private readonly log: Logger;

  constructor(private readonly o: PushSenderOptions & { vapid: VapidKeys }) {
    this.publicKey = o.vapid.publicKey;
    this.dispatcher = o.dispatcher ?? new Agent({ keepAliveTimeout: 10_000, connections: 2 });
    this.log = o.log ?? nullLogger;
  }

  async send(target: PushTarget, payload: PushPayload, options: { ttlSeconds?: number; urgency?: 'low' | 'normal' | 'high' } = {}): Promise<PushSendResult> {
    const body = PushPayload.safeParse(payload);
    if (!body.success) return { ok: false, gone: false, statusCode: null, error: 'invalid_payload' };
    if (!isAllowedPushEndpoint(target.endpoint)) return { ok: false, gone: false, statusCode: null, error: 'endpoint_not_allowed' };
    let details: RequestDetails;
    try {
      details = webpush.generateRequestDetails({ endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } }, JSON.stringify(body.data), {
        vapidDetails: this.o.vapid,
        TTL: Math.max(0, Math.round(options.ttlSeconds ?? 4 * 3600)),
        urgency: options.urgency ?? 'normal',
        contentEncoding: 'aes128gcm',
        topic: topicOf(body.data.tag),
      });
    } catch (e) {
      this.log.warn('push.invalid_subscription', { ids: [target.id], error_class: errorFields(e).error_class });
      return { ok: false, gone: false, statusCode: null, error: 'invalid_subscription' };
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(details.headers)) if (v !== undefined && v !== null) headers[k.toLowerCase()] = String(v);
    const timeout = this.o.timeoutMs ?? 15_000;
    try {
      const res = await request(details.endpoint, {
        method: 'POST',
        dispatcher: this.dispatcher,
        headers,
        body: details.body ?? undefined,
        headersTimeout: timeout,
        bodyTimeout: timeout,
        signal: AbortSignal.timeout(timeout),
      });
      await res.body.dump();
      if (res.statusCode >= 200 && res.statusCode < 300) return { ok: true, statusCode: res.statusCode };
      const gone = res.statusCode === 404 || res.statusCode === 410;
      return { ok: false, gone, statusCode: res.statusCode, error: `push service answered ${res.statusCode}` };
    } catch (e) {
      const f = errorFields(e);
      return { ok: false, gone: false, statusCode: null, error: f.error_code ?? f.error_class ?? 'network_error' };
    }
  }
}

export function createPushSender(o: PushSenderOptions): PushSender {
  return o.vapid ? new WebPushSender({ ...o, vapid: o.vapid }) : disabledPushSender;
}

// ---------------------------------------------------------------------------------------------- VAPID keys

const isKeyPair = (v: unknown): v is { publicKey: string; privateKey: string } =>
  !!v &&
  typeof v === 'object' &&
  typeof (v as { publicKey?: unknown }).publicKey === 'string' &&
  typeof (v as { privateKey?: unknown }).privateKey === 'string';

/** The stored VAPID pair, or null (no SECRETS_KEY, nothing stored yet, or undecryptable). */
export function loadVapidKeys(db: DB, secretsKey: Buffer | null, subject = DEFAULT_VAPID_SUBJECT): VapidKeys | null {
  if (!secretsKey) return null;
  try {
    const raw = getSecret(db, secretsKey, VAPID_SECRET_NAME);
    if (!raw) return null;
    const v = JSON.parse(raw) as unknown;
    return isKeyPair(v) ? { publicKey: v.publicKey, privateKey: v.privateKey, subject } : null;
  } catch {
    return null;
  }
}

/** The stored VAPID pair, generated and stored once when missing. Null without SECRETS_KEY. */
export function ensureVapidKeys(db: DB, secretsKey: Buffer | null, now = Date.now()): VapidKeys | null {
  if (!secretsKey) return null;
  const existing = loadVapidKeys(db, secretsKey);
  if (existing) return existing;
  // A row that exists but can't be decrypted is left alone (a wrong SECRETS_KEY must not silently rotate keys).
  if (db.prepare('SELECT 1 FROM secrets WHERE name = ?').get(VAPID_SECRET_NAME)) return null;
  const keys = webpush.generateVAPIDKeys();
  setSecret(db, secretsKey, VAPID_SECRET_NAME, JSON.stringify({ publicKey: keys.publicKey, privateKey: keys.privateKey }), now);
  return { ...keys, subject: DEFAULT_VAPID_SUBJECT };
}

// ---------------------------------------------------------------------------------------------- which sender

/** Secrets-backed senders by database: routes register one at startup, jobs (which have no SECRETS_KEY) reuse it. */
const registry = new WeakMap<DB, PushSender>();

export function registerPushSender(db: DB, sender: PushSender): void {
  registry.set(db, sender);
}

export function registeredPushSender(db: DB): PushSender | null {
  return registry.get(db) ?? null;
}

// ---------------------------------------------------------------------------------------------- devices

interface SubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string | null;
  created_at: number;
  last_ok_at: number | null;
  failures: number;
}

/** After this many consecutive non-gone failures a subscription is dropped too. */
export const MAX_PUSH_FAILURES = 10;

export function listPushDevices(db: DB): PushDevice[] {
  const rows = db.prepare('SELECT * FROM push_subscriptions ORDER BY created_at').all() as SubscriptionRow[];
  return rows.map((r) => ({
    id: r.id,
    userAgent: r.user_agent,
    endpointHost: endpointHost(r.endpoint),
    createdAt: r.created_at,
    lastOkAt: r.last_ok_at,
    failures: r.failures,
  }));
}

export function pushDeviceCount(db: DB): number {
  return db.prepare('SELECT count(*) FROM push_subscriptions').pluck().get() as number;
}

export interface SubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  expirationTime?: number | null;
  userAgent?: string;
}

/** Inserts or refreshes a device (keyed by endpoint). Returns its id and whether it is new. */
export function upsertSubscription(db: DB, s: SubscriptionInput, now = Date.now()): { id: string; created: boolean } {
  const existing = db.prepare('SELECT id FROM push_subscriptions WHERE endpoint = ?').pluck().get(s.endpoint) as string | undefined;
  const ua = s.userAgent?.trim().slice(0, 200) || null;
  if (existing) {
    db.prepare(
      `UPDATE push_subscriptions SET p256dh = ?, auth = ?, user_agent = coalesce(?, user_agent), expiration_time = ?, failures = 0,
         last_failure_at = NULL, last_status = NULL WHERE id = ?`,
    ).run(s.keys.p256dh, s.keys.auth, ua, s.expirationTime ?? null, existing);
    return { id: existing, created: false };
  }
  const id = uuidv7(now);
  db.prepare(
    `INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, user_agent, created_at, expiration_time) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, s.endpoint, s.keys.p256dh, s.keys.auth, ua, now, s.expirationTime ?? null);
  return { id, created: true };
}

export function deleteSubscription(db: DB, endpoint: string): boolean {
  return db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint).changes > 0;
}

export interface PushFanoutResult {
  sent: number;
  failed: number;
  removed: number;
}

/**
 * Sends one payload to every subscribed device (or the one with `endpoint`). Records last_ok_at / failures,
 * deletes gone subscriptions (404/410) and ones failing MAX_PUSH_FAILURES times in a row. Never throws.
 */
export async function pushToDevices(
  db: DB,
  sender: PushSender,
  payload: PushPayload,
  o: { endpoint?: string; now?: () => number; log?: Logger; ttlSeconds?: number; urgency?: 'low' | 'normal' | 'high' } = {},
): Promise<PushFanoutResult> {
  const out: PushFanoutResult = { sent: 0, failed: 0, removed: 0 };
  if (!sender.configured) return out;
  const rows = (
    o.endpoint
      ? db.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?').all(o.endpoint)
      : db.prepare('SELECT * FROM push_subscriptions ORDER BY created_at').all()
  ) as SubscriptionRow[];
  const log = o.log ?? nullLogger;
  for (const r of rows) {
    const res = await sender.send({ id: r.id, endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth }, payload, {
      ttlSeconds: o.ttlSeconds,
      urgency: o.urgency,
    });
    const now = o.now?.() ?? Date.now();
    if (res.ok) {
      out.sent++;
      db.prepare('UPDATE push_subscriptions SET last_ok_at = ?, failures = 0, last_status = ? WHERE id = ?').run(now, res.statusCode, r.id);
    } else if (res.gone || r.failures + 1 >= MAX_PUSH_FAILURES) {
      out.failed++;
      out.removed++;
      db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(r.id);
    } else {
      out.failed++;
      db.prepare('UPDATE push_subscriptions SET failures = failures + 1, last_failure_at = ?, last_status = ? WHERE id = ?').run(now, res.statusCode, r.id);
    }
  }
  if (rows.length) log.info('push.fanout', { counts: { ...out, devices: rows.length } });
  return out;
}
