/**
 * The Ollama client (llm/local.ts) against a scripted fetch: what it sends (format without zod's ±2^53 bounds,
 * think:false only to a thinking model, images only to a vision model), and that every failure is an outcome, never a
 * throw, so the caller can fall back to Claude. Nothing here touches a real Ollama (test/setup.ts refuses port 11434).
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createOllamaClient, localFormat } from '../../src/llm/local';

const OLLAMA = 'http://127.0.0.1:11434';
const Out = z.object({ answer: z.enum(['yes', 'no']), n: z.number().int(), note: z.string().nullable() });

interface Sent {
  path: string;
  body: Record<string, unknown>;
}

function ollama(o: { capabilities?: string[] | null; reply?: unknown; chatStatus?: number; down?: boolean; hang?: boolean } = {}) {
  const sent: Sent[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(href).pathname;
    sent.push({ path, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    if (o.down) throw new TypeError('fetch failed');
    if (path === '/api/show') {
      return o.capabilities === null
        ? new Response(JSON.stringify({ error: "model 'qwen3:4b' not found" }), { status: 404 })
        : Response.json({ capabilities: o.capabilities ?? ['completion'] });
    }
    if (o.hang) {
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
    }
    if (o.chatStatus && o.chatStatus !== 200) return new Response(JSON.stringify({ error: 'boom' }), { status: o.chatStatus });
    return Response.json({ message: { role: 'assistant', content: typeof o.reply === 'string' ? o.reply : JSON.stringify(o.reply ?? { answer: 'yes', n: 2, note: null }) }, done: true });
  }) as typeof globalThis.fetch;
  return { sent, client: createOllamaClient({ url: OLLAMA, fetch }) };
}

const req = { model: 'qwen3:4b', system: 'S', user: 'U', schema: Out };

describe('local model (Ollama)', () => {
  it('sends the schema as a grammar format (no $schema, no ±2^53 int bounds), temperature 0, no streaming', async () => {
    const { client, sent } = ollama({ capabilities: ['completion', 'thinking'] });
    const r = await client.parse(req);
    expect(r).toMatchObject({ status: 'ok', value: { answer: 'yes', n: 2, note: null }, model: 'qwen3:4b' });
    const chat = sent.find((s) => s.path === '/api/chat')!.body;
    expect(chat).toMatchObject({ model: 'qwen3:4b', stream: false, think: false, keep_alive: '30m', options: { temperature: 0 } });
    expect(chat.messages).toEqual([
      { role: 'system', content: 'S' },
      { role: 'user', content: 'U' },
    ]);
    const format = JSON.stringify(chat.format);
    expect(format).not.toContain('$schema');
    expect(format).not.toContain('9007199254740991');
    expect(chat.format).toEqual(localFormat(Out));
    expect((chat.format as { required: string[] }).required).toEqual(['answer', 'n', 'note']);
  });

  it('think is sent only to a model that thinks; /api/show is asked once per model', async () => {
    const { client, sent } = ollama({ capabilities: ['completion'] });
    await client.parse(req);
    await client.parse(req);
    expect(sent.filter((s) => s.path === '/api/show')).toHaveLength(1);
    for (const s of sent.filter((x) => x.path === '/api/chat')) expect(s.body).not.toHaveProperty('think');
  });

  it('images go only to a vision model; any other answers no_vision (Claude reads the screenshot)', async () => {
    const img = { mediaType: 'image/png' as const, data: 'aGVsbG8=' };
    const text = ollama({ capabilities: ['completion'] });
    expect(await text.client.parse({ ...req, images: [img] })).toEqual({ status: 'unavailable', reason: 'no_vision', detail: 'qwen3:4b' });
    expect(text.sent.some((s) => s.path === '/api/chat')).toBe(false);
    const vision = ollama({ capabilities: ['completion', 'vision'] });
    expect(await vision.client.parse({ ...req, images: [img] })).toMatchObject({ status: 'ok' });
    const user = (vision.sent.find((s) => s.path === '/api/chat')!.body.messages as { images?: string[] }[])[1]!;
    expect(user.images).toEqual(['aGVsbG8=']);
  });

  it('every failure is an outcome: not running, not pulled, an HTTP error, a timeout', async () => {
    expect(await ollama({ down: true }).client.parse(req)).toEqual({ status: 'unavailable', reason: 'unreachable' });
    expect(await ollama({ capabilities: null }).client.parse(req)).toEqual({ status: 'unavailable', reason: 'model_missing', detail: 'qwen3:4b' });
    expect(await ollama({ chatStatus: 500 }).client.parse(req)).toEqual({ status: 'unavailable', reason: 'error', detail: 'boom' });
    expect(await ollama({ hang: true }).client.parse({ ...req, timeoutMs: 20 })).toEqual({ status: 'unavailable', reason: 'timeout' });
    const ac = new AbortController();
    ac.abort();
    expect(await ollama().client.parse({ ...req, signal: ac.signal })).toEqual({ status: 'unavailable', reason: 'aborted' });
    expect(await ollama({ down: true }).client.info('qwen3:4b')).toBeNull();
  });

  it('output that is not JSON, breaks the schema or fails validate is invalid', async () => {
    expect(await ollama({ reply: 'sure! here you go' }).client.parse(req)).toMatchObject({ status: 'invalid', issues: ['not JSON'] });
    expect(await ollama({ reply: { answer: 'maybe', n: 1, note: null } }).client.parse(req)).toMatchObject({ status: 'invalid', issues: ['answer: invalid_value'] });
    const r = await ollama({ reply: { answer: 'no', n: 99, note: null } }).client.parse({ ...req, validate: (v) => (v.n > 10 ? ['n out of range'] : []) });
    expect(r).toMatchObject({ status: 'invalid', issues: ['n out of range'] });
  });
});
