/**
 * Collector calls for WhatsApp: POST /v1/whatsapp/snapshot (consistent copies of ChatStorage, ContactsV2 and LID
 * under $DATA/snapshots/whatsapp/<ts>/, `unchanged:true` with the previous directory when nothing moved) and
 * GET /v1/health (is WhatsApp for Mac running). Same rules as imessage/collectorClient.ts, which is GET-only: the
 * Bearer token comes from the 0600 token file, re-read once after a 401; responses are validated with the
 * @yb/shared contract; errors carry codes, never bodies.
 */
import fs from 'node:fs/promises';
import {
  COLLECTOR_ROUTES,
  CollectorError,
  Health,
  WhatsAppSnapshotRequest,
  WhatsAppSnapshotResponse,
} from '@yb/shared/collector/v1';
import { Agent, request, type Dispatcher } from 'undici';
import type { z } from 'zod';
import { CollectorContractError, CollectorHttpError, CollectorUnavailableError } from '../imessage/collectorClient';

export { CollectorContractError, CollectorHttpError, CollectorUnavailableError };

/** What the whatsapp job needs from the collector (tests pass a fake). */
export interface WhatsAppCollectorApi {
  snapshot(req?: WhatsAppSnapshotRequest): Promise<WhatsAppSnapshotResponse>;
  health(): Promise<Health>;
}

export interface WhatsAppCollectorOptions {
  baseUrl: string;
  tokenFile: string;
  dispatcher?: Dispatcher;
  /** The collector copies and checks the stores before answering: allow for a large ChatStorage. */
  timeoutMs?: number;
}

const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENOTFOUND', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED']);
const TIMEOUT_CODES = new Set(['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ABORT_ERR']);

export class WhatsAppCollector implements WhatsAppCollectorApi {
  private token: string | null = null;
  private readonly dispatcher: Dispatcher;
  private readonly base: string;
  private readonly timeoutMs: number;

  constructor(private readonly o: WhatsAppCollectorOptions) {
    this.base = o.baseUrl.replace(/\/+$/, '');
    this.dispatcher = o.dispatcher ?? new Agent({ keepAliveTimeout: 10_000, connections: 2 });
    this.timeoutMs = o.timeoutMs ?? 180_000;
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

  private async send(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
    const token = this.token ?? (await this.readToken());
    const payload = body === undefined ? undefined : JSON.stringify(body);
    let res: Dispatcher.ResponseData;
    try {
      res = await request(`${this.base}${path}`, {
        method,
        dispatcher: this.dispatcher,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) }),
        },
        body: payload,
        headersTimeout: this.timeoutMs,
        bodyTimeout: this.timeoutMs,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? (e as Error).name;
      if (NETWORK_CODES.has(code)) throw new CollectorUnavailableError('unreachable', `collector is not reachable (${code})`);
      if (TIMEOUT_CODES.has(code) || (e as Error).name === 'TimeoutError') throw new CollectorUnavailableError('timeout', 'collector request timed out');
      throw e;
    }
    const text = await res.body.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    return { status: res.statusCode, body: parsed };
  }

  private async call<S extends z.ZodType>(route: string, method: 'GET' | 'POST', path: string, schema: S, body?: unknown): Promise<z.output<S>> {
    let r = await this.send(method, path, body);
    if (r.status === 401) {
      this.token = null;
      r = await this.send(method, path, body);
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

  snapshot(req: WhatsAppSnapshotRequest = {}): Promise<WhatsAppSnapshotResponse> {
    return this.call('whatsapp_snapshot', 'POST', COLLECTOR_ROUTES.whatsappSnapshot, WhatsAppSnapshotResponse, WhatsAppSnapshotRequest.parse(req));
  }

  health(): Promise<Health> {
    return this.call('health', 'GET', COLLECTOR_ROUTES.health, Health);
  }

  async close(): Promise<void> {
    if (!this.o.dispatcher) await this.dispatcher.close();
  }
}
