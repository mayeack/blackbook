import { describe, expect, it, vi } from 'vitest';
import { ApiError, createClient, isAccessBounce, qs, reloginOnce } from '../src/api/client';

/** Response-like object for the cases `new Response()` can't build (opaque redirects, type 'basic'). */
const fake = (o: { status?: number; type?: ResponseType; body?: string; contentType?: string; redirected?: boolean }): Response => {
  const status = o.status ?? 200;
  return {
    status,
    ok: status >= 200 && status < 300,
    type: o.type ?? 'basic',
    redirected: o.redirected ?? false,
    statusText: '',
    headers: new Headers(o.contentType ? { 'content-type': o.contentType } : {}),
    text: async () => o.body ?? '',
  } as unknown as Response;
};
const json = (status: number, body: unknown) => fake({ status, body: JSON.stringify(body), contentType: 'application/json; charset=utf-8' });

function setup(res: Response | (() => Promise<Response>)) {
  const fetch = vi.fn<(input: string, init: RequestInit) => Promise<Response>>(async () => (typeof res === 'function' ? res() : res));
  const relogin = vi.fn();
  return { client: createClient({ fetch, relogin }), fetch, relogin };
}

describe('api client', () => {
  it('GETs relative /api/v1 URLs without following redirects or caching', async () => {
    const { client, fetch } = setup(json(200, { ok: 1 }));
    expect(await client.get('/people?q=a')).toEqual({ ok: 1 });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('/api/v1/people?q=a');
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', credentials: 'same-origin', cache: 'no-store' });
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>)['X-YB']).toBeUndefined();
  });

  it('sends JSON and X-YB: 1 on mutations (an empty object when there is no body)', async () => {
    const { client, fetch } = setup(json(200, { dryRun: true }));
    await client.post('/activity/x/undo');
    const [, init] = fetch.mock.calls[0]!;
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json', 'X-YB': '1' });
    expect(init.body).toBe('{}');
    await client.post('/runs/y/undo', { cascade: true });
    expect(fetch.mock.calls[1]![1].body).toBe('{"cascade":true}');
  });

  it('turns an Access redirect (opaque) into a re-login', async () => {
    const { client, relogin } = setup(fake({ status: 0, type: 'opaqueredirect' }));
    await expect(client.get('/me')).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    expect(relogin).toHaveBeenCalledOnce();
  });

  it('treats an HTML page where JSON was expected as the Access login', async () => {
    const { client, relogin } = setup(fake({ status: 200, body: '<html>sign in</html>', contentType: 'text/html' }));
    await expect(client.get('/people')).rejects.toBeInstanceOf(ApiError);
    expect(relogin).toHaveBeenCalledOnce();
  });

  it('re-logs in on our own 401, but not on a 403 (wrong account) or a 404', async () => {
    const a = setup(json(401, { error: { code: 'AUTH_REQUIRED', message: 'Sign in through Cloudflare Access.' } }));
    await expect(a.client.get('/me')).rejects.toMatchObject({ status: 401, code: 'AUTH_REQUIRED' });
    expect(a.relogin).toHaveBeenCalledOnce();
    const b = setup(json(403, { error: { code: 'ACCESS_DENIED', message: 'Access denied.' } }));
    await expect(b.client.get('/me')).rejects.toMatchObject({ status: 403, code: 'ACCESS_DENIED' });
    expect(b.relogin).not.toHaveBeenCalled();
    const c = setup(json(404, { error: { code: 'NOT_FOUND', message: 'Person not found' } }));
    await expect(c.client.get('/people/x')).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND', message: 'Person not found' });
    expect(c.relogin).not.toHaveBeenCalled();
  });

  it('reports network failures and non-JSON 5xx without re-login', async () => {
    const a = setup(() => Promise.reject(new TypeError('Failed to fetch')));
    await expect(a.client.get('/me')).rejects.toMatchObject({ status: 0, code: 'NETWORK' });
    const b = setup(fake({ status: 502, body: '<html>Bad gateway</html>', contentType: 'text/html' }));
    await expect(b.client.get('/me')).rejects.toMatchObject({ status: 502, code: 'UNAVAILABLE' });
    expect(a.relogin).not.toHaveBeenCalled();
    expect(b.relogin).not.toHaveBeenCalled();
  });

  it('isAccessBounce: JSON answers are never a bounce', () => {
    expect(isAccessBounce(json(200, {}))).toBe(false);
    expect(isAccessBounce(json(401, {}))).toBe(false);
    expect(isAccessBounce(fake({ status: 302 }))).toBe(true);
    expect(isAccessBounce(fake({ status: 200, redirected: true, contentType: 'application/json' }))).toBe(true);
    expect(isAccessBounce(fake({ status: 403, contentType: 'text/html' }))).toBe(true);
  });
});

describe('reloginOnce', () => {
  const store = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  };

  it('navigates to "/" at most once per 30 s', () => {
    const nav = { assign: vi.fn() };
    const s = store();
    expect(reloginOnce(nav, s, 1_000_000)).toBe(true);
    expect(reloginOnce(nav, s, 1_010_000)).toBe(false);
    expect(reloginOnce(nav, s, 1_031_000)).toBe(true);
    expect(nav.assign).toHaveBeenCalledTimes(2);
    expect(nav.assign).toHaveBeenCalledWith('/');
  });

  it('still navigates when storage is unavailable', () => {
    const nav = { assign: vi.fn() };
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => undefined,
    };
    expect(reloginOnce(nav, broken)).toBe(true);
    expect(reloginOnce(nav, null)).toBe(true);
  });
});

describe('qs', () => {
  it('drops empty values', () => {
    expect(qs({ q: 'a b', sort: 'last', cursor: null, x: '' })).toBe('?q=a+b&sort=last');
    expect(qs({})).toBe('');
  });
});
