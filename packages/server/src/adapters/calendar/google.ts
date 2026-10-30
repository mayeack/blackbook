/**
 * Google OAuth + Calendar API v3 client, read-only (PLAN "Ingestion → Google Calendar").
 *   - Four products share the OAuth client, each with its own consent and refresh token (GOOGLE_PRODUCTS):
 *     calendar (calendar.readonly), gmail (gmail.readonly, adapters/gmail), photos (the Google Photos Picker,
 *     adapters/gphotos) and gmail_send (gmail.send + the account's address, delivery/email.ts: the weekly event picks
 *     emailed to the owner's own inbox). A Gmail-scoped token dies on a password change; kept apart, it can't take
 *     Calendar with it, and the read token can't send nor the send token read.
 *   - Every request goes through guardedFetch: an allowlist of POST oauth2.googleapis.com/{token,revoke}, GET
 *     calendarList / events.list on www.googleapis.com, GET Gmail profile / messages.list / messages.get, POST Gmail
 *     messages.send (only on a gmail_send client), the Photos Picker's session calls and GET on its
 *     lh*.googleusercontent.com media URLs. Anything else (an insert, a Gmail modify / trash / draft, another host) is
 *     refused before it leaves the Mac, so nothing can ever write to the calendar or change the mailbox; the one write
 *     is a new message, from the send grant's own client, and delivery/email.ts only ever addresses one to the
 *     connected account itself.
 *   - Only the calendar module of googleapis is loaded (the full package costs ~0.6 s at startup).
 *   - Google errors become GoogleAuthError / SyncTokenGoneError / GoogleApiError carrying a status and a short
 *     reason token. The underlying GaxiosError is dropped: its config holds the refresh token, the auth code and
 *     the client secret.
 *   - Responses are validated with zod (unknown fields kept); a mismatch is GoogleContractError (paths only).
 */
import { auth, calendar_v3 } from 'googleapis/build/src/apis/calendar/index.js';
import { z } from 'zod';
import type { DB } from '../../db/connection';
import { getSecret, setSecret } from '../../security/secrets';

export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
export const REFRESH_TOKEN_SECRET = 'google.refresh_token';
export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const GMAIL_REFRESH_TOKEN_SECRET = 'gmail.refresh_token';
export const PHOTOS_PICKER_SCOPE = 'https://www.googleapis.com/auth/photospicker.mediaitems.readonly';
export const GPHOTOS_REFRESH_TOKEN_SECRET = 'gphotos.refresh_token';
export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
export const GMAIL_SEND_REFRESH_TOKEN_SECRET = 'gmail_send.refresh_token';
/** The connected account's own address (from the consent's id_token): the only recipient delivery/email.ts uses. */
export const GMAIL_SEND_ADDRESS_SECRET = 'gmail_send.address';

export interface GoogleProductSpec {
  scope: string;
  secret: string;
  settingsParam: string;
  /** Scopes asked for alongside `scope` (openid email: the id_token names the account). */
  extraScopes?: readonly string[];
  /** Where the account's verified address from the id_token is kept (encrypted); the consent fails without one. */
  addressSecret?: string;
}

/** What a consent is for. Each product is its own grant (include_granted_scopes: false) and refresh token. */
export type GoogleProduct = 'calendar' | 'gmail' | 'photos' | 'gmail_send';
export const GOOGLE_PRODUCTS: Readonly<Record<GoogleProduct, GoogleProductSpec>> = {
  calendar: { scope: CALENDAR_SCOPE, secret: REFRESH_TOKEN_SECRET, settingsParam: 'google' },
  gmail: { scope: GMAIL_SCOPE, secret: GMAIL_REFRESH_TOKEN_SECRET, settingsParam: 'gmail' },
  photos: { scope: PHOTOS_PICKER_SCOPE, secret: GPHOTOS_REFRESH_TOKEN_SECRET, settingsParam: 'gphotos' },
  gmail_send: { scope: GMAIL_SEND_SCOPE, secret: GMAIL_SEND_REFRESH_TOKEN_SECRET, settingsParam: 'gmailsend', extraScopes: ['openid', 'email'], addressSecret: GMAIL_SEND_ADDRESS_SECRET },
};
export const isGoogleProduct = (v: unknown): v is GoogleProduct => typeof v === 'string' && Object.hasOwn(GOOGLE_PRODUCTS, v);

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
export type OAuth2Client = InstanceType<typeof auth.OAuth2>;

const REQUEST_TIMEOUT_MS = 60_000;

export class GoogleEgressRefusedError extends Error {
  constructor(method: string, origin: string) {
    super(`refused a ${method} request to ${origin}: not on the Google allowlist`);
    this.name = 'GoogleEgressRefusedError';
  }
}

const ALLOWED: readonly { method: string; origin: string | RegExp; path: RegExp; only?: GoogleProduct }[] = [
  { method: 'POST', origin: 'https://oauth2.googleapis.com', path: /^\/(token|revoke)$/ },
  { method: 'GET', origin: 'https://www.googleapis.com', path: /^\/calendar\/v3\/users\/me\/calendarList$/ },
  { method: 'GET', origin: 'https://www.googleapis.com', path: /^\/calendar\/v3\/calendars\/[^/]+\/events$/ },
  // Gmail (adapters/gmail): read-only — the profile, messages.list and messages.get. Never modify/send/trash/watch.
  { method: 'GET', origin: 'https://gmail.googleapis.com', path: /^\/gmail\/v1\/users\/me\/(profile|messages)$/ },
  { method: 'GET', origin: 'https://gmail.googleapis.com', path: /^\/gmail\/v1\/users\/me\/messages\/[A-Za-z0-9_-]{1,64}$/ },
  // Gmail sending (delivery/email.ts): a new message to the owner's own address, and only from the gmail_send grant's
  // client. Never a draft, a modify, a trash or an import.
  { method: 'POST', origin: 'https://gmail.googleapis.com', path: /^\/gmail\/v1\/users\/me\/messages\/send$/, only: 'gmail_send' },
  // Google Photos Picker (adapters/gphotos): sessions the owner picks into, the picked items, and their media bytes.
  // Creating / deleting a session touches no photo; the library itself is never written.
  { method: 'POST', origin: 'https://photospicker.googleapis.com', path: /^\/v1\/sessions$/ },
  { method: 'GET', origin: 'https://photospicker.googleapis.com', path: /^\/v1\/sessions\/[A-Za-z0-9_-]{1,128}$/ },
  { method: 'DELETE', origin: 'https://photospicker.googleapis.com', path: /^\/v1\/sessions\/[A-Za-z0-9_-]{1,128}$/ },
  { method: 'GET', origin: 'https://photospicker.googleapis.com', path: /^\/v1\/mediaItems$/ },
  { method: 'GET', origin: /^https:\/\/lh[0-9]\.googleusercontent\.com$/, path: /^\/.+$/ },
];

const originMatches = (allowed: string | RegExp, origin: string) => (typeof allowed === 'string' ? allowed === origin : allowed.test(origin));

const requestUrl = (input: unknown): URL =>
  new URL(input instanceof URL ? input.href : typeof input === 'string' ? input : (input as { url: string }).url);

/** Wraps a fetch so only the allowlist can reach the network (entries marked `only` need that product's client). */
export function guardedFetch(inner: FetchLike, product: GoogleProduct | null = null): FetchLike {
  return (input, init) => {
    const url = requestUrl(input);
    const method = (init?.method ?? (input as { method?: string }).method ?? 'GET').toUpperCase();
    if (!ALLOWED.some((a) => (!a.only || a.only === product) && a.method === method && originMatches(a.origin, url.origin) && a.path.test(url.pathname))) {
      return Promise.reject(new GoogleEgressRefusedError(method, url.origin));
    }
    // A redirect would reach a host the allowlist never saw: refuse it rather than follow it.
    return inner(url, { ...init, redirect: 'error' });
  };
}

/** Node's fetch, looked up per call. */
export const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

/** An OAuth client; `product` = whose token it will hold (the consent flow's own client holds none: null). */
export function oauthClient(cfg: GoogleOAuthConfig, fetchImpl: FetchLike = defaultFetch, product: GoogleProduct | null = null): OAuth2Client {
  return new auth.OAuth2({
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    redirectUri: cfg.redirectUri,
    transporterOptions: { fetchImplementation: guardedFetch(fetchImpl, product) as never, timeout: REQUEST_TIMEOUT_MS },
  });
}

// ---------------------------------------------------------------------------------------------- errors

/** The refresh token is missing, expired or revoked: the owner has to reconnect. */
export class GoogleAuthError extends Error {
  constructor(readonly reason: string) {
    super(`Google authorization failed (${reason})`);
    this.name = 'GoogleAuthError';
  }
}

export class GoogleApiError extends Error {
  constructor(
    readonly status: number | null,
    readonly reason: string,
  ) {
    super(`Google API request failed (${status ?? 'network'}, ${reason})`);
    this.name = 'GoogleApiError';
  }
}

/** HTTP 410 on events.list: the sync token expired, a full resync is required. */
export class SyncTokenGoneError extends GoogleApiError {
  constructor(reason: string) {
    super(410, reason);
    this.name = 'SyncTokenGoneError';
  }
}

export class GoogleContractError extends Error {
  constructor(
    readonly route: string,
    readonly paths: string[],
  ) {
    super(`Google ${route} response did not match the expected shape (at ${paths.slice(0, 5).join(', ') || 'root'})`);
    this.name = 'GoogleContractError';
  }
}

const TOKEN = /^[A-Za-z0-9_.-]{1,48}$/;
const safeToken = (v: unknown): string | null => (typeof v === 'string' && TOKEN.test(v) ? v : null);

const AUTH_REASONS = new Set(['invalid_grant', 'invalid_client', 'unauthorized_client', 'invalid_token']);

/** GaxiosError (or anything thrown inside a request) → one of the errors above. Never keeps the original. */
export function mapGoogleError(e: unknown): Error {
  if (e instanceof GoogleEgressRefusedError || e instanceof GoogleAuthError || e instanceof GoogleApiError) return e;
  const err = e as { cause?: unknown; status?: unknown; code?: unknown; name?: unknown; response?: { status?: number; data?: unknown } };
  if (err?.cause instanceof GoogleEgressRefusedError) return err.cause;
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return new GoogleApiError(null, 'timeout');
  const status = typeof err?.response?.status === 'number' ? err.response.status : typeof err?.status === 'number' ? err.status : null;
  const data = err?.response?.data as { error?: unknown } | undefined;
  // OAuth endpoints answer {error: "invalid_grant"}; the Calendar API {error: {code, status, errors: [{reason}]}}.
  const oauthReason = safeToken(data?.error);
  const apiError = data?.error && typeof data.error === 'object' ? (data.error as { status?: unknown; errors?: { reason?: unknown }[] }) : null;
  const reason = oauthReason ?? safeToken(apiError?.errors?.[0]?.reason) ?? safeToken(apiError?.status) ?? safeToken(err?.code) ?? (status ? `http_${status}` : 'network');
  if ((oauthReason && AUTH_REASONS.has(oauthReason)) || status === 401) return new GoogleAuthError(oauthReason ?? 'unauthorized');
  if (status === 410) return new SyncTokenGoneError(reason);
  return new GoogleApiError(status, reason);
}

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw mapGoogleError(e);
  }
}

function parse<S extends z.ZodType>(route: string, schema: S, data: unknown): z.output<S> {
  const r = schema.safeParse(data);
  if (!r.success) throw new GoogleContractError(route, [...new Set(r.error.issues.map((i) => i.path.join('.') || 'root'))]);
  return r.data;
}

// ---------------------------------------------------------------------------------------------- shapes

export const CalendarListEntry = z.looseObject({
  id: z.string().min(1),
  summary: z.string().nullish(),
  summaryOverride: z.string().nullish(),
  timeZone: z.string().nullish(),
  accessRole: z.string().nullish(),
  primary: z.boolean().nullish(),
  deleted: z.boolean().nullish(),
});
export type CalendarListEntry = z.output<typeof CalendarListEntry>;

const CalendarListPage = z.looseObject({
  items: z.array(CalendarListEntry).nullish(),
  nextPageToken: z.string().nullish(),
});

const EventTime = z.looseObject({ date: z.string().nullish(), dateTime: z.string().nullish(), timeZone: z.string().nullish() });
const Person = z.looseObject({ email: z.string().nullish(), displayName: z.string().nullish(), self: z.boolean().nullish() });

export const GoogleEvent = z.looseObject({
  id: z.string().min(1),
  status: z.string().nullish(),
  etag: z.string().nullish(),
  updated: z.string().nullish(),
  iCalUID: z.string().nullish(),
  recurringEventId: z.string().nullish(),
  originalStartTime: EventTime.nullish(),
  summary: z.string().nullish(),
  description: z.string().nullish(),
  location: z.string().nullish(),
  htmlLink: z.string().nullish(),
  eventType: z.string().nullish(),
  start: EventTime.nullish(),
  end: EventTime.nullish(),
  organizer: Person.nullish(),
  creator: Person.nullish(),
  attendees: z
    .array(
      z.looseObject({
        email: z.string().nullish(),
        displayName: z.string().nullish(),
        responseStatus: z.string().nullish(),
        self: z.boolean().nullish(),
        organizer: z.boolean().nullish(),
        optional: z.boolean().nullish(),
        resource: z.boolean().nullish(),
        additionalGuests: z.number().int().nullish(),
      }),
    )
    .nullish(),
  source: z.looseObject({ url: z.string().nullish(), title: z.string().nullish() }).nullish(),
});
export type GoogleEvent = z.output<typeof GoogleEvent>;

const EventsPage = z.looseObject({
  items: z.array(GoogleEvent).nullish(),
  nextPageToken: z.string().nullish(),
  nextSyncToken: z.string().nullish(),
  timeZone: z.string().nullish(),
});

// ---------------------------------------------------------------------------------------------- API

export interface EventsQuery {
  syncToken?: string;
  timeMin?: string;
  timeMax?: string;
  pageToken?: string;
}

export interface EventsPageResult {
  items: GoogleEvent[];
  nextPageToken: string | null;
  nextSyncToken: string | null;
  timeZone: string | null;
}

/** The two read calls the sync needs. */
export interface CalendarApi {
  listCalendars(signal?: AbortSignal): Promise<CalendarListEntry[]>;
  listEvents(calendarId: string, q: EventsQuery, signal?: AbortSignal): Promise<EventsPageResult>;
}

const MAX_CALENDAR_PAGES = 20;

export function calendarApi(client: OAuth2Client): CalendarApi {
  const cal = new calendar_v3.Calendar({ auth: client });
  return {
    async listCalendars(signal) {
      const out: CalendarListEntry[] = [];
      let pageToken: string | undefined;
      for (let n = 0; n < MAX_CALENDAR_PAGES; n++) {
        const res = await call(() => cal.calendarList.list({ maxResults: 250, showHidden: true, pageToken }, { signal }));
        const page = parse('calendarList.list', CalendarListPage, res.data);
        out.push(...(page.items ?? []));
        if (!page.nextPageToken) return out;
        pageToken = page.nextPageToken;
      }
      throw new GoogleContractError('calendarList.list', ['nextPageToken']);
    },
    async listEvents(calendarId, q, signal) {
      // syncToken can't be combined with timeMin/timeMax; singleEvents and showDeleted must match the first listing.
      const params: calendar_v3.Params$Resource$Events$List = { calendarId, singleEvents: true, showDeleted: true, maxResults: 2500 };
      if (q.syncToken) params.syncToken = q.syncToken;
      else {
        if (q.timeMin) params.timeMin = q.timeMin;
        if (q.timeMax) params.timeMax = q.timeMax;
      }
      if (q.pageToken) params.pageToken = q.pageToken;
      const res = await call(() => cal.events.list(params, { signal }));
      const page = parse('events.list', EventsPage, res.data);
      return {
        items: page.items ?? [],
        nextPageToken: page.nextPageToken ?? null,
        nextSyncToken: page.nextSyncToken ?? null,
        timeZone: page.timeZone ?? null,
      };
    },
  };
}

// ---------------------------------------------------------------------------------------------- connection

export function isConnected(db: DB, product: GoogleProduct = 'calendar'): boolean {
  return db.prepare('SELECT 1 FROM secrets WHERE name = ?').get(GOOGLE_PRODUCTS[product].secret) !== undefined;
}

/** When the product's refresh token was stored (the connect time), or null. */
export function connectedAt(db: DB, product: GoogleProduct = 'calendar'): number | null {
  return (db.prepare('SELECT updated_at FROM secrets WHERE name = ?').pluck().get(GOOGLE_PRODUCTS[product].secret) as number | undefined) ?? null;
}

/**
 * An OAuth client holding the product's stored refresh token, or null when that product isn't connected. A refresh
 * token that Google rotates is stored again (encrypted).
 */
export function connectedClient(
  db: DB,
  secretsKey: Buffer,
  cfg: GoogleOAuthConfig,
  fetchImpl?: FetchLike,
  product: GoogleProduct = 'calendar',
): OAuth2Client | null {
  const secret = GOOGLE_PRODUCTS[product].secret;
  const refreshToken = getSecret(db, secretsKey, secret);
  if (!refreshToken) return null;
  const client = oauthClient(cfg, fetchImpl, product);
  client.setCredentials({ refresh_token: refreshToken });
  client.on('tokens', (t) => {
    if (t.refresh_token && t.refresh_token !== refreshToken) setSecret(db, secretsKey, secret, t.refresh_token);
  });
  return client;
}
