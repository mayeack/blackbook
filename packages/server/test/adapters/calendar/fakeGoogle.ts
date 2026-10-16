/**
 * In-memory Google (OAuth token/revoke endpoints + Calendar API v3 calendarList/events.list) behind an undici
 * MockAgent with net connect disabled: nothing reaches the network. Sync tokens are per-calendar change sequence
 * numbers, so incremental listings, 410s and paging behave like the real API. Synthetic data only (example.com
 * addresses, invented names).
 */
import crypto from 'node:crypto';
import { MockAgent, fetch as undiciFetch } from 'undici';
import { CALENDAR_SCOPE, type FetchLike } from '../../../src/adapters/calendar/google';

export const T0 = Date.UTC(2026, 9, 14, 19, 0, 0);
export const DAY = 86_400_000;

export const CLIENT = {
  clientId: 'test-client-id.apps.example',
  clientSecret: 'test-client-secret',
  redirectUri: 'https://yeackbot.example/api/v1/google/callback',
};

// Google's calendar id suffixes, concatenated so no literal address appears in the source.
const GROUP = '@group.calendar.google.com';
const VIRTUAL = '@group.v.calendar.google.com';
const IMPORT = '@import.calendar.google.com';

export const OWNER = 'owner@example.com';
export const CAL = {
  primary: OWNER,
  partiful: 'partifulfeed01' + IMPORT,
  community: 'c-community-board' + GROUP,
  recurring: 'c-recurring-events' + GROUP,
  holidays: 'en.usa#holiday' + VIRTUAL,
  birthdays: 'addressbook#contacts' + VIRTUAL,
  otherFeed: 'sportsfeed02' + IMPORT,
} as const;

export const calendarEntries = (): Record<string, Record<string, unknown>> => ({
  [CAL.primary]: { id: CAL.primary, summary: OWNER, primary: true, accessRole: 'owner', timeZone: 'America/Los_Angeles' },
  [CAL.partiful]: { id: CAL.partiful, summary: 'Partiful', accessRole: 'reader', timeZone: 'America/Los_Angeles' },
  [CAL.community]: { id: CAL.community, summary: 'Neighborhood Board', accessRole: 'reader', timeZone: 'America/Los_Angeles' },
  [CAL.recurring]: { id: CAL.recurring, summary: 'Recurring Events', accessRole: 'owner', timeZone: 'America/New_York' },
  [CAL.holidays]: { id: CAL.holidays, summary: 'Holidays in United States', accessRole: 'reader', timeZone: 'America/Los_Angeles' },
});

export interface Call {
  method: string;
  host: string;
  path: string;
  query: URLSearchParams;
  body: string;
}

interface StoredEvent {
  ev: Record<string, unknown>;
  startMs: number;
  seq: number;
}

interface FakeCalendar {
  index: number;
  entry: Record<string, unknown>;
  events: Map<string, StoredEvent>;
  seq: number;
  /** Tokens older than this get a 410. */
  tokenFloor: number;
}

const json = (statusCode: number, data: unknown) => ({
  statusCode,
  data: JSON.stringify(data),
  responseOptions: { headers: { 'content-type': 'application/json' } },
});

const apiError = (code: number, reason: string, message = 'error') => json(code, { error: { code, message, errors: [{ domain: 'global', reason }] } });

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

export const s256 = (verifier: string) => crypto.createHash('sha256').update(verifier).digest('base64url');

export class FakeGoogle {
  readonly agent = new MockAgent();
  readonly calls: Call[] = [];
  readonly calendars = new Map<string, FakeCalendar>();
  readonly refreshTokens = new Set<string>();
  readonly revoked: string[] = [];
  /** Authorization codes Google would hand back after consent. */
  readonly codes = new Map<string, { challenge: string; scope: string; refreshToken: string | null }>();
  /** calendarId → HTTP status to fail events.list with. */
  readonly failing = new Map<string, number>();
  pageSize = 50;
  /** The `updated` clock: every change moves it one second. */
  clock = T0 - 30 * DAY;
  private readonly accessTokens = new Set<string>();
  private issued = 0;

  constructor() {
    this.agent.disableNetConnect();
    this.agent
      .get('https://oauth2.googleapis.com')
      .intercept({ path: () => true, method: 'POST' })
      .reply((o) => this.oauth(o.path, String(o.body ?? '')))
      .persist();
    this.agent
      .get('https://www.googleapis.com')
      .intercept({ path: () => true, method: 'GET' })
      .reply((o) => this.api(o.path, headerValue(o.headers, 'authorization')))
      .persist();
  }

  readonly fetch: FetchLike = (input, init) =>
    undiciFetch(input as URL, { ...(init as object), dispatcher: this.agent } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;

  async close(): Promise<void> {
    await this.agent.close();
  }

  callsTo(path: RegExp): Call[] {
    return this.calls.filter((c) => path.test(c.path));
  }

  // ------------------------------------------------------------------------------------------ setup

  addCalendar(entry: Record<string, unknown>): this {
    const id = String(entry.id);
    const existing = this.calendars.get(id);
    if (existing) existing.entry = entry;
    else this.calendars.set(id, { index: this.calendars.size, entry, events: new Map(), seq: 0, tokenFloor: 0 });
    return this;
  }

  addCalendars(ids: string[] = Object.values(CAL).filter((c) => c in calendarEntries())): this {
    const entries = calendarEntries();
    for (const id of ids) this.addCalendar(entries[id]!);
    return this;
  }

  removeCalendar(id: string): void {
    this.calendars.delete(id);
  }

  /** Creates or replaces an event (new etag + updated). `startMs` is used for timeMin/timeMax filtering. */
  put(calendarId: string, ev: Record<string, unknown>, startMs = startOf(ev)): Record<string, unknown> {
    const cal = this.calendars.get(calendarId)!;
    cal.seq++;
    this.clock += 1000;
    const stored = { status: 'confirmed', ...ev, etag: `"etag-${cal.index}-${cal.seq}"`, updated: new Date(this.clock).toISOString() };
    cal.events.set(String(ev.id), { ev: stored, startMs, seq: cal.seq });
    return stored;
  }

  /** Deletes an event: later listings return it as {id, status: cancelled} (showDeleted). */
  cancel(calendarId: string, eventId: string): void {
    const cal = this.calendars.get(calendarId)!;
    const prev = cal.events.get(eventId);
    cal.seq++;
    this.clock += 1000;
    const minimal: Record<string, unknown> = {
      id: eventId,
      status: 'cancelled',
      etag: `"etag-${cal.index}-${cal.seq}"`,
      updated: new Date(this.clock).toISOString(),
    };
    if (prev?.ev.recurringEventId) minimal.recurringEventId = prev.ev.recurringEventId;
    cal.events.set(eventId, { ev: minimal, startMs: prev?.startMs ?? T0, seq: cal.seq });
  }

  /** Drops an event without a tombstone (what a full listing after a long gap looks like). */
  forget(calendarId: string, eventId: string): void {
    this.calendars.get(calendarId)!.events.delete(eventId);
  }

  /** Every sync token handed out so far for this calendar now answers 410. */
  expireTokens(calendarId: string): void {
    const cal = this.calendars.get(calendarId)!;
    cal.tokenFloor = cal.seq + 1;
  }

  /** Simulates the consent screen: Google redirects back with this code. */
  grantCode(code: string, challenge: string, o: { scope?: string; refreshToken?: string | null } = {}): void {
    this.codes.set(code, { challenge, scope: o.scope ?? CALENDAR_SCOPE, refreshToken: o.refreshToken === undefined ? 'test-refresh-token-1' : o.refreshToken });
  }

  // ------------------------------------------------------------------------------------------ handlers

  private record(method: string, host: string, url: URL, body: string): void {
    this.calls.push({ method, host, path: url.pathname, query: url.searchParams, body });
  }

  private issueAccess(): string {
    const t = `test-access-${++this.issued}`;
    this.accessTokens.add(t);
    return t;
  }

  private oauth(path: string, rawBody: string) {
    const url = new URL(path, 'https://oauth2.googleapis.com');
    this.record('POST', 'oauth2.googleapis.com', url, rawBody);
    const body = new URLSearchParams(rawBody);
    if (url.pathname === '/revoke') {
      const token = url.searchParams.get('token') ?? body.get('token');
      if (token && this.refreshTokens.delete(token)) {
        this.revoked.push(token);
        return json(200, {});
      }
      return json(400, { error: 'invalid_token' });
    }
    if (url.pathname !== '/token') return json(404, { error: 'not_found' });
    if (body.get('client_id') !== CLIENT.clientId || body.get('client_secret') !== CLIENT.clientSecret) return json(401, { error: 'invalid_client' });
    if (body.get('grant_type') === 'authorization_code') {
      const code = this.codes.get(body.get('code') ?? '');
      if (!code) return json(400, { error: 'invalid_grant', error_description: 'Bad Request' });
      this.codes.delete(body.get('code')!);
      if (body.get('redirect_uri') !== CLIENT.redirectUri) return json(400, { error: 'redirect_uri_mismatch' });
      const verifier = body.get('code_verifier');
      if (!verifier || s256(verifier) !== code.challenge) return json(400, { error: 'invalid_grant', error_description: 'Invalid code verifier.' });
      if (code.refreshToken) this.refreshTokens.add(code.refreshToken);
      return json(200, {
        access_token: this.issueAccess(),
        expires_in: 3599,
        token_type: 'Bearer',
        scope: code.scope,
        ...(code.refreshToken ? { refresh_token: code.refreshToken } : {}),
      });
    }
    if (body.get('grant_type') === 'refresh_token') {
      if (!this.refreshTokens.has(body.get('refresh_token') ?? '')) {
        return json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
      }
      return json(200, { access_token: this.issueAccess(), expires_in: 3599, token_type: 'Bearer', scope: CALENDAR_SCOPE });
    }
    return json(400, { error: 'unsupported_grant_type' });
  }

  private api(path: string, authorization: string | undefined) {
    const url = new URL(path, 'https://www.googleapis.com');
    this.record('GET', 'www.googleapis.com', url, '');
    const bearer = authorization?.replace(/^Bearer /, '');
    if (!bearer || !this.accessTokens.has(bearer)) return apiError(401, 'authError', 'Invalid Credentials');
    if (url.pathname === '/calendar/v3/users/me/calendarList') {
      return json(200, { kind: 'calendar#calendarList', items: [...this.calendars.values()].map((c) => c.entry) });
    }
    const m = /^\/calendar\/v3\/calendars\/([^/]+)\/events$/.exec(url.pathname);
    if (!m) return apiError(404, 'notFound');
    const id = decodeURIComponent(m[1]!);
    const cal = this.calendars.get(id);
    if (!cal) return apiError(404, 'notFound', 'Not Found');
    const failure = this.failing.get(id);
    if (failure) return apiError(failure, failure === 403 ? 'forbidden' : 'backendError');
    const q = url.searchParams;
    if (q.get('singleEvents') !== 'true' || q.get('showDeleted') !== 'true') return apiError(400, 'invalid', 'expected singleEvents and showDeleted');

    let list: StoredEvent[];
    const syncToken = q.get('syncToken');
    if (syncToken) {
      if (q.has('timeMin') || q.has('timeMax')) return apiError(400, 'invalid', 'syncToken with a time range');
      const [, idx, seq] = /^sync-(\d+)-(\d+)$/.exec(syncToken) ?? [];
      if (Number(idx) !== cal.index || Number(seq) < cal.tokenFloor) {
        return apiError(410, 'fullSyncRequired', 'Sync token is no longer valid, a full sync is required.');
      }
      list = [...cal.events.values()].filter((e) => e.seq > Number(seq));
    } else {
      const min = q.has('timeMin') ? Date.parse(q.get('timeMin')!) : -Infinity;
      const max = q.has('timeMax') ? Date.parse(q.get('timeMax')!) : Infinity;
      list = [...cal.events.values()].filter((e) => e.startMs >= min && e.startMs < max);
    }
    list.sort((a, b) => a.seq - b.seq);
    const offset = Number(q.get('pageToken')?.replace(/^page-/, '') ?? 0);
    const items = list.slice(offset, offset + this.pageSize).map((e) => e.ev);
    const more = offset + this.pageSize < list.length;
    return json(200, {
      kind: 'calendar#events',
      timeZone: cal.entry.timeZone,
      items,
      ...(more ? { nextPageToken: `page-${offset + this.pageSize}` } : { nextSyncToken: `sync-${cal.index}-${cal.seq}` }),
    });
  }
}

function startOf(ev: Record<string, unknown>): number {
  const start = ev.start as { dateTime?: string; date?: string } | undefined;
  if (start?.dateTime) return Date.parse(start.dateTime);
  if (start?.date) return Date.parse(`${start.date}T00:00:00Z`);
  return T0;
}

const isoAt = (ms: number) => new Date(ms).toISOString();

/** A timed event at `startMs` (UTC offset form) lasting `hours`. */
export function timed(id: string, startMs: number, extra: Record<string, unknown> = {}, hours = 2): Record<string, unknown> {
  return { id, summary: 'Synthetic event', start: { dateTime: isoAt(startMs) }, end: { dateTime: isoAt(startMs + hours * 3_600_000) }, ...extra };
}

export function allDay(id: string, date: string, endDate: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, summary: 'Synthetic all-day', start: { date }, end: { date: endDate }, ...extra };
}
