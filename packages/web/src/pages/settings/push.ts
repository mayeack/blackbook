/**
 * Web Push on this device (Settings → Push): support detection, the VAPID key, subscribing through the service
 * worker and telling the server. Browser objects are passed in, so the flow is unit-tested (test/settings.test.ts).
 * Nothing here ever sends a notification; the server's /push/test does, to the owner's own devices only.
 */
import type { PushSubscribe } from '@yb/shared';

export type PushSupport =
  /** No Push API at all. */
  | 'unsupported'
  /** iPhone/iPad Safari: push works only from the Home Screen app. */
  | 'needs_install'
  /** No service worker (development builds don't register one). */
  | 'no_worker'
  | 'denied'
  | 'ready';

export interface PushEnv {
  hasPushManager: boolean;
  hasNotification: boolean;
  hasServiceWorker: boolean;
  /** navigator.serviceWorker.controller or a registration exists. */
  workerRegistered: boolean;
  permission: NotificationPermission | null;
  userAgent: string;
  /** display-mode: standalone (or navigator.standalone on iOS). */
  standalone: boolean;
}

const isIos = (ua: string) => /\b(iPhone|iPad|iPod)\b/.test(ua) || (/\bMacintosh\b/.test(ua) && /\bMobile\//.test(ua));

export function pushSupport(env: PushEnv): PushSupport {
  if (isIos(env.userAgent) && !env.standalone) return 'needs_install';
  if (!env.hasPushManager || !env.hasNotification || !env.hasServiceWorker) return 'unsupported';
  if (!env.workerRegistered) return 'no_worker';
  if (env.permission === 'denied') return 'denied';
  return 'ready';
}

/** URL-safe base64 (the VAPID public key) → bytes for applicationServerKey. */
export function urlBase64ToUint8Array(b64url: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (b64url.length % 4)) % 4);
  const b64 = (b64url + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Whether an existing subscription was made with this VAPID key (a rotated key needs a fresh subscription). */
export function sameKey(existing: ArrayBuffer | null | undefined, key: Uint8Array): boolean {
  if (!existing) return false;
  const a = new Uint8Array(existing);
  if (a.length !== key.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== key[i]) return false;
  return true;
}

/** A short device label ("iPhone · Safari", "Mac · Chrome") instead of the full user agent. */
export function deviceLabel(ua: string): string {
  const device = /\biPhone\b/.test(ua)
    ? 'iPhone'
    : /\biPad\b/.test(ua) || (/\bMacintosh\b/.test(ua) && /\bMobile\//.test(ua))
      ? 'iPad'
      : /\bAndroid\b/.test(ua)
        ? 'Android'
        : /\bMacintosh\b/.test(ua)
          ? 'Mac'
          : /\bWindows\b/.test(ua)
            ? 'Windows'
            : /\bLinux\b/.test(ua)
              ? 'Linux'
              : 'Device';
  const browser = /\bEdg\//.test(ua)
    ? 'Edge'
    : /\bFirefox\//.test(ua)
      ? 'Firefox'
      : /\b(Chrome|CriOS)\//.test(ua)
        ? 'Chrome'
        : /\bSafari\//.test(ua)
          ? 'Safari'
          : 'Browser';
  return `${device} · ${browser}`;
}

/** The body for POST /push/subscribe from PushSubscription.toJSON(); null when the browser left something out. */
export function subscribeBody(json: PushSubscriptionJSON, userAgent: string): PushSubscribe | null {
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!json.endpoint || !json.endpoint.startsWith('https://') || !p256dh || !auth) return null;
  return {
    endpoint: json.endpoint,
    expirationTime: json.expirationTime ?? null,
    keys: { p256dh, auth },
    userAgent: deviceLabel(userAgent).slice(0, 200),
  };
}

export interface SubscribeDeps {
  requestPermission: () => Promise<NotificationPermission>;
  getRegistration: () => Promise<{ pushManager: PushManager } | null>;
  post: (body: PushSubscribe) => Promise<{ id: string }>;
  userAgent: string;
}

export type SubscribeOutcome =
  | { ok: true; id: string; endpoint: string }
  | { ok: false; reason: 'denied' | 'no_worker' | 'no_key' | 'bad_subscription' };

/**
 * Asks for permission (must run from a tap), subscribes through the service worker (reusing a subscription made
 * with the same key), and registers it with the server. Push messages are always user-visible.
 */
export async function subscribeThisDevice(publicKey: string | null, deps: SubscribeDeps): Promise<SubscribeOutcome> {
  if (!publicKey) return { ok: false, reason: 'no_key' };
  const permission = await deps.requestPermission();
  if (permission !== 'granted') return { ok: false, reason: 'denied' };
  const reg = await deps.getRegistration();
  if (!reg) return { ok: false, reason: 'no_worker' };
  const key = urlBase64ToUint8Array(publicKey);
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe().catch(() => false);
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  const body = subscribeBody(sub.toJSON(), deps.userAgent);
  if (!body) return { ok: false, reason: 'bad_subscription' };
  const { id } = await deps.post(body);
  return { ok: true, id, endpoint: body.endpoint };
}

/** The live browser environment (guarded: any of these can be missing). */
export function browserPushEnv(hasRegistration: boolean): PushEnv {
  const nav = typeof navigator === 'undefined' ? null : navigator;
  const win = typeof window === 'undefined' ? null : window;
  let standalone = false;
  try {
    standalone = Boolean(win?.matchMedia?.('(display-mode: standalone)').matches) || Boolean((nav as { standalone?: boolean } | null)?.standalone);
  } catch {
    standalone = false;
  }
  return {
    hasPushManager: Boolean(win && 'PushManager' in win),
    hasNotification: Boolean(win && 'Notification' in win),
    hasServiceWorker: Boolean(nav && 'serviceWorker' in nav),
    workerRegistered: hasRegistration,
    permission: win && 'Notification' in win ? Notification.permission : null,
    userAgent: nav?.userAgent ?? '',
    standalone,
  };
}

/** The id the server gave this device's subscription (per-browser convenience, so the list can say "This device"). */
const THIS_DEVICE_KEY = 'yb.push.device';
export function rememberThisDevice(id: string | null): void {
  try {
    if (id) window.localStorage.setItem(THIS_DEVICE_KEY, id);
    else window.localStorage.removeItem(THIS_DEVICE_KEY);
  } catch {
    // storage blocked: the list just won't mark this device
  }
}
export function thisDeviceId(): string | null {
  try {
    return window.localStorage.getItem(THIS_DEVICE_KEY);
  } catch {
    return null;
  }
}
