/**
 * Client for the collector's POST /v1/vision/ocr (design §3 "OCR"): on-device Apple Vision text recognition of one
 * screenshot the gphotos job downloaded. Same conventions as adapters/imessage/collectorClient.ts: loopback only,
 * the Bearer token from the collector's 0600 token file read lazily and re-read once after a 401, every response
 * validated with the @yb/shared zod contract (OcrResponse), typed errors with codes and counts only, 60 s timeout.
 *   - 404 not_found (a collector from before the OCR route) → OcrRouteMissingError: the files wait.
 *   - 413 → OcrRouteMissingError when a tiny probe also gets 404 (an old collector refuses any body over 1 MiB
 *     before it routes), else CollectorHttpError(413, 'payload_too_large'): a final failure for that image.
 *   - Other non-2xx → CollectorHttpError(status, code); a refused connection or missing token →
 *     CollectorUnavailableError.
 * The image and the recognized text never appear in an error, a log line or anything sent elsewhere: OCR output
 * stays in this process and never reaches an LLM.
 */
import fs from 'node:fs/promises';
import { COLLECTOR_ROUTES, CollectorError, OcrResponse } from '@yb/shared/collector/v1';
import { Agent, request, type Dispatcher } from 'undici';
import { CollectorContractError, CollectorHttpError, CollectorUnavailableError } from '../adapters/imessage/collectorClient';

export { CollectorContractError, CollectorHttpError, CollectorUnavailableError };

/** The collector has no /v1/vision/ocr yet: update it (the screenshots wait). */
export class OcrRouteMissingError extends Error {
  constructor() {
    super('the collector has no OCR route (update the collector)');
    this.name = 'OcrRouteMissingError';
  }
}

export interface OcrClientOptions {
  baseUrl: string;
  tokenFile: string;
  /** undici dispatcher (tests pass a MockAgent). Defaults to a private keep-alive Agent. */
  dispatcher?: Dispatcher;
  timeoutMs?: number;
}

/** What the gphotos job needs from an OCR client (tests may substitute it). */
export interface ScreenshotOcr {
  ocr(image: Buffer, o?: { maxLines?: number }): Promise<OcrResponse>;
  close(): Promise<void>;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENOTFOUND', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED']);
const TIMEOUT_CODES = new Set(['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ABORT_ERR']);
const DEFAULT_MAX_LINES = 200;

export class OcrClient implements ScreenshotOcr {
  private token: string | null = null;
  private readonly dispatcher: Dispatcher;
  private readonly timeoutMs: number;
  private readonly base: string;

  constructor(private readonly o: OcrClientOptions) {
    const url = new URL(o.baseUrl);
    if (!LOOPBACK.has(url.hostname) || url.protocol !== 'http:') throw new Error('the collector must be on loopback');
    this.base = o.baseUrl.replace(/\/+$/, '');
    this.dispatcher = o.dispatcher ?? new Agent({ keepAliveTimeout: 10_000, connections: 2 });
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

  private async post(body: string): Promise<{ status: number; body: unknown }> {
    const token = this.token ?? (await this.readToken());
    let res: Dispatcher.ResponseData;
    try {
      res = await request(`${this.base}${COLLECTOR_ROUTES.visionOcr}`, {
        method: 'POST',
        dispatcher: this.dispatcher,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json' },
        body,
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
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    return { status: res.statusCode, body: parsed };
  }

  /** POST with one token re-read on 401. */
  private async send(body: string): Promise<{ status: number; body: unknown }> {
    let r = await this.post(body);
    if (r.status === 401) {
      this.token = null;
      r = await this.post(body);
    }
    return r;
  }

  private static errorCode(r: { status: number; body: unknown }): string {
    const err = CollectorError.safeParse(r.body);
    return err.success && /^[a-z0-9_]{1,40}$/.test(err.data.error.code) ? err.data.error.code : `http_${r.status}`;
  }

  /** A 404 for an unknown route (the collector's not_found, or no error body at all). */
  private static routeMissing(r: { status: number; body: unknown }): boolean {
    if (r.status !== 404) return false;
    const code = OcrClient.errorCode(r);
    return code === 'not_found' || code === 'http_404';
  }

  /** Does this collector route /v1/vision/ocr at all? A deliberately invalid tiny body: only a route 404 says no. */
  async routeAvailable(): Promise<boolean> {
    return !OcrClient.routeMissing(await this.send('{}'));
  }

  /** Recognized lines of one image (JPEG/PNG/HEIC/WebP bytes), top to bottom. */
  async ocr(image: Buffer, o: { maxLines?: number } = {}): Promise<OcrResponse> {
    const body = JSON.stringify({ data_base64: image.toString('base64'), max_lines: o.maxLines ?? DEFAULT_MAX_LINES });
    const r = await this.send(body);
    if (OcrClient.routeMissing(r)) throw new OcrRouteMissingError();
    if (r.status === 413) {
      if (!(await this.routeAvailable())) throw new OcrRouteMissingError();
      throw new CollectorHttpError(413, 'payload_too_large');
    }
    if (r.status < 200 || r.status >= 300) throw new CollectorHttpError(r.status, OcrClient.errorCode(r));
    const parsed = OcrResponse.safeParse(r.body);
    if (!parsed.success) {
      const paths = [...new Set(parsed.error.issues.map((i) => i.path.map((p) => (typeof p === 'number' ? '#' : String(p))).join('.')))];
      throw new CollectorContractError('vision_ocr', parsed.error.issues.length, paths);
    }
    return parsed.data;
  }

  async close(): Promise<void> {
    if (!this.o.dispatcher) await this.dispatcher.close();
  }
}
