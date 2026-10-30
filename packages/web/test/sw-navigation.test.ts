import { describe, expect, it, vi } from 'vitest';
import { handleNavigation, SHELL_KEY, shouldHandle, type ShellStore } from '../src/sw/navigation';

const res = (o: { status?: number; type?: ResponseType; contentType?: string; tag?: string }): Response => {
  const status = o.status ?? 200;
  const r = {
    status,
    ok: status >= 200 && status < 300,
    type: o.type ?? 'basic',
    headers: new Headers(o.contentType ? { 'content-type': o.contentType } : {}),
    tag: o.tag,
    clone: () => ({ ...r, cloned: true }),
  };
  return r as unknown as Response;
};

function memStore(initial?: Response) {
  const m = new Map<string, Response>(initial ? [[SHELL_KEY, initial]] : []);
  const store: ShellStore = {
    match: async (k) => m.get(k),
    put: async (k, v) => void m.set(k, v),
    delete: async (k) => m.delete(k),
  };
  return { m, store };
}

const req = {} as Request;
const offline = () => res({ status: 503, tag: 'offline' });

describe('service worker navigations', () => {
  it('network first: a good HTML shell is returned and kept for offline use', async () => {
    const { m, store } = memStore();
    const page = res({ contentType: 'text/html; charset=utf-8', tag: 'net' });
    const out = await handleNavigation(req, { fetch: async () => page, store: async () => store, offline });
    expect(out).toBe(page);
    expect(m.get(SHELL_KEY)).toMatchObject({ cloned: true });
  });

  it('passes an Access redirect through and forgets the cached shell (signed out)', async () => {
    const { m, store } = memStore(res({ tag: 'old-shell' }));
    const bounce = res({ status: 0, type: 'opaqueredirect' });
    const out = await handleNavigation(req, { fetch: async () => bounce, store: async () => store, offline });
    expect(out).toBe(bounce);
    expect(m.has(SHELL_KEY)).toBe(false);
  });

  it('forgets the shell on 401/403 too', async () => {
    for (const status of [401, 403]) {
      const { m, store } = memStore(res({ tag: 'old-shell' }));
      await handleNavigation(req, { fetch: async () => res({ status, contentType: 'text/html' }), store: async () => store, offline });
      expect(m.has(SHELL_KEY)).toBe(false);
    }
  });

  it('offline: serves the last shell, or the offline page when there is none', async () => {
    const shell = res({ tag: 'old-shell' });
    const fail = async () => {
      throw new TypeError('offline');
    };
    const a = memStore(shell);
    expect(await handleNavigation(req, { fetch: fail, store: async () => a.store, offline })).toBe(shell);
    const b = memStore();
    expect(await handleNavigation(req, { fetch: fail, store: async () => b.store, offline })).toMatchObject({ tag: 'offline' });
  });

  it('never caches non-HTML, errors or opaque responses as the shell', async () => {
    for (const r of [res({ contentType: 'application/json' }), res({ status: 500, contentType: 'text/html' }), res({ type: 'cors', contentType: 'text/html' })]) {
      const { m, store } = memStore();
      const put = vi.spyOn(store, 'put');
      await handleNavigation(req, { fetch: async () => r, store: async () => store, offline });
      expect(put).not.toHaveBeenCalled();
      expect(m.size).toBe(0);
    }
  });

  it('handles only same-origin page navigations outside /api, /healthz and Access endpoints', () => {
    const o = 'https://app.example.com';
    const u = (p: string) => new URL(p, o);
    expect(shouldHandle(u('/people'), o, 'navigate', 'GET')).toBe(true);
    expect(shouldHandle(u('/p/abc?tab=timeline'), o, 'navigate', 'GET')).toBe(true);
    expect(shouldHandle(u('/api/v1/me'), o, 'navigate', 'GET')).toBe(false);
    expect(shouldHandle(u('/healthz'), o, 'navigate', 'GET')).toBe(false);
    expect(shouldHandle(u('/go/Abc123xyz9'), o, 'navigate', 'GET')).toBe(false); // event-picks ticket redirect
    expect(shouldHandle(u('/cdn-cgi/access/logout'), o, 'navigate', 'GET')).toBe(false);
    expect(shouldHandle(u('/people'), o, 'cors', 'GET')).toBe(false);
    expect(shouldHandle(u('/people'), o, 'navigate', 'POST')).toBe(false);
    expect(shouldHandle(new URL('https://other.example.com/'), o, 'navigate', 'GET')).toBe(false);
  });
});
