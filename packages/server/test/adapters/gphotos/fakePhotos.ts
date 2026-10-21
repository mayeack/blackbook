/**
 * In-memory Google Photos Picker (OAuth token endpoint, sessions.create/get/delete, mediaItems.list and the
 * lh3.googleusercontent.com media bytes) behind an undici MockAgent with net connect disabled: nothing reaches the
 * network. Bearer tokens are checked on every Picker and media call. Synthetic data only: base URLs are short and
 * low-entropy (`https://lh3.googleusercontent.com/test-1`), images are tiny placeholder buffers.
 */
import { MockAgent, fetch as undiciFetch } from 'undici';
import { PHOTOS_PICKER_SCOPE, type FetchLike } from '../../../src/adapters/calendar/google';

export const CLIENT = {
  clientId: 'test-client-id.apps.example',
  clientSecret: 'test-client-secret',
  redirectUri: 'https://yeackbot.example/api/v1/google/callback',
};
export const REFRESH = 'test-photos-refresh-1';
export const T0 = Date.UTC(2026, 9, 21, 18, 0, 0);
export const MEDIA_HOST = 'https://lh3.googleusercontent.com';

export interface Call {
  method: string;
  host: string;
  path: string;
  query: URLSearchParams;
  body: string;
}

export interface FakeItem {
  id: string;
  type?: 'PHOTO' | 'VIDEO' | 'TYPE_UNSPECIFIED';
  createTime?: string;
  /** Path on the media host (base URL = MEDIA_HOST + path); defaults to /test-<n>. */
  path?: string;
  mimeType?: string;
  /** A base URL on another host (to test the allowlist). */
  baseUrl?: string;
}

export interface FakeMedia {
  status?: number;
  body?: Buffer;
  contentType?: string;
  /** A 302 to this location. */
  redirectTo?: string;
  /** Only for this size suffix ('w1280-h1280' / 'w960-h960'); default any. */
  size?: string;
}

interface FakeSession {
  id: string;
  mediaItemsSet: boolean;
  items: FakeItem[];
  deleted: boolean;
  pollInterval: string;
  timeoutIn: string;
  expireTime: string;
  body: unknown;
}

const json = (statusCode: number, data: unknown) => ({
  statusCode,
  data: JSON.stringify(data),
  responseOptions: { headers: { 'content-type': 'application/json' } },
});
const apiError = (code: number, status: string, message = 'error') => json(code, { error: { code, message, status } });

const headerValue = (headers: unknown, name: string): string | undefined => {
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (Array.isArray(headers)) {
    for (let i = 0; i < headers.length; i += 2) if (String(headers[i]).toLowerCase() === name) return String(headers[i + 1]);
    return undefined;
  }
  const rec = headers as Record<string, string | string[]>;
  const key = Object.keys(rec).find((k) => k.toLowerCase() === name);
  const v = key ? rec[key] : undefined;
  return Array.isArray(v) ? v[0] : v;
};

/** A small placeholder "image": the OCR fake keys its synthetic lines on this text. */
export const fakeImage = (scenario: string): Buffer => Buffer.from(`fakeimg:${scenario}`);

export class FakePhotos {
  readonly agent = new MockAgent();
  readonly calls: Call[] = [];
  readonly sessions = new Map<string, FakeSession>();
  /** media path → response(s). */
  readonly media = new Map<string, FakeMedia[]>();
  readonly refreshTokens = new Set<string>([REFRESH]);
  pageSize = 100;
  /** Picker path → a raw JSON body answered with 200 instead of the simulated API (malformed responses). */
  readonly overrides = new Map<string, unknown>();
  /** Every Picker call answers this status (e.g. 403) while set. */
  failAll: { status: number; reason: string } | null = null;
  private readonly accessTokens = new Set<string>();
  private issued = 0;
  private nextSession = 0;

  constructor(private readonly clock: () => number = () => T0) {
    this.agent.disableNetConnect();
    this.agent
      .get('https://oauth2.googleapis.com')
      .intercept({ path: () => true, method: 'POST' })
      .reply((o) => this.oauth(o.path, String(o.body ?? '')))
      .persist();
    this.agent
      .get('https://photospicker.googleapis.com')
      .intercept({ path: () => true, method: /^(GET|POST|DELETE)$/ })
      .reply((o) => this.picker(o.method, o.path, headerValue(o.headers, 'authorization'), String(o.body ?? '')))
      .persist();
    this.agent
      .get(MEDIA_HOST)
      .intercept({ path: () => true, method: 'GET' })
      .reply((o) => this.download(o.path, headerValue(o.headers, 'authorization')))
      .persist();
  }

  readonly fetch: FetchLike = (input, init) =>
    undiciFetch(input as URL, { ...(init as object), dispatcher: this.agent } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;

  async close(): Promise<void> {
    await this.agent.close();
  }

  callsTo(method: string, path: RegExp): Call[] {
    return this.calls.filter((c) => c.method === method && path.test(c.path));
  }

  // ------------------------------------------------------------------------------------------ setup

  /** The owner picks these items in a session (mediaItemsSet becomes true). */
  pick(sessionId: string, items: FakeItem[]): void {
    const s = this.sessions.get(sessionId)!;
    s.items = items.map((it, i) => ({ type: 'PHOTO', path: `/test-${sessionId}-${i + 1}`, mimeType: 'image/jpeg', createTime: '2026-10-20T21:00:00Z', ...it }));
    s.mediaItemsSet = true;
  }

  /** Media bytes served for an item's path. */
  serve(path: string, ...responses: FakeMedia[]): void {
    this.media.set(path, responses);
  }

  baseUrlOf(item: FakeItem): string {
    return item.baseUrl ?? `${MEDIA_HOST}${item.path}`;
  }

  // ------------------------------------------------------------------------------------------ handlers

  private record(method: string, host: string, url: URL, body: string): void {
    this.calls.push({ method, host, path: url.pathname, query: url.searchParams, body });
  }

  private authorized(authorization: string | undefined): boolean {
    const bearer = authorization?.replace(/^Bearer /, '');
    return !!bearer && this.accessTokens.has(bearer);
  }

  private oauth(path: string, rawBody: string) {
    const url = new URL(path, 'https://oauth2.googleapis.com');
    this.record('POST', 'oauth2.googleapis.com', url, '');
    const body = new URLSearchParams(rawBody);
    if (url.pathname !== '/token') return json(404, { error: 'not_found' });
    if (body.get('client_id') !== CLIENT.clientId || body.get('client_secret') !== CLIENT.clientSecret) return json(401, { error: 'invalid_client' });
    if (body.get('grant_type') !== 'refresh_token') return json(400, { error: 'unsupported_grant_type' });
    if (!this.refreshTokens.has(body.get('refresh_token') ?? '')) {
      return json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
    }
    const t = `test-access-${++this.issued}`;
    this.accessTokens.add(t);
    return json(200, { access_token: t, expires_in: 3599, token_type: 'Bearer', scope: PHOTOS_PICKER_SCOPE });
  }

  private sessionJson(s: FakeSession) {
    return {
      id: s.id,
      pickerUri: `https://photos.google.com/picker/${s.id}`,
      pollingConfig: { pollInterval: s.pollInterval, timeoutIn: s.timeoutIn },
      expireTime: s.expireTime,
      mediaItemsSet: s.mediaItemsSet,
    };
  }

  private picker(method: string, path: string, authorization: string | undefined, body: string) {
    const url = new URL(path, 'https://photospicker.googleapis.com');
    this.record(method, 'photospicker.googleapis.com', url, body);
    if (!this.authorized(authorization)) return apiError(401, 'UNAUTHENTICATED', 'Request had invalid authentication credentials.');
    if (this.failAll) return apiError(this.failAll.status, this.failAll.reason);
    if (this.overrides.has(url.pathname)) return json(200, this.overrides.get(url.pathname));
    if (method === 'POST' && url.pathname === '/v1/sessions') {
      const id = `sess-${++this.nextSession}`;
      const s: FakeSession = {
        id,
        mediaItemsSet: false,
        items: [],
        deleted: false,
        pollInterval: '5s',
        timeoutIn: '1800s',
        expireTime: new Date(this.clock() + 3_600_000).toISOString(),
        body: body ? JSON.parse(body) : null,
      };
      this.sessions.set(id, s);
      return json(200, this.sessionJson(s));
    }
    const m = /^\/v1\/sessions\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
    if (m) {
      const s = this.sessions.get(m[1]!);
      if (!s || s.deleted) return apiError(404, 'NOT_FOUND', 'Session not found.');
      if (method === 'GET') return json(200, this.sessionJson(s));
      if (method === 'DELETE') {
        s.deleted = true;
        return json(200, {});
      }
    }
    if (method === 'GET' && url.pathname === '/v1/mediaItems') {
      const s = this.sessions.get(url.searchParams.get('sessionId') ?? '');
      if (!s || s.deleted) return apiError(404, 'NOT_FOUND', 'Session not found.');
      if (!s.mediaItemsSet) return apiError(400, 'FAILED_PRECONDITION', 'The user has not finished picking.');
      const size = Math.min(Number(url.searchParams.get('pageSize') ?? 50), this.pageSize);
      const offset = Number(url.searchParams.get('pageToken')?.replace(/^page-/, '') ?? 0);
      const page = s.items.slice(offset, offset + size).map((it) => ({
        id: it.id,
        createTime: it.createTime,
        type: it.type,
        mediaFile: { baseUrl: this.baseUrlOf(it), mimeType: it.mimeType, filename: 'IMG_0001.PNG', mediaFileMetadata: { width: 1170, height: 2532 } },
      }));
      const more = offset + size < s.items.length;
      return json(200, { mediaItems: page, ...(more ? { nextPageToken: `page-${offset + size}` } : {}) });
    }
    return apiError(404, 'NOT_FOUND');
  }

  private download(path: string, authorization: string | undefined) {
    const url = new URL(path, MEDIA_HOST);
    this.record('GET', 'lh3.googleusercontent.com', url, '');
    if (!this.authorized(authorization)) return { statusCode: 401, data: 'unauthorized' };
    const [base, size = ''] = url.pathname.split('=');
    const options = this.media.get(base!) ?? [];
    const r = options.find((o) => !o.size || o.size === size);
    if (!r) return { statusCode: 404, data: 'not found' };
    if (r.redirectTo) return { statusCode: 302, data: '', responseOptions: { headers: { location: r.redirectTo } } };
    return {
      statusCode: r.status ?? 200,
      data: r.body ?? Buffer.alloc(0),
      responseOptions: { headers: { 'content-type': r.contentType ?? 'image/jpeg' } },
    };
  }
}
