import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  CollectorContractError,
  CollectorHttpError,
  CollectorUnavailableError,
  OcrClient,
  OcrRouteMissingError,
} from '../../src/screenshots/ocr';
import { tempDir } from '../helpers';
import { COLLECTOR, FakeOcrCollector } from './fakeCollector';
import { contactCard } from './fixtures';

const MiB = 1024 * 1024;
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const image = (scenario: string, padTo = 0) => {
  const head = `fakeimg:${scenario}`;
  return Buffer.from(padTo > head.length ? `${head}\n${'x'.repeat(padTo - head.length - 1)}` : head);
};

function setup(scenarios = { card: contactCard() }) {
  const t = tempDir();
  const fake = new FakeOcrCollector(scenarios);
  const tokenFile = FakeOcrCollector.tokenFile(t.dir);
  const client = new OcrClient({ baseUrl: COLLECTOR, tokenFile, dispatcher: fake.agent });
  cleanups.push(t.cleanup, () => fake.close(), () => client.close());
  return { fake, client, tokenFile, dir: t.dir };
}

describe('OcrClient', () => {
  it('posts base64 with the bearer token and validates the response', async () => {
    const { fake, client } = setup();
    const res = await client.ocr(image('card'));
    expect(res.width).toBe(1170);
    expect(res.lines.map((l) => l.text)).toContain('mobile');
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.path).toBe('/v1/vision/ocr');
  });

  it('re-reads the token file once after a 401', async () => {
    const { fake, client, tokenFile } = setup();
    await client.ocr(image('card'));
    fake.token = 'test-collector-token-rotated';
    fs.writeFileSync(tokenFile, 'test-collector-token-rotated\n', { mode: 0o600 });
    await client.ocr(image('card'));
    expect(fake.requests.map((r) => r.status)).toEqual([200, 401, 200]);
  });

  it('a token that stays wrong is a CollectorHttpError 401', async () => {
    const { fake, client } = setup();
    fake.token = 'something-else';
    await expect(client.ocr(image('card'))).rejects.toMatchObject({ name: 'CollectorHttpError', status: 401, code: 'unauthorized' });
  });

  it('a missing token file is CollectorUnavailableError(token_missing)', async () => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    const client = new OcrClient({ baseUrl: COLLECTOR, tokenFile: path.join(t.dir, 'nope.token'), dispatcher: new FakeOcrCollector().agent });
    await expect(client.ocr(image('card'))).rejects.toMatchObject({ name: 'CollectorUnavailableError', reason: 'token_missing' });
  });

  it('refuses a collector that is not on loopback', () => {
    expect(() => new OcrClient({ baseUrl: 'http://collector.example:4321', tokenFile: '/nonexistent' })).toThrow(/loopback/);
    expect(() => new OcrClient({ baseUrl: 'https://127.0.0.1:4321', tokenFile: '/nonexistent' })).toThrow(/loopback/);
  });

  it('an old collector (no route) is OcrRouteMissingError for small and large bodies alike', async () => {
    const { fake, client } = setup();
    fake.version = 'old';
    await expect(client.ocr(image('card'))).rejects.toBeInstanceOf(OcrRouteMissingError);
    // > 1 MiB: the old collector answers 413 before routing; a tiny probe then gets the 404.
    await expect(client.ocr(image('card', 1.2 * MiB))).rejects.toBeInstanceOf(OcrRouteMissingError);
    expect(fake.requests.map((r) => r.status)).toEqual([404, 413, 404]);
    expect(fake.requests[2]!.bytes).toBeLessThan(10);
  });

  it('a 413 from a collector that has the route is a final payload_too_large', async () => {
    const { fake, client } = setup();
    const err = await client.ocr(image('card', 6.1 * MiB)).catch((e) => e);
    expect(err).toBeInstanceOf(CollectorHttpError);
    expect(err).toMatchObject({ status: 413, code: 'payload_too_large' });
    expect(fake.requests.map((r) => r.status)).toEqual([413, 400]);
  });

  it('an unreadable image keeps the collector error code', async () => {
    const { client } = setup();
    await expect(client.ocr(image('unknown-scenario'))).rejects.toMatchObject({ status: 422, code: 'image_unreadable' });
  });

  it('a contract break names paths, never text', async () => {
    const { fake, client } = setup();
    fake.malformed = { api: 'v1', generated_at: 1, width: 10, height: 10, lines: [{ text: 'Secret Name', confidence: 2, x: 0, y: 0, w: 0, h: 0 }] };
    const err = await client.ocr(image('card')).catch((e) => e);
    expect(err).toBeInstanceOf(CollectorContractError);
    expect(err.paths).toEqual(['lines.#.confidence']);
    expect(err.message).not.toContain('Secret');
  });

  it('a refused connection is CollectorUnavailableError(unreachable)', async () => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    const tokenFile = FakeOcrCollector.tokenFile(t.dir);
    // Port 9 on loopback (discard): nothing listens there; the test egress guard allows loopback.
    const client = new OcrClient({ baseUrl: 'http://127.0.0.1:9', tokenFile, timeoutMs: 5_000 });
    cleanups.push(() => client.close());
    const err = await client.ocr(image('card')).catch((e) => e);
    expect(err).toBeInstanceOf(CollectorUnavailableError);
  });
});
