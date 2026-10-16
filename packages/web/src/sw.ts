/**
 * Service worker (vite-plugin-pwa injectManifest → /sw.js). Precaches the hashed build assets only; page
 * navigations are network-first through sw/navigation.ts; push shows generic text and opens Today.
 * Typed against the DOM lib with the few worker-scope shapes declared here (the WebWorker lib can't share a
 * program with DOM).
 */
import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching';
import { handleNavigation, isAccessPath, OFFLINE_HTML, SHELL_CACHE, SHELL_KEY, shouldHandle } from './sw/navigation';

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
  addEventListener(type: 'install' | 'activate' | 'push', fn: (e: ExtendableEvent) => void): void;
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

// Generic text only: the payload is ignored, so nothing personal can reach the lock screen.
self.addEventListener('push', (event) => {
  event.waitUntil(
    self.registration.showNotification('yeackbot', {
      body: 'Something new is waiting on Today.',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: 'yb-today',
      data: { url: '/today' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(openToday());
});

async function openToday(): Promise<void> {
  const target = new URL('/today', self.location.origin).href;
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
  if (!open) {
    await self.clients.openWindow(target);
    return;
  }
  await open.focus();
  await open.navigate(target).catch(() => undefined);
}
