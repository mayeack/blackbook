/**
 * Partiful auth (PLAN "Ingestion → Partiful"): the owner signs in to partiful.com once, in the sandbox Chromium
 * (OrbStack, CDP on loopback). We connect over CDP, read the Firebase user from partiful.com's IndexedDB
 * (firebaseLocalStorageDb → firebaseLocalStorage → "firebase:authUser:<apiKey>:[DEFAULT]": uid, apiKey,
 * stsTokenManager.refreshToken), store {uid, apiKey, refreshToken} AES-GCM encrypted in the secrets table, and
 * from then on mint 1-hour ID tokens from Node via securetoken.googleapis.com (Referer https://partiful.com/ is
 * required, or Google answers API_KEY_HTTP_REFERRER_BLOCKED). The browser is consulted again only when nothing is
 * stored or the stored refresh token is refused; a refused token is remembered for the process and never sent
 * again, so a later attempt reads the browser afresh (the owner may have signed in again) instead of retrying it.
 * CDP hygiene: Playwright attaches with noDefaults, so the shared browser's download behaviour and its tabs' focus
 * and media emulation are left alone. An existing partiful.com tab is used as is; otherwise one tab is opened and
 * closed again. The connection is then dropped with Browser.close(), which over CDP only disconnects: the user's
 * browser and tabs stay. Tokens never reach logs, errors, health rows or stats.
 */
import { request, type Dispatcher } from 'undici';
import { z } from 'zod';
import type { DB } from '../../db/connection';
import { getSecret, setSecret } from '../../security/secrets';
import { PartifulAuthRequiredError, PartifulContractError, PartifulHttpError } from './errors';

export const PARTIFUL_ORIGIN = 'https://partiful.com';
export const SESSION_SECRET = 'partiful.session';
const TOKEN_URL = 'https://securetoken.googleapis.com/v1/token';
/** A current desktop Chrome, like the sandbox browser the session came from. */
export const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';

export const PartifulSession = z.object({
  uid: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/),
  apiKey: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
  refreshToken: z.string().min(16).max(8192),
});
export type PartifulSession = z.infer<typeof PartifulSession>;

// ------------------------------------------------------------------------------------------- CDP (sandbox browser)

/** The slice of Playwright's CDP browser this module uses (tests pass fakes; no real browser). */
export interface CdpPage {
  url(): string;
  /** A JS expression evaluated in the page; a returned promise is awaited. */
  evaluate(expression: string): Promise<unknown>;
  goto(url: string, o: { waitUntil: 'domcontentloaded'; timeout: number }): Promise<unknown>;
  close(): Promise<void>;
}
export interface CdpContext {
  pages(): CdpPage[];
  newPage(): Promise<CdpPage>;
}
export interface CdpBrowser {
  contexts(): CdpContext[];
  /** Over CDP: disconnects only (Playwright's connectOverCDP close never kills the browser). */
  close(): Promise<void>;
}
export type CdpConnect = (endpoint: string, o: { timeout: number }) => Promise<CdpBrowser>;

/**
 * playwright-core's chromium.connectOverCDP, loaded on first use (keeps it out of server start-up). noDefaults: the
 * sandbox browser is shared (the owner's viewer, Claude Code), so Playwright must not redirect its downloads or
 * override focus/media emulation on its existing tabs while attached.
 */
export const playwrightConnect: CdpConnect = async (endpoint, o) => {
  const { chromium } = await import('playwright-core');
  return (await chromium.connectOverCDP(endpoint, { timeout: o.timeout, noDefaults: true })) as unknown as CdpBrowser;
};

/**
 * Runs inside a partiful.com page: the Firebase auth user, or {error}. IndexedDB first (Firebase's default web
 * persistence), then localStorage (browserLocalPersistence). Read-only: it never creates the database (an
 * upgrade, i.e. a missing database, is aborted) and returns only uid, apiKey and refreshToken. A string (not a
 * function) so no bundler helper ends up in the serialized source.
 */
export const READ_AUTH_USER_JS = `(async () => {
  const DB_NAME = 'firebaseLocalStorageDb';
  const STORE = 'firebaseLocalStorage';
  const PREFIX = 'firebase:authUser:';
  const pick = (key, v) => {
    if (typeof key !== 'string' || !key.startsWith(PREFIX) || !v || typeof v !== 'object') return null;
    const stm = v.stsTokenManager && typeof v.stsTokenManager === 'object' ? v.stsTokenManager : {};
    const apiKey = typeof v.apiKey === 'string' ? v.apiKey : key.slice(PREFIX.length).split(':')[0];
    return { uid: v.uid, apiKey: apiKey, refreshToken: stm.refreshToken };
  };
  const fromLocalStorage = () => {
    try {
      if (typeof localStorage === 'undefined' || !localStorage) return null;
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith(PREFIX)) continue;
        const found = pick(key, JSON.parse(localStorage.getItem(key) || 'null'));
        if (found) return found;
      }
    } catch (e) {}
    return null;
  };
  const fromIndexedDb = async () => {
    if (typeof indexedDB === 'undefined' || !indexedDB) return { error: 'no_indexeddb' };
    if (typeof indexedDB.databases === 'function') {
      try {
        const list = await indexedDB.databases();
        if (Array.isArray(list) && !list.some((d) => d && d.name === DB_NAME)) return { error: 'no_db' };
      } catch (e) {}
    }
    const db = await new Promise((resolve) => {
      let req;
      try { req = indexedDB.open(DB_NAME); } catch (e) { resolve(null); return; }
      req.onupgradeneeded = () => { try { req.transaction.abort(); } catch (e) {} };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    });
    if (!db) return { error: 'no_db' };
    try {
      if (!db.objectStoreNames.contains(STORE)) return { error: 'no_store' };
      const rows = await new Promise((resolve) => {
        try {
          const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => resolve(null);
        } catch (e) { resolve(null); }
      });
      if (!rows) return { error: 'read_failed' };
      for (const row of rows) {
        const found = row ? pick(row.fbase_key, row.value) : null;
        if (found) return found;
      }
      return { error: 'no_user' };
    } finally {
      db.close();
    }
  };
  const viaIdb = await fromIndexedDb();
  if (viaIdb && viaIdb.uid) return viaIdb;
  return fromLocalStorage() || viaIdb;
})()`;

const isPartifulPage = (url: string): boolean => {
  try {
    return new URL(url).origin === PARTIFUL_ORIGIN;
  } catch {
    return false;
  }
};

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms).unref())]);

export interface ExtractOptions {
  cdpUrl: string;
  connect?: CdpConnect;
  timeoutMs?: number;
}

/** Reads the signed-in Partiful session out of the sandbox browser. Throws PartifulAuthRequiredError. */
export async function extractBrowserSession(o: ExtractOptions): Promise<PartifulSession> {
  const timeout = o.timeoutMs ?? 30_000;
  let browser: CdpBrowser;
  try {
    browser = await (o.connect ?? playwrightConnect)(o.cdpUrl, { timeout });
  } catch {
    throw new PartifulAuthRequiredError('browser_unreachable');
  }
  let opened: CdpPage | null = null;
  try {
    const contexts = browser.contexts();
    let page = contexts.flatMap((c) => c.pages()).find((p) => isPartifulPage(p.url()));
    if (!page) {
      const ctx = contexts[0];
      if (!ctx) throw new PartifulAuthRequiredError('browser_unreachable');
      opened = page = await ctx.newPage();
      try {
        await page.goto(`${PARTIFUL_ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout });
      } catch {
        throw new PartifulAuthRequiredError('browser_unreachable');
      }
      if (!isPartifulPage(page.url())) throw new PartifulAuthRequiredError('not_signed_in');
    }
    let raw: unknown;
    try {
      raw = await withTimeout(page.evaluate(READ_AUTH_USER_JS), timeout);
    } catch {
      throw new PartifulAuthRequiredError('browser_unreachable');
    }
    const parsed = PartifulSession.safeParse(raw);
    if (!parsed.success) throw new PartifulAuthRequiredError('not_signed_in');
    return parsed.data;
  } finally {
    if (opened) await opened.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

// ------------------------------------------------------------------------------------------- stored session

/** The stored session, or null (none, unreadable, or no SECRETS_KEY). */
export function loadStoredSession(db: DB, key: Buffer | null): PartifulSession | null {
  if (!key) return null;
  try {
    const raw = getSecret(db, key, SESSION_SECRET);
    if (!raw) return null;
    const parsed = PartifulSession.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Stores the session encrypted (no-op without SECRETS_KEY: the session then lives in memory only). */
export function storeSession(db: DB, key: Buffer | null, s: PartifulSession, now = Date.now()): boolean {
  if (!key) return false;
  setSecret(db, key, SESSION_SECRET, JSON.stringify(PartifulSession.parse(s)), now);
  return true;
}

// ------------------------------------------------------------------------------------------- ID tokens

const TokenResponse = z
  .object({
    id_token: z.string().min(16),
    refresh_token: z.string().min(16).optional(),
    expires_in: z.union([z.string().regex(/^\d+$/), z.number().int().positive()]),
    user_id: z.string().optional(),
  })
  .passthrough();

const TokenError = z.object({ error: z.object({ message: z.string().optional(), status: z.string().optional() }).passthrough() }).passthrough();

/** Messages securetoken uses for a refresh token that will never work again. */
const DEAD_REFRESH = /^(TOKEN_EXPIRED|INVALID_REFRESH_TOKEN|USER_DISABLED|USER_NOT_FOUND|INVALID_GRANT_TYPE|MISSING_REFRESH_TOKEN|INVALID_ID_TOKEN)/;

class RefreshRejected extends Error {
  constructor() {
    super('refresh token rejected');
    this.name = 'RefreshRejected';
  }
}

export interface RefreshedToken {
  idToken: string;
  expiresAt: number;
  refreshToken: string;
  uid: string | null;
}

/** One securetoken exchange. RefreshRejected for a dead refresh token; contract/http errors otherwise. */
async function exchangeRefreshToken(s: PartifulSession, o: { dispatcher?: Dispatcher; timeoutMs: number; now: number; signal?: AbortSignal }): Promise<RefreshedToken> {
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: s.refreshToken }).toString();
  const signals = [AbortSignal.timeout(o.timeoutMs), ...(o.signal ? [o.signal] : [])];
  let res: Dispatcher.ResponseData;
  try {
    res = await request(`${TOKEN_URL}?key=${encodeURIComponent(s.apiKey)}`, {
      method: 'POST',
      ...(o.dispatcher ? { dispatcher: o.dispatcher } : {}),
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
        referer: `${PARTIFUL_ORIGIN}/`,
        origin: PARTIFUL_ORIGIN,
        'user-agent': BROWSER_USER_AGENT,
      },
      body,
      signal: AbortSignal.any(signals),
    });
  } catch (e) {
    throw new PartifulHttpError('securetoken', null, transportCode(e));
  }
  let json: unknown = null;
  try {
    const text = await res.body.text();
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (res.statusCode >= 200 && res.statusCode < 300) {
    const ok = TokenResponse.safeParse(json);
    if (!ok.success) throw new PartifulContractError('securetoken', 'token response', issuePaths(ok.error));
    return {
      idToken: ok.data.id_token,
      expiresAt: o.now + Number(ok.data.expires_in) * 1000,
      refreshToken: ok.data.refresh_token ?? s.refreshToken,
      uid: ok.data.user_id ?? null,
    };
  }
  const err = TokenError.safeParse(json);
  const msg = err.success ? (err.data.error.message ?? '') : '';
  // Google puts the reason in error.details[].reason (and sometimes the message): look at the whole error object.
  if (/API_KEY_HTTP_REFERRER_BLOCKED|API_KEY_INVALID|API_KEY_SERVICE_BLOCKED/.test(err.success ? JSON.stringify(err.data.error) : '')) {
    throw new PartifulContractError('securetoken', 'api key or referer refused');
  }
  if (res.statusCode === 400 && DEAD_REFRESH.test(msg)) throw new RefreshRejected();
  if (res.statusCode === 400 || res.statusCode === 401 || res.statusCode === 403) throw new RefreshRejected();
  throw new PartifulHttpError('securetoken', res.statusCode, `http_${res.statusCode}`);
}

const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENOTFOUND', 'ETIMEDOUT', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED']);

/** Error class/code for a transport failure (never its message: it can carry the URL). */
export function transportCode(e: unknown): string {
  const err = e as { code?: unknown; name?: unknown };
  const code = typeof err?.code === 'string' ? err.code : typeof err?.name === 'string' ? err.name : 'ERROR';
  if (NETWORK_CODES.has(code)) return code.replace(/^UND_ERR_/, '');
  if (/timeout|abort/i.test(code)) return 'TIMEOUT';
  return /^[A-Z_]{1,40}$/.test(code) ? code : 'ERROR';
}

export const issuePaths = (e: z.ZodError): string[] => [
  ...new Set(e.issues.map((i) => i.path.map((p) => (typeof p === 'number' ? '#' : String(p))).join('.') || 'root')),
];

/** What the API client needs from auth. */
export interface TokenSource {
  /** A valid Firebase ID token; `force` after a 401 mints a new one. */
  idToken(o?: { force?: boolean; signal?: AbortSignal }): Promise<string>;
  /** The signed-in Partiful user id (sent as body.userId). */
  userId(): Promise<string>;
}

export interface PartifulAuthOptions {
  db: DB;
  secretsKey: Buffer | null;
  /** Sandbox browser CDP endpoint; null = stored session only. */
  cdpUrl: string | null;
  connect?: CdpConnect;
  /** undici dispatcher for securetoken (tests pass a MockAgent). */
  dispatcher?: Dispatcher;
  clock?: () => number;
  timeoutMs?: number;
}

/**
 * Session + ID-token manager. One instance lives for the server's lifetime (the ID token is reused for its hour);
 * the session is loaded from the secrets table lazily and replaced from the browser when needed.
 */
export class PartifulAuth implements TokenSource {
  private session: PartifulSession | null = null;
  private loaded = false;
  private token: { value: string; expiresAt: number } | null = null;
  private readonly clock: () => number;
  /** Refresh tokens securetoken refused in this process: never sent again, nor adopted from the browser. */
  private readonly dead = new Set<string>();
  readonly stats = { browser_reads: 0, refreshes: 0 };

  constructor(private readonly o: PartifulAuthOptions) {
    this.clock = o.clock ?? Date.now;
  }

  /** The browser's session; refresh_rejected while it still holds a token known to be dead (signed out). */
  private async fromBrowser(): Promise<PartifulSession> {
    if (!this.o.cdpUrl) throw new PartifulAuthRequiredError('no_session');
    this.stats.browser_reads++;
    const s = await extractBrowserSession({ cdpUrl: this.o.cdpUrl, connect: this.o.connect, timeoutMs: this.o.timeoutMs });
    if (this.dead.has(s.refreshToken)) throw new PartifulAuthRequiredError('refresh_rejected');
    const changed = !this.session || this.session.refreshToken !== s.refreshToken || this.session.uid !== s.uid || this.session.apiKey !== s.apiKey;
    this.session = s;
    this.loaded = true;
    if (changed) storeSession(this.o.db, this.o.secretsKey, s, this.clock());
    return s;
  }

  private current(): PartifulSession | null {
    if (!this.loaded) {
      this.loaded = true;
      const stored = loadStoredSession(this.o.db, this.o.secretsKey);
      if (stored && !this.dead.has(stored.refreshToken)) this.session = stored;
    }
    return this.session;
  }

  /** securetoken refused `s`: forget it, so the next attempt (this one or a later run) reads the browser again. */
  private rejected(s: PartifulSession): void {
    this.dead.add(s.refreshToken);
    if (this.session?.refreshToken === s.refreshToken) this.session = null;
    this.loaded = true;
    this.token = null;
  }

  private async refresh(signal?: AbortSignal): Promise<string> {
    const exchange = (x: PartifulSession) =>
      exchangeRefreshToken(x, { dispatcher: this.o.dispatcher, timeoutMs: this.o.timeoutMs ?? 30_000, now: this.clock(), signal });
    // The browser is read at most once per refresh: first, when nothing usable is known, or after a refusal.
    let fromBrowser = false;
    let s = this.current();
    if (!s) {
      s = await this.fromBrowser();
      fromBrowser = true;
    }
    let r: RefreshedToken;
    try {
      this.stats.refreshes++;
      r = await exchange(s);
    } catch (e) {
      if (!(e instanceof RefreshRejected)) throw e;
      this.rejected(s);
      if (fromBrowser) throw new PartifulAuthRequiredError('refresh_rejected');
      // The stored token is dead: the browser may hold a newer session (the owner signed in again).
      s = await this.fromBrowser();
      try {
        this.stats.refreshes++;
        r = await exchange(s);
      } catch (e2) {
        if (!(e2 instanceof RefreshRejected)) throw e2;
        this.rejected(s);
        throw new PartifulAuthRequiredError('refresh_rejected');
      }
    }
    // securetoken may rotate the refresh token; the ID token's user is authoritative for the uid.
    const next: PartifulSession = { uid: r.uid && /^[A-Za-z0-9_.:-]{1,128}$/.test(r.uid) ? r.uid : s.uid, apiKey: s.apiKey, refreshToken: r.refreshToken };
    if (next.refreshToken !== s.refreshToken || next.uid !== s.uid) storeSession(this.o.db, this.o.secretsKey, next, this.clock());
    this.session = next;
    this.loaded = true;
    this.token = { value: r.idToken, expiresAt: r.expiresAt };
    return r.idToken;
  }

  async idToken(o: { force?: boolean; signal?: AbortSignal } = {}): Promise<string> {
    if (!o.force && this.token && this.token.expiresAt - 60_000 > this.clock()) return this.token.value;
    this.token = null;
    return this.refresh(o.signal);
  }

  async userId(): Promise<string> {
    const s = this.current() ?? (await this.fromBrowser());
    return s.uid;
  }

  /** Forget the cached ID token and session (tests, or after the owner switched accounts). */
  reset(): void {
    this.token = null;
    this.loaded = false;
    this.session = null;
  }
}
