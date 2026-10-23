/**
 * The collector's POST /v1/vision/ocr behind an undici MockAgent (net connect disabled). Images are placeholder
 * buffers `fakeimg:<scenario>`; the fake answers that scenario's synthetic lines. `version: 'old'` acts like a
 * collector from before the OCR route: any body over 1 MiB is a 413 before routing, everything else a 404
 * not_found. Requests record their size and status only.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { OcrLine } from '@yb/shared/collector/v1';
import { MockAgent } from 'undici';

export const COLLECTOR = 'http://127.0.0.1:4321';
export const COLLECTOR_TOKEN = 'test-collector-token';
const MiB = 1024 * 1024;

const json = (statusCode: number, data: unknown) => ({ statusCode, data: JSON.stringify(data), responseOptions: { headers: { 'content-type': 'application/json' } } });
const err = (statusCode: number, code: string) => json(statusCode, { error: { code, message: code.replace(/_/g, ' ') } });

const headerValue = (headers: unknown, name: string): string | undefined => {
  if (!headers) return undefined;
  if (Array.isArray(headers)) {
    for (let i = 0; i < headers.length; i += 2) if (String(headers[i]).toLowerCase() === name) return String(headers[i + 1]);
    return undefined;
  }
  const rec = headers as Record<string, string | string[]>;
  const key = Object.keys(rec).find((k) => k.toLowerCase() === name);
  const v = key ? rec[key] : undefined;
  return Array.isArray(v) ? v[0] : v;
};

export class FakeOcrCollector {
  readonly agent = new MockAgent();
  readonly requests: { path: string; status: number; bytes: number }[] = [];
  version: 'new' | 'old' = 'new';
  token = COLLECTOR_TOKEN;
  /** scenario → the error to answer instead of lines. */
  readonly failures = new Map<string, { status: number; code: string }>();
  /** Answer 200 with this (malformed) body for every OCR call while set. */
  malformed: unknown = null;

  constructor(readonly scenarios: Record<string, OcrLine[]> = {}) {
    this.agent.disableNetConnect();
    this.agent
      .get(COLLECTOR)
      .intercept({ path: () => true, method: /^(GET|POST)$/ })
      .reply((o) => {
        const r = this.handle(o.path, headerValue(o.headers, 'authorization'), String(o.body ?? ''));
        this.requests.push({ path: o.path, status: r.statusCode, bytes: String(o.body ?? '').length });
        return r;
      })
      .persist();
  }

  /** Writes the 0600 token file the client reads. */
  static tokenFile(dir: string, token = COLLECTOR_TOKEN): string {
    const file = path.join(dir, 'collector.token');
    fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
    return file;
  }

  ocrCalls(): number {
    return this.requests.filter((r) => r.path === '/v1/vision/ocr').length;
  }

  async close(): Promise<void> {
    await this.agent.close();
  }

  private handle(p: string, authorization: string | undefined, body: string) {
    if (authorization !== `Bearer ${this.token}`) return err(401, 'unauthorized');
    if (this.version === 'old') return body.length > MiB ? err(413, 'payload_too_large') : err(404, 'not_found');
    if (p !== '/v1/vision/ocr') return err(404, 'not_found');
    if (body.length > 8 * MiB) return err(413, 'payload_too_large');
    let req: { data_base64?: string };
    try {
      req = JSON.parse(body) as { data_base64?: string };
    } catch {
      return err(400, 'bad_request');
    }
    if (!req.data_base64) return err(400, 'bad_request');
    if (this.malformed !== null) return json(200, this.malformed);
    // Padding after a newline makes an image big without changing its scenario.
    const key = Buffer.from(req.data_base64, 'base64').toString('utf8').split('\n')[0]!.replace(/^fakeimg:/, '');
    const failure = this.failures.get(key);
    if (failure) return err(failure.status, failure.code);
    const lines = this.scenarios[key];
    if (!lines) return err(422, 'image_unreadable');
    return json(200, { api: 'v1', generated_at: Date.UTC(2026, 9, 21), width: 1170, height: 2532, lines });
  }
}
