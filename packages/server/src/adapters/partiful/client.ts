/**
 * Read-only client for Partiful's Firebase callable functions: POST https://api.partiful.com/<fn> with
 * {data:{params, paging?, userId}} and a Bearer Firebase ID token, browser-like headers (Origin/Referer
 * partiful.com). Every Partiful function is a POST, so method filtering can't keep writes out: a HARD-CODED
 * allowlist of read functions does, and any other name throws before anything is sent. Responses are unwrapped
 * ({result:{data}}, {result}, or a bare array) and validated tolerantly by the callers (schemas.ts).
 * Politeness: ≤1 request per second (a RateGate shared by every job of the process) and ≤300 calls per run.
 * Nothing here logs; errors carry function names, statuses and Firebase codes only.
 */
import { request, type Dispatcher } from 'undici';
import {
  PartifulAuthRequiredError,
  PartifulBudgetError,
  PartifulCallError,
  PartifulContractError,
  PartifulForbiddenFunctionError,
  PartifulHttpError,
  PartifulRateLimitedError,
} from './errors';
import { BROWSER_USER_AGENT, PARTIFUL_ORIGIN, transportCode, type TokenSource } from './session';

export const PARTIFUL_API = 'https://api.partiful.com';

/** The only functions this adapter may ever call (PLAN "Hard-coded read-only function allowlist"). */
export const PARTIFUL_READ_FUNCTIONS = Object.freeze([
  'getMyRsvps',
  'getMyUpcomingEventsForHomePage',
  'getMyPastEventsForHomePage',
  'getPublishedEvents',
  'getEventInfo',
  'getGuests',
  'getUsers',
  'getContacts',
  'getMutuals',
] as const);
export type PartifulReadFunction = (typeof PARTIFUL_READ_FUNCTIONS)[number];

const ALLOWED: ReadonlySet<string> = new Set(PARTIFUL_READ_FUNCTIONS);

export function assertReadFunction(fn: string): asserts fn is PartifulReadFunction {
  if (typeof fn !== 'string' || !ALLOWED.has(fn)) throw new PartifulForbiddenFunctionError(String(fn));
}

export const DEFAULT_MIN_INTERVAL_MS = 1000;
export const DEFAULT_MAX_CALLS = 300;

/** Spaces request starts at least `minIntervalMs` apart (shared across runs and jobs). */
export class RateGate {
  private next = 0;
  constructor(
    readonly minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
    private readonly t: { now(): number; sleep(ms: number, signal?: AbortSignal): Promise<void> } = {
      now: Date.now,
      sleep: (ms, signal) =>
        new Promise<void>((resolve, reject) => {
          if (signal?.aborted) return reject(signal.reason);
          const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
          }, ms);
          const onAbort = () => {
            clearTimeout(timer);
            reject(signal?.reason);
          };
          signal?.addEventListener('abort', onAbort, { once: true });
        }),
    },
  ) {}

  async wait(signal?: AbortSignal): Promise<void> {
    const now = this.t.now();
    const at = Math.max(now, this.next);
    this.next = at + this.minIntervalMs;
    if (at > now) await this.t.sleep(at - now, signal);
  }
}

export interface Paging {
  cursor?: string | null;
  maxResults?: number;
}

export interface CallResult {
  data: unknown;
  /** The cursor for the next page, when the response carries one. */
  nextCursor: string | null;
}

export interface PartifulClientOptions {
  auth: TokenSource;
  dispatcher?: Dispatcher;
  gate?: RateGate;
  /** Per-run call budget (default 300). */
  maxCalls?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function cursorOf(...candidates: unknown[]): string | null {
  for (const c of candidates) {
    if (!isObj(c)) continue;
    const v = c.nextCursor ?? c.cursor ?? c.next;
    if (typeof v === 'string' && v) return v;
    if (typeof v === 'number') return String(v);
  }
  return null;
}

/** Firebase callable envelope → payload: {result:{data, paging?}} | {result} | a bare array (getPublishedEvents). */
export function unwrapEnvelope(fn: string, body: unknown): CallResult {
  if (Array.isArray(body)) return { data: body, nextCursor: null };
  if (!isObj(body) || !('result' in body)) throw new PartifulContractError(fn, 'response envelope');
  const result = body.result;
  if (isObj(result) && 'data' in result) {
    return { data: result.data, nextCursor: cursorOf(result.paging, isObj(result.data) ? result.data.paging : undefined) };
  }
  return { data: result, nextCursor: cursorOf(isObj(result) ? result.paging : undefined) };
}

const CODE_BY_STATUS: Record<number, string> = { 400: 'INVALID_ARGUMENT', 403: 'PERMISSION_DENIED', 404: 'NOT_FOUND', 409: 'ABORTED' };

export class PartifulClient {
  private calls = 0;
  readonly callsByFn: Record<string, number> = {};
  private readonly gate: RateGate;
  readonly maxCalls: number;

  constructor(private readonly o: PartifulClientOptions) {
    this.gate = o.gate ?? new RateGate();
    this.maxCalls = o.maxCalls ?? DEFAULT_MAX_CALLS;
  }

  get callCount(): number {
    return this.calls;
  }

  get remaining(): number {
    return Math.max(0, this.maxCalls - this.calls);
  }

  userId(): Promise<string> {
    return this.o.auth.userId();
  }

  /** One allowlisted read call. Re-mints the ID token once on a 401. */
  async call(fn: PartifulReadFunction, params: Record<string, unknown> = {}, paging?: Paging): Promise<CallResult> {
    assertReadFunction(fn);
    const userId = await this.o.auth.userId();
    let token = await this.o.auth.idToken({ signal: this.o.signal });
    let res = await this.send(fn, token, { params, ...(paging ? { paging } : {}), userId });
    if (res.status === 401) {
      token = await this.o.auth.idToken({ force: true, signal: this.o.signal });
      res = await this.send(fn, token, { params, ...(paging ? { paging } : {}), userId });
      if (res.status === 401) throw new PartifulAuthRequiredError('api_unauthorized');
    }
    const errCode = isObj(res.body) && isObj(res.body.error) && typeof res.body.error.status === 'string' ? res.body.error.status : null;
    if (res.status >= 200 && res.status < 300) {
      if (errCode) throw new PartifulCallError(fn, res.status, errCode);
      return unwrapEnvelope(fn, res.body);
    }
    if (res.status === 429) throw new PartifulRateLimitedError(fn);
    if (errCode === 'UNAUTHENTICATED') throw new PartifulAuthRequiredError('api_unauthorized');
    if (res.status >= 500) throw new PartifulHttpError(fn, res.status, `http_${res.status}`);
    // A 404 without a callable error body is the function itself missing (renamed or retired).
    if (res.status === 404 && !errCode) throw new PartifulContractError(fn, 'function not found (HTTP 404)');
    throw new PartifulCallError(fn, res.status, errCode ?? CODE_BY_STATUS[res.status] ?? `HTTP_${res.status}`);
  }

  /** Every page of a paged call (cursor loop), up to `maxPages`. */
  async *pages(fn: PartifulReadFunction, params: Record<string, unknown>, o: { maxResults?: number; maxPages?: number } = {}): AsyncGenerator<CallResult> {
    let cursor: string | null = null;
    for (let page = 0; page < (o.maxPages ?? 20); page++) {
      const r: CallResult = await this.call(fn, params, { ...(cursor ? { cursor } : {}), maxResults: o.maxResults ?? 500 });
      yield r;
      if (!r.nextCursor || r.nextCursor === cursor) return;
      cursor = r.nextCursor;
    }
  }

  private async send(fn: string, token: string, data: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
    if (this.calls >= this.maxCalls) throw new PartifulBudgetError(this.maxCalls);
    await this.gate.wait(this.o.signal);
    this.calls++;
    this.callsByFn[fn] = (this.callsByFn[fn] ?? 0) + 1;
    const timeoutMs = this.o.timeoutMs ?? 60_000;
    let res: Dispatcher.ResponseData;
    try {
      res = await request(`${PARTIFUL_API}/${fn}`, {
        method: 'POST',
        ...(this.o.dispatcher ? { dispatcher: this.o.dispatcher } : {}),
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json',
          origin: PARTIFUL_ORIGIN,
          referer: `${PARTIFUL_ORIGIN}/`,
          'user-agent': BROWSER_USER_AGENT,
        },
        body: JSON.stringify({ data }),
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
        signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(this.o.signal ? [this.o.signal] : [])]),
      });
    } catch (e) {
      throw new PartifulHttpError(fn, null, transportCode(e));
    }
    let body: unknown = null;
    try {
      const text = await res.body.text();
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: res.statusCode, body };
  }
}
