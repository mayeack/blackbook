/**
 * GET /v1/contacts on the signed collector (architecture §1a): the full CNContactStore dump plus a content hash.
 * Same transport rules as the iMessage CollectorClient (Bearer token from the 0600 file, read lazily and re-read
 * once after a 401; zod contract from @yb/shared; errors carry codes and counts, never bodies). The collector owns
 * the Contacts permission: a denied permission comes back as `contacts_denied`.
 */
import fs from 'node:fs/promises';
import { COLLECTOR_ROUTES, CollectorError, ContactsResponse } from '@yb/shared/collector/v1';
import { Agent, request, type Dispatcher } from 'undici';
import { CollectorContractError, CollectorHttpError, CollectorUnavailableError } from '../imessage/collectorClient';

export interface ContactsSource {
  contacts(): Promise<ContactsResponse>;
}

export interface ContactsClientOptions {
  baseUrl: string;
  tokenFile: string;
  /** undici dispatcher (tests pass a MockAgent). */
  dispatcher?: Dispatcher;
  timeoutMs?: number;
}

const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENOTFOUND', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED']);
const TIMEOUT_CODES = new Set(['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ABORT_ERR']);

export class ContactsClient implements ContactsSource {
  private token: string | null = null;
  private readonly dispatcher: Dispatcher;
  private readonly base: string;
  private readonly timeoutMs: number;

  constructor(private readonly o: ContactsClientOptions) {
    this.base = o.baseUrl.replace(/\/+$/, '');
    this.dispatcher = o.dispatcher ?? new Agent({ keepAliveTimeout: 10_000, connections: 1 });
    this.timeoutMs = o.timeoutMs ?? 120_000;
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
    return (this.token = token);
  }

  private async send(): Promise<{ status: number; body: unknown }> {
    const token = this.token ?? (await this.readToken());
    let res: Dispatcher.ResponseData;
    try {
      res = await request(`${this.base}${COLLECTOR_ROUTES.contacts}`, {
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
      if (TIMEOUT_CODES.has(code) || (e as Error).name === 'TimeoutError') throw new CollectorUnavailableError('timeout', 'collector request timed out');
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

  async contacts(): Promise<ContactsResponse> {
    let r = await this.send();
    if (r.status === 401) {
      this.token = null;
      r = await this.send();
    }
    if (r.status < 200 || r.status >= 300) {
      const err = CollectorError.safeParse(r.body);
      throw new CollectorHttpError(r.status, err.success ? err.data.error.code : `http_${r.status}`);
    }
    const parsed = ContactsResponse.safeParse(r.body);
    if (!parsed.success) {
      const paths = [...new Set(parsed.error.issues.map((i) => i.path.map((p) => (typeof p === 'number' ? '#' : String(p))).join('.')))];
      throw new CollectorContractError('contacts', parsed.error.issues.length, paths);
    }
    return parsed.data;
  }

  async close(): Promise<void> {
    if (!this.o.dispatcher) await this.dispatcher.close();
  }
}
