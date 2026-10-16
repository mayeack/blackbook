/**
 * API client: relative URLs only (same origin, no CORS). Mutations send JSON plus `X-YB: 1` (the server's CSRF
 * check). Requests never follow redirects: behind Cloudflare Access an expired session answers with a redirect
 * to the login page (or Access's own HTML), which a fetch can't complete, so the client does a top-level
 * navigation to "/" and Access signs the user in again.
 */
import type { ApiError as ApiErrorBody } from '@yb/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const isApiError = (e: unknown): e is ApiError => e instanceof ApiError;

const BASE = '/api/v1';
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const isJson = (res: Response) => (res.headers.get('content-type') ?? '').toLowerCase().includes('json');

/**
 * Cloudflare Access bouncing a request to its login: a redirect (opaque with `redirect: 'manual'`), or an HTML
 * page / non-JSON 401-403 where our server would have answered JSON.
 */
export function isAccessBounce(res: Response): boolean {
  if (res.type === 'opaqueredirect' || res.type === 'opaque' || res.redirected) return true;
  if (res.status >= 300 && res.status < 400) return true;
  if (isJson(res)) return false;
  return res.ok || res.status === 401 || res.status === 403;
}

export interface ClientEnv {
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  /** Top-level navigation to "/" so Access can sign the user in again. */
  relogin: () => void;
}

export function createClient(env: ClientEnv) {
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const mutating = MUTATING.has(method);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (mutating) {
      headers['Content-Type'] = 'application/json';
      headers['X-YB'] = '1';
    }
    let res: Response;
    try {
      res = await env.fetch(BASE + path, {
        method,
        headers,
        body: mutating ? JSON.stringify(body ?? {}) : undefined,
        credentials: 'same-origin',
        redirect: 'manual',
        cache: 'no-store',
      });
    } catch {
      throw new ApiError(0, 'NETWORK', 'Cannot reach yeackbot. Check your connection.');
    }
    if (isAccessBounce(res)) {
      env.relogin();
      throw new ApiError(401, 'SESSION_EXPIRED', 'Your session expired. Signing you in again…');
    }
    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      throw res.status >= 500
        ? new ApiError(res.status, 'UNAVAILABLE', 'yeackbot is not responding right now. Try again in a minute.')
        : new ApiError(res.status, 'BAD_RESPONSE', 'The server sent an unexpected response.');
    }
    if (!res.ok) {
      const err = (data as ApiErrorBody | undefined)?.error;
      // Our own 401 means no Access token reached the server: same remedy. A 403 (wrong account) would loop.
      if (res.status === 401) env.relogin();
      throw new ApiError(res.status, err?.code ?? `HTTP_${res.status}`, err?.message ?? (res.statusText || 'Request failed.'), err?.details);
    }
    return data as T;
  }

  return {
    get: <T>(path: string) => request<T>('GET', path),
    post: <T>(path: string, body: unknown = {}) => request<T>('POST', path, body),
    put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
    patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
    del: <T>(path: string) => request<T>('DELETE', path),
  };
}

export type ApiClient = ReturnType<typeof createClient>;

const RELOGIN_KEY = 'yb.relogin-at';
const RELOGIN_GAP_MS = 30_000;

interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Navigates to "/" at most once per 30 s (per tab), so a misconfigured Access app can't reload-loop the page.
 * Returns whether it navigated.
 */
export function reloginOnce(nav: { assign(url: string): void }, store: KeyValueStore | null, now = Date.now()): boolean {
  try {
    const last = Number(store?.getItem(RELOGIN_KEY) ?? 0);
    if (now - last < RELOGIN_GAP_MS) return false;
    store?.setItem(RELOGIN_KEY, String(now));
  } catch {
    // storage blocked (private mode): navigate anyway
  }
  nav.assign('/');
  return true;
}

const sessionStore = (): KeyValueStore | null => {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
};

export const api = createClient({
  fetch: (input, init) => globalThis.fetch(input, init),
  relogin: () => void reloginOnce(window.location, sessionStore()),
});

export const qs = (params: Record<string, string | number | null | undefined>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') s.set(k, String(v));
  const out = s.toString();
  return out ? `?${out}` : '';
};
