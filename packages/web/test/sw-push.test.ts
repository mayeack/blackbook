import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { notificationFor, readPayload, resubscribe, safeBody, safePath } from '../src/sw/push';

// Nothing in these tests may reach the network.
beforeAll(() => {
  vi.stubGlobal('fetch', () => Promise.reject(new Error('network disabled in tests')));
});
afterAll(() => {
  vi.unstubAllGlobals();
});

describe('service worker push notifications', () => {
  it('always titles “Yeackbot” and opens Today by default', () => {
    const n = notificationFor(null);
    expect(n.title).toBe('Yeackbot');
    expect(n.options.body).toBe('Something new is waiting on Today.');
    expect(n.options.data.url).toBe('/today');
    expect(n.options.tag).toBe('yb-today');
  });

  it('shows the server’s generic body and allowlisted path', () => {
    const n = notificationFor({ kind: 'digest', title: 'ignored', body: 'Your brief is ready · 4 things today', url: '/today', tag: 'digest:2026-10-14' });
    expect(n).toMatchObject({ title: 'Yeackbot', options: { body: 'Your brief is ready · 4 things today', tag: 'digest:2026-10-14', data: { url: '/today' } } });
    expect(notificationFor({ kind: 'health', body: 'Instagram needs attention · open Sources', url: '/sources' }).options.data.url).toBe('/sources');
  });

  it('falls back to fixed text when a body looks like contact data or a link', () => {
    for (const body of ['Call 555-0123 back', 'ping sam@example.com', 'see https://example.com', 'go to www.example.org', '<b>hi</b>', 'x'.repeat(200)]) {
      expect(notificationFor({ kind: 'digest', body }).options.body).toBe('Your brief is ready.');
    }
    expect(notificationFor({ kind: 'nope', body: 42 }).options.body).toBe('Something new is waiting on Today.');
    expect(safeBody('Event at 8:00 · Oct 14')).toBe('Event at 8:00 · Oct 14');
  });

  it('never opens anything outside the app', () => {
    expect(safePath('https://example.com/today')).toBe('/today');
    expect(safePath('//example.com/today')).toBe('/today');
    expect(safePath('/api/v1/push/test')).toBe('/today');
    expect(safePath('/e/0190aa00-0000-7000-8000-000000000001/brief?x=1')).toBe('/e/0190aa00-0000-7000-8000-000000000001/brief');
    expect(safePath('/settings/push')).toBe('/settings/push');
    expect(safePath(undefined)).toBe('/today');
    expect(notificationFor({ kind: 'test', tag: 'bad tag!' }).options.tag).toBe('yb-test');
  });

  it('reads payloads without throwing', () => {
    expect(readPayload({ text: () => '{"kind":"test"}' })).toEqual({ kind: 'test' });
    expect(readPayload({ text: () => 'not json' })).toBeNull();
    expect(readPayload(null)).toBeNull();
  });
});

describe('pushsubscriptionchange', () => {
  const sub = (endpoint: string, key: ArrayBuffer | null = new Uint8Array([1, 2]).buffer) =>
    ({
      endpoint,
      options: { applicationServerKey: key, userVisibleOnly: true },
      toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh: 'pk', auth: 'au' } }),
    }) as unknown as PushSubscription;

  it('registers the browser’s new subscription and drops the old endpoint', async () => {
    const post = vi.fn(async () => true);
    const ok = await resubscribe({ newSubscription: sub('https://push.example.com/new'), oldSubscription: sub('https://push.example.com/old'), subscribe: vi.fn(), post });
    expect(ok).toBe(true);
    expect(post.mock.calls).toEqual([
      ['/push/subscribe', { endpoint: 'https://push.example.com/new', expirationTime: null, keys: { p256dh: 'pk', auth: 'au' } }],
      ['/push/unsubscribe', { endpoint: 'https://push.example.com/old' }],
    ]);
  });

  it('re-subscribes with the old key when the browser gave none', async () => {
    const subscribe = vi.fn(async () => sub('https://push.example.com/again'));
    const post = vi.fn(async () => true);
    expect(await resubscribe({ newSubscription: null, oldSubscription: sub('https://push.example.com/old'), subscribe, post })).toBe(true);
    expect(subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: new Uint8Array([1, 2]).buffer });
  });

  it('gives up quietly without a key, on a failed subscribe, or a non-https endpoint', async () => {
    const post = vi.fn(async () => true);
    expect(await resubscribe({ newSubscription: null, oldSubscription: null, subscribe: vi.fn(), post })).toBe(false);
    const failing = vi.fn(async () => {
      throw new Error('denied');
    });
    expect(await resubscribe({ newSubscription: null, oldSubscription: sub('https://push.example.com/old'), subscribe: failing, post })).toBe(false);
    expect(await resubscribe({ newSubscription: sub('http://push.example.com/x'), oldSubscription: null, subscribe: vi.fn(), post })).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });
});
