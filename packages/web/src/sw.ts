/**
 * Service worker (vite-plugin-pwa injectManifest → /sw.js). Precaches the hashed build assets only; page
 * navigations are network-first through sw/navigation.ts; push (sw/push.ts) shows generic text and opens Today
 * (or another allowlisted app path); a rotated push subscription is re-registered.
 * Typed against the DOM lib with the few worker-scope shapes declared here (the WebWorker lib can't share a
 * program with DOM).
 */
import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching';
import { handleNavigation, isAccessPath, OFFLINE_HTML, SHELL_CACHE, SHELL_KEY, shouldHandle } from './sw/navigation';
import { DEFAULT_PATH, notificationFor, readPayload, resubscribe, safePath } from './sw/push';

interface ExtendableEvent extends Event {
  waitUntil(p: Promise<unknown>): void;
}
interface FetchEvent extends ExtendableEvent {
  readonly request: Request;
  respondWith(r: Response | Promise<Response>): void;
}
interface NotificationEvent extends ExtendableEvent {
  readonly notification: Notification;
}
interface PushEvent extends ExtendableEvent {
  readonly data: { text(): string } | null;
}
interface PushSubscriptionChangeEvent extends ExtendableEvent {
  readonly newSubscription: PushSubscription | null;
  readonly oldSubscription: PushSubscription | null;
}
interface WindowClientLike {
  readonly url: string;
  focus(): Promise<unknown>;
  navigate(url: string): Promise<unknown>;
}
interface WorkerScope {
  readonly location: { readonly origin: string };
  readonly registration: ServiceWorkerRegistration;
  readonly clients: {
    matchAll(o: { type: 'window'; includeUncontrolled: boolean }): Promise<readonly WindowClientLike[]>;
    openWindow(url: string): Promise<unknown>;
    claim(): Promise<void>;
  };
  skipWaiting(): Promise<void>;
  addEventListener(type: 'install' | 'activate', fn: (e: ExtendableEvent) => void): void;
  addEventListener(type: 'push', fn: (e: PushEvent) => void): void;
  addEventListener(type: 'pushsubscriptionchange', fn: (e: PushSubscriptionChangeEvent) => void): void;
  addEventListener(type: 'fetch', fn: (e: FetchEvent) => void): void;
  addEventListener(type: 'notificationclick', fn: (e: NotificationEvent) => void): void;
  __WB_MANIFEST: Array<string | { url: string; revision: string | null }>;
}
declare const self: WorkerScope;

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// Hashed assets + network-first pages make an immediate takeover safe.
self.addEventListener('install', () => void self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

const shellStore = async () => {
  const cache = await caches.open(SHELL_CACHE);
  return {
    match: (key: string) => cache.match(key),
    put: (key: string, res: Response) => cache.put(key, res),
    delete: (key: string) => cache.delete(key),
  };
};

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.mode === 'navigate' && url.origin === self.location.origin && isAccessPath(url.pathname)) {
    // Signing out through Access: drop the shell before the request goes out.
    event.waitUntil(caches.open(SHELL_CACHE).then((c) => c.delete(SHELL_KEY)));
    return;
  }
  if (!shouldHandle(url, self.location.origin, req.mode, req.method)) return;
  event.respondWith(
    handleNavigation(req, {
      fetch: (r) => fetch(r),
      store: shellStore,
      offline: () => new Response(OFFLINE_HTML, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
    }),
  );
});

// Generic text only (sw/push.ts): a fixed title, the server's body only when it passes a strict check, else a
// fixed sentence per kind. Every push shows a notification (userVisibleOnly).
self.addEventListener('push', (event) => {
  const n = notificationFor(readPayload(event.data));
  event.waitUntil(self.registration.showNotification(n.title, n.options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data as { url?: unknown } | null;
  event.waitUntil(openPath(safePath(data?.url)));
});

// The push service rotated or expired the subscription: subscribe again with the same key and tell the server.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    resubscribe({
      newSubscription: event.newSubscription ?? null,
      oldSubscription: event.oldSubscription ?? null,
      subscribe: (o) => self.registration.pushManager.subscribe(o),
      post: async (path, body) => {
        try {
          const res = await fetch(`/api/v1${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-YB': '1' },
            body: JSON.stringify(body),
            credentials: 'same-origin',
            redirect: 'manual',
            cache: 'no-store',
          });
          return res.ok;
        } catch {
          return false;
        }
      },
    }).then(() => undefined),
  );
});

/** Focuses an open yeackbot window and navigates it to `path` (else opens one). */
async function openPath(path: string = DEFAULT_PATH): Promise<void> {
  const target = new URL(path, self.location.origin).href;
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
  if (!open) {
    await self.clients.openWindow(target);
    return;
  }
  await open.focus();
  await open.navigate(target).catch(() => undefined);
}
