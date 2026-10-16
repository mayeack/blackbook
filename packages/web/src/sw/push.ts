/**
 * Push handling for the service worker (pure parts, unit-tested in test/sw-push.test.ts).
 *
 * The lock screen only ever shows generic text: the title is always "Yeackbot", and the body is the server's only
 * when it passes a strict check (short, no links, emails or phone-like digit runs). The server adds first names only
 * when the owner turned on "First names in notifications". Anything else falls back to a fixed sentence per kind.
 * Tapping opens a same-origin app path from a short allowlist, else /today.
 */
export const NOTIFICATION_TITLE = 'Yeackbot';
export const DEFAULT_PATH = '/today';

const GENERIC: Record<string, string> = {
  digest: 'Your brief is ready.',
  weekly: 'Your weekly review is ready.',
  health: 'Something needs attention · open Sources.',
  pre_event: 'An event is coming up today.',
  test: 'Test notification · push works.',
};
const FALLBACK_BODY = 'Something new is waiting on Today.';
const KINDS = new Set(Object.keys(GENERIC));

/** App screens a notification may open (relative, same origin). */
const SAFE_PATHS = [
  /^\/today$/,
  /^\/sources$/,
  /^\/trips$/,
  /^\/settings(\/(digest|push|agent|privacy|learned|eval))?$/,
  /^\/e\/[A-Za-z0-9-]{1,64}(\/brief)?$/,
  /^\/p\/[A-Za-z0-9-]{1,64}$/,
];

/** A notification target: a safe app path, else /today. Query strings and fragments are dropped. */
export function safePath(url: unknown): string {
  if (typeof url !== 'string') return DEFAULT_PATH;
  const path = url.split(/[?#]/)[0] ?? '';
  return SAFE_PATHS.some((re) => re.test(path)) ? path : DEFAULT_PATH;
}

/** A body is shown only when it is short plain text with nothing that looks like contact data or a link. */
export function safeBody(body: unknown): string | null {
  if (typeof body !== 'string') return null;
  const b = body.replace(/\s+/g, ' ').trim();
  if (!b || b.length > 120) return null;
  if (/[@<>]|https?:|www\.|\.(com|net|org|io|app)\b/i.test(b)) return null;
  if (/\d[\d\s().-]{5,}\d/.test(b)) return null;
  return b;
}

export interface NotificationSpec {
  title: string;
  options: { body: string; tag: string; icon: string; badge: string; data: { url: string } };
}

/** What to show for a push message (`payload` = the parsed JSON, or null when there was none / it didn't parse). */
export function notificationFor(payload: unknown): NotificationSpec {
  const p = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  const kind = typeof p.kind === 'string' && KINDS.has(p.kind) ? p.kind : null;
  const body = safeBody(p.body) ?? (kind ? GENERIC[kind]! : FALLBACK_BODY);
  const tag = typeof p.tag === 'string' && /^[A-Za-z0-9:_-]{1,64}$/.test(p.tag) ? p.tag : `yb-${kind ?? 'today'}`;
  return {
    title: NOTIFICATION_TITLE,
    options: { body, tag, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', data: { url: safePath(p.url) } },
  };
}

/** Parses a push message's data without throwing (PushMessageData.json() throws on non-JSON). */
export function readPayload(data: { text(): string } | null | undefined): unknown {
  if (!data) return null;
  try {
    return JSON.parse(data.text());
  } catch {
    return null;
  }
}

export interface ResubscribeDeps {
  /** The browser's replacement subscription, if it made one. */
  newSubscription: PushSubscription | null;
  oldSubscription: PushSubscription | null;
  /** registration.pushManager.subscribe */
  subscribe: (options: PushSubscriptionOptionsInit) => Promise<PushSubscription>;
  /** POST to /api/v1/<path> with JSON (same origin, Access cookie). */
  post: (path: string, body: unknown) => Promise<boolean>;
}

/**
 * pushsubscriptionchange: the push service rotated or expired the subscription. Re-subscribe with the same key and
 * tell the server (the server drops dead endpoints on 404/410 by itself). Best effort; returns whether it registered.
 */
export async function resubscribe(d: ResubscribeDeps): Promise<boolean> {
  let sub = d.newSubscription;
  if (!sub) {
    const key = d.oldSubscription?.options.applicationServerKey;
    if (!key) return false;
    try {
      sub = await d.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    } catch {
      return false;
    }
  }
  const json = sub.toJSON();
  if (!json.endpoint?.startsWith('https://') || !json.keys?.p256dh || !json.keys.auth) return false;
  const ok = await d.post('/push/subscribe', {
    endpoint: json.endpoint,
    expirationTime: json.expirationTime ?? null,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
  });
  const old = d.oldSubscription?.endpoint;
  if (ok && old && old !== json.endpoint) await d.post('/push/unsubscribe', { endpoint: old });
  return ok;
}
