/**
 * GET-only client for the Beeper Desktop API v1 on loopback (PLAN "Ingestion → Instagram → Beeper adapter").
 * Read-only is enforced twice:
 *   1. the client only has GET methods, and every path is checked against BEEPER_GET_ALLOWLIST;
 *   2. its undici dispatcher carries readOnlyInterceptor(), which throws BeeperReadOnlyError for any request that
 *      is not a GET to an allowlisted path on the Beeper origin, so nothing sharing the dispatcher (or a future
 *      method) can send, edit, react, archive or mark read.
 * Responses are validated tolerantly (schemas.ts). Errors carry status codes, route names and validation paths
 * only: never response bodies (they hold message text) and never the token.
 */
import { Agent, request, type Dispatcher } from 'undici';
import type { z } from 'zod';
import {
  BeeperAccount,
  BeeperChat,
  BeeperMessage,
  BeeperPage,
  BeeperUser,
  parseItems,
  type Page,
} from './schemas';

export class BeeperReadOnlyError extends Error {
  constructor(
    readonly method: string,
    readonly route: string,
  ) {
    super(`refused ${method} ${route}: the Beeper client is read-only (GET on allowlisted paths only)`);
    this.name = 'BeeperReadOnlyError';
  }
}

export class BeeperUnavailableError extends Error {
  constructor(
    readonly reason: 'unreachable' | 'timeout',
    message: string,
  ) {
    super(message);
    this.name = 'BeeperUnavailableError';
  }
}

export class BeeperHttpError extends Error {
  constructor(
    readonly status: number,
    readonly route: string,
    /** Beeper's error code when the body carried one, else "http_<status>". */
    readonly code: string,
  ) {
    super(`Beeper ${route} returned HTTP ${status} (${code})`);
    this.name = 'BeeperHttpError';
  }
}

export class BeeperContractError extends Error {
  constructor(
    readonly route: string,
    readonly issues: number,
    readonly paths: string[],
  ) {
    super(`Beeper ${route} response broke the expected shape (${issues} issue(s) at ${paths.slice(0, 5).join(', ') || 'root'})`);
    this.name = 'BeeperContractError';
  }
}

/** The only routes this client may call (path without query; ids are URI-encoded so never contain '/'). */
export const BEEPER_GET_ALLOWLIST: readonly RegExp[] = [
  /^\/v1\/info$/,
  /^\/v1\/accounts$/,
  /^\/v1\/accounts\/[^/]+$/,
  /^\/v1\/accounts\/[^/]+\/contacts\/list$/,
  /^\/v1\/chats$/,
  /^\/v1\/chats\/(?!search$|start$)[^/]+$/,
  /^\/v1\/chats\/[^/]+\/messages$/,
];

export const isAllowedBeeperPath = (pathWithQuery: string): boolean => {
  const p = pathWithQuery.split('?')[0] ?? '';
  return BEEPER_GET_ALLOWLIST.some((r) => r.test(p));
};

const originOf = (u: string | URL): string | null => {
  try {
    return new URL(String(u)).origin;
  } catch {
    return null;
  }
};

/**
 * undici interceptor: only GET requests to allowlisted paths on `origin` pass; anything else (another method,
 * another path, another host) throws before a byte is sent.
 */
export function readOnlyInterceptor(origin: string): Dispatcher.DispatcherComposeInterceptor {
  const allowed = originOf(origin);
  if (!allowed) throw new Error('readOnlyInterceptor: invalid origin');
  return (dispatch) => (opts, handler) => {
    const method = String(opts.method ?? 'GET').toUpperCase();
    const target = opts.origin ? originOf(opts.origin) : allowed;
    const route = String(opts.path ?? '').split('?')[0] ?? '';
    if (method !== 'GET' || target !== allowed || !isAllowedBeeperPath(String(opts.path ?? ''))) {
      throw new BeeperReadOnlyError(method, target === allowed ? route : '(other origin)');
    }
    return dispatch(opts, handler);
  };
}

/** A dispatcher whose every request goes through readOnlyInterceptor(origin). */
export const readOnlyDispatcher = (base: Dispatcher, origin: string): Dispatcher => base.compose(readOnlyInterceptor(origin));

export interface BeeperClientOptions {
  baseUrl: string;
  /** Bearer token (or a provider, read per request). Never logged. */
  token: string | (() => string | null);
  /** Base undici dispatcher (tests pass a MockAgent); the read-only interceptor is always added on top. */
  dispatcher?: Dispatcher;
  timeoutMs?: number;
}

export type Direction = 'before' | 'after';

export interface CursorQuery {
  cursor?: string | null;
  direction?: Direction;
}

export interface ChatsQuery extends CursorQuery {
  accountIDs?: readonly string[];
  /** 1–200 (Beeper default 25). */
  limit?: number;
}

const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENOTFOUND', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED']);
const TIMEOUT_CODES = new Set(['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ABORT_ERR']);

const enc = encodeURIComponent;

function queryString(q: Record<string, string | number | readonly string[] | null | undefined>): string {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null) continue;
    // Arrays repeat the key (accountIDs=a&accountIDs=b), as Beeper's own SDK sends them.
    if (Array.isArray(v)) for (const x of v) s.append(k, String(x));
    else s.set(k, String(v));
  }
  const out = s.toString();
  return out ? `?${out}` : '';
}

const issuePaths = (e: z.ZodError) => [...new Set(e.issues.map((i) => i.path.map((p) => (typeof p === 'number' ? '#' : String(p))).join('.')))];

export class BeeperClient {
  readonly origin: string;
  /** GET requests sent (successful or not): ingest passes budget on it. */
  requests = 0;
  private readonly base: string;
  private readonly dispatcher: Dispatcher;
  private readonly ownDispatcher: Agent | null;
  private readonly timeoutMs: number;

  constructor(private readonly o: BeeperClientOptions) {
    this.base = o.baseUrl.replace(/\/+$/, '');
    const origin = originOf(this.base);
    if (!origin) throw new Error('Beeper base URL is invalid');
    this.origin = origin;
    this.ownDispatcher = o.dispatcher ? null : new Agent({ keepAliveTimeout: 10_000, connections: 2 });
    this.dispatcher = readOnlyDispatcher(o.dispatcher ?? this.ownDispatcher!, origin);
    this.timeoutMs = o.timeoutMs ?? 30_000;
  }

  private token(): string | null {
    return typeof this.o.token === 'function' ? this.o.token() : this.o.token;
  }

  /** The one network method: GET on an allowlisted path, JSON body or a typed error. */
  private async getJson(route: string, pathWithQuery: string): Promise<unknown> {
    if (!isAllowedBeeperPath(pathWithQuery)) throw new BeeperReadOnlyError('GET', route);
    const token = this.token();
    if (!token) throw new BeeperHttpError(401, route, 'token_missing');
    this.requests++;
    let res: Dispatcher.ResponseData;
    try {
      res = await request(`${this.base}${pathWithQuery}`, {
        method: 'GET',
        dispatcher: this.dispatcher,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        headersTimeout: this.timeoutMs,
        bodyTimeout: this.timeoutMs,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      if (e instanceof BeeperReadOnlyError) throw e;
      const code = (e as NodeJS.ErrnoException).code ?? (e as Error).name;
      if (NETWORK_CODES.has(code)) throw new BeeperUnavailableError('unreachable', `Beeper Desktop API is not reachable (${code})`);
      if (TIMEOUT_CODES.has(code) || (e as Error).name === 'TimeoutError') {
        throw new BeeperUnavailableError('timeout', 'Beeper Desktop API request timed out');
      }
      throw e;
    }
    const text = await res.body.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      const code = body && typeof body === 'object' && typeof (body as { code?: unknown }).code === 'string' ? (body as { code: string }).code : null;
      throw new BeeperHttpError(res.statusCode, route, code && /^[\w.-]{1,40}$/.test(code) ? code : `http_${res.statusCode}`);
    }
    return body;
  }

  private async page<S extends z.ZodType>(route: string, path: string, item: S): Promise<Page<z.output<S>>> {
    const body = await this.getJson(route, path);
    const p = BeeperPage.safeParse(body);
    if (!p.success) throw new BeeperContractError(route, p.error.issues.length, issuePaths(p.error));
    const parsed = parseItems(item, p.data.items);
    // A non-empty page none of whose items parse means the shape changed, not one odd item.
    if (parsed.items.length === 0 && parsed.invalid > 0) throw new BeeperContractError(route, parsed.invalid, parsed.paths);
    return {
      items: parsed.items,
      hasMore: p.data.hasMore ?? false,
      oldestCursor: p.data.oldestCursor ?? null,
      newestCursor: p.data.newestCursor ?? null,
      invalid: parsed.invalid,
    };
  }

  /** Every connected chat account (all networks; the ingest keeps Instagram only). */
  async accounts(): Promise<{ items: z.output<typeof BeeperAccount>[]; invalid: number }> {
    const body = await this.getJson('accounts', '/v1/accounts');
    // The list is a bare array; tolerate an { items } wrapper too.
    const raw = Array.isArray(body) ? body : body && typeof body === 'object' && Array.isArray((body as { items?: unknown }).items) ? (body as { items: unknown[] }).items : null;
    if (!raw) throw new BeeperContractError('accounts', 1, ['root']);
    const parsed = parseItems(BeeperAccount, raw);
    if (parsed.items.length === 0 && parsed.invalid > 0) throw new BeeperContractError('accounts', parsed.invalid, parsed.paths);
    return { items: parsed.items, invalid: parsed.invalid };
  }

  /** Chats by last activity, most recent first; participants are capped (~20) per chat here. */
  chats(q: ChatsQuery = {}) {
    const limit = q.limit === undefined ? undefined : Math.min(200, Math.max(1, Math.trunc(q.limit)));
    const qs = queryString({ accountIDs: q.accountIDs, cursor: q.cursor, direction: q.cursor ? (q.direction ?? 'before') : undefined, limit });
    return this.page('chats', `/v1/chats${qs}`, BeeperChat);
  }

  /** One chat with up to `maxParticipantCount` participants (-1 = all, else 0–500). */
  async chat(chatId: string, o: { maxParticipantCount?: number } = {}) {
    const body = await this.getJson('chat', `/v1/chats/${enc(chatId)}${queryString({ maxParticipantCount: o.maxParticipantCount })}`);
    const p = BeeperChat.safeParse(body);
    if (!p.success) throw new BeeperContractError('chat', p.error.issues.length, issuePaths(p.error));
    return p.data;
  }

  /** A page of a chat's messages (newest page without a cursor; 'before' = older, 'after' = newer). */
  messages(chatId: string, q: CursorQuery = {}) {
    const qs = queryString({ cursor: q.cursor, direction: q.cursor ? (q.direction ?? 'before') : undefined });
    return this.page('messages', `/v1/chats/${enc(chatId)}/messages${qs}`, BeeperMessage);
  }

  /** Merged contacts of one account (local lookup only; the network-searching /contacts route is never called). */
  contacts(accountId: string, q: CursorQuery & { limit?: number } = {}) {
    const qs = queryString({ cursor: q.cursor, direction: q.cursor ? (q.direction ?? 'before') : undefined, limit: q.limit });
    return this.page('contacts', `/v1/accounts/${enc(accountId)}/contacts/list${qs}`, BeeperUser);
  }

  async close(): Promise<void> {
    await this.ownDispatcher?.close();
  }
}
