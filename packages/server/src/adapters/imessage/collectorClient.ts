/**
 * Client for the signed collector's loopback API v1 (architecture §1a). Bearer token from the 0600 token file the
 * collector writes on first launch: read lazily, re-read once after a 401. A missing token file or a refused
 * connection is CollectorUnavailableError (callers skip and retry on the next tick). Every response is validated
 * with the @yb/shared zod contract; a mismatch is CollectorContractError. Errors carry codes and counts only:
 * never response bodies, which hold message text.
 */
import fs from 'node:fs/promises';
import {
  ChatsQuery,
  ChatsResponse,
  COLLECTOR_ROUTES,
  CollectorError,
  EditedQuery,
  EditedResponse,
  HandlesResponse,
  Health,
  MessagesByDateQuery,
  MessagesQuery,
  MessagesResponse,
} from '@yb/shared/collector/v1';
import { Agent, request, type Dispatcher } from 'undici';
import type { z } from 'zod';

export class CollectorUnavailableError extends Error {
  constructor(
    readonly reason: 'token_missing' | 'unreachable' | 'timeout',
    message: string,
  ) {
    super(message);
    this.name = 'CollectorUnavailableError';
  }
}

export class CollectorHttpError extends Error {
  constructor(
    readonly status: number,
    /** The collector's error code (fda_missing, chatdb_unavailable, unauthorized, …) or "http_<status>". */
    readonly code: string,
  ) {
    super(`collector returned HTTP ${status} (${code})`);
    this.name = 'CollectorHttpError';
  }
}

export class CollectorContractError extends Error {
  constructor(
    readonly route: string,
    readonly issues: number,
    readonly paths: string[],
  ) {
    super(`collector response for ${route} broke the v1 contract (${issues} issue(s) at ${paths.slice(0, 5).join(', ') || 'root'})`);
    this.name = 'CollectorContractError';
  }
}

export interface CollectorClientOptions {
  baseUrl: string;
  tokenFile: string;
  /** undici dispatcher (tests pass a MockAgent). Defaults to a private keep-alive Agent. */
  dispatcher?: Dispatcher;
  timeoutMs?: number;
}

const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENOTFOUND', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED']);
const TIMEOUT_CODES = new Set(['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ABORT_ERR']);

function query(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
}

export class CollectorClient {
  private token: string | null = null;
  private readonly dispatcher: Dispatcher;
  private readonly timeoutMs: number;
  private readonly base: string;

  constructor(private readonly o: CollectorClientOptions) {
    this.base = o.baseUrl.replace(/\/+$/, '');
    this.dispatcher = o.dispatcher ?? new Agent({ keepAliveTimeout: 10_000, connections: 4 });
    this.timeoutMs = o.timeoutMs ?? 60_000;
  }

  private async readToken(): Promise<string> {
    let raw: string;
    try {
      raw = await fs.readFile(this.o.tokenFile, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new CollectorUnavailableError('token_missing', 'collector token file does not exist yet (is the collector installed?)');
      }
      throw e;
    }
    const token = raw.trim();
    if (!token) throw new CollectorUnavailableError('token_missing', 'collector token file is empty');
    this.token = token;
    return token;
  }

  private async send(path: string): Promise<{ status: number; body: unknown }> {
    const token = this.token ?? (await this.readToken());
    let res: Dispatcher.ResponseData;
    try {
      res = await request(`${this.base}${path}`, {
        method: 'GET',
        dispatcher: this.dispatcher,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        headersTimeout: this.timeoutMs,
        bodyTimeout: this.timeoutMs,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? (e as Error).name;
      if (NETWORK_CODES.has(code)) throw new CollectorUnavailableError('unreachable', `collector is not reachable (${code})`);
      if (TIMEOUT_CODES.has(code) || (e as Error).name === 'TimeoutError') {
        throw new CollectorUnavailableError('timeout', 'collector request timed out');
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
    return { status: res.statusCode, body };
  }

  /** GET with one token re-read on 401, then contract validation. */
  private async get<S extends z.ZodType>(route: string, path: string, schema: S): Promise<z.output<S>> {
    let r = await this.send(path);
    if (r.status === 401) {
      this.token = null;
      r = await this.send(path);
    }
    if (r.status < 200 || r.status >= 300) {
      const err = CollectorError.safeParse(r.body);
      throw new CollectorHttpError(r.status, err.success ? err.data.error.code : `http_${r.status}`);
    }
    const parsed = schema.safeParse(r.body);
    if (!parsed.success) {
      const paths = [...new Set(parsed.error.issues.map((i) => i.path.map((p) => (typeof p === 'number' ? '#' : String(p))).join('.')))];
      throw new CollectorContractError(route, parsed.error.issues.length, paths);
    }
    return parsed.data;
  }

  health() {
    return this.get('health', COLLECTOR_ROUTES.health, Health);
  }

  messages(q: MessagesQuery) {
    const p = MessagesQuery.parse(q);
    return this.get('messages', `${COLLECTOR_ROUTES.imessageMessages}${query(p)}`, MessagesResponse);
  }

  messagesByDate(q: MessagesByDateQuery) {
    const p = MessagesByDateQuery.parse(q);
    return this.get('messages_by_date', `${COLLECTOR_ROUTES.imessageMessagesByDate}${query(p)}`, MessagesResponse);
  }

  edited(q: EditedQuery) {
    const p = EditedQuery.parse(q);
    return this.get('edited', `${COLLECTOR_ROUTES.imessageEdited}${query(p)}`, EditedResponse);
  }

  chats(q: ChatsQuery = {}) {
    const p = ChatsQuery.parse(q);
    return this.get('chats', `${COLLECTOR_ROUTES.imessageChats}${query(p)}`, ChatsResponse);
  }

  handles() {
    return this.get('handles', COLLECTOR_ROUTES.imessageHandles, HandlesResponse);
  }

  async close(): Promise<void> {
    if (!this.o.dispatcher) await this.dispatcher.close();
  }
}
