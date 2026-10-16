/**
 * Web Push (PWA): VAPID public key, device subscriptions, test push. Push ships DISABLED (settings push.enabled).
 *
 *   GET  /api/v1/push/vapid          → PushVapid
 *   GET  /api/v1/push/devices        → PushDevices
 *   POST /api/v1/push/subscribe      PushSubscribe → PushSubscribeResult
 *   POST /api/v1/push/unsubscribe    PushUnsubscribe → OkResult
 *   POST /api/v1/push/test           PushTest → PushTestResult   (only to this owner's own subscribed devices)
 *
 * Notification bodies never carry names unless push.names_in_notifications is on, and never sensitive content.
 */
import { z } from 'zod';
import { Ms } from './common';

export const PushVapid = z.object({
  /** URL-safe base64 VAPID public key (null = VAPID not configured on the server). */
  publicKey: z.string().nullable(),
  configured: z.boolean(),
  /** settings push.enabled */
  enabled: z.boolean(),
});
export type PushVapid = z.infer<typeof PushVapid>;

/** The browser's PushSubscription.toJSON(). Endpoints must be https. */
export const PushSubscribe = z.object({
  endpoint: z.url().refine((u) => u.startsWith('https://'), 'push endpoints are https'),
  expirationTime: Ms.nullable().optional(),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
  /** Short device label (from navigator.userAgent, trimmed). */
  userAgent: z.string().max(200).optional(),
});
export type PushSubscribe = z.infer<typeof PushSubscribe>;

export const PushSubscribeResult = z.object({ id: z.string() });
export type PushSubscribeResult = z.infer<typeof PushSubscribeResult>;

export const PushUnsubscribe = z.object({ endpoint: z.url() });
export type PushUnsubscribe = z.infer<typeof PushUnsubscribe>;

export const PushTest = z.object({ endpoint: z.url().optional() });
export type PushTest = z.infer<typeof PushTest>;

export const PushTestResult = z.object({ sent: z.number().int(), failed: z.number().int(), removed: z.number().int() });
export type PushTestResult = z.infer<typeof PushTestResult>;

export const PushDevice = z.object({
  id: z.string(),
  userAgent: z.string().nullable(),
  /** Push service host only (e.g. web.push.apple.com), never the full endpoint. */
  endpointHost: z.string(),
  createdAt: Ms,
  lastOkAt: Ms.nullable(),
  failures: z.number().int(),
});
export type PushDevice = z.infer<typeof PushDevice>;

export const PushDevices = z.object({ devices: z.array(PushDevice) });
export type PushDevices = z.infer<typeof PushDevices>;

/** What the service worker receives (JSON payload of the push message). */
export const PushPayload = z.object({
  kind: z.enum(['digest', 'health', 'pre_event', 'test', 'weekly']),
  /** Always "Yeackbot". */
  title: z.string().max(60),
  /** "Your brief is ready · 4 things today". */
  body: z.string().max(180),
  /** Relative path to open on tap (/today, /sources, /e/<id>). */
  url: z.string().regex(/^\/[^/]/).or(z.literal('/')),
  /** Collapses repeats on the lock screen. */
  tag: z.string().max(64).optional(),
});
export type PushPayload = z.infer<typeof PushPayload>;
