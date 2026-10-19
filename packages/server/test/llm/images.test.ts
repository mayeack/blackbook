/**
 * Images through the egress choke point: only base64 images the client approved (by hash) for a request on a route
 * with an image allowance leave; documents, URL/file sources, unapproved or batch images never do. Synthetic bytes
 * only (built at runtime so no base64 literal sits in the source).
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createLlmClient, imageIssue, promptTokens, withImages } from '../../src/llm/client';
import { checkMedia, createEgress, EgressRefused, egressFetch, imageHash, scanRequestBody, userTextOfParams } from '../../src/llm/egress';
import { IMAGE_MAX_TOKENS, ROUTES } from '../../src/llm/models';
import type { LlmImage } from '../../src/llm/types';
import { writeSettings } from '../../src/settings/registry';
import { memDb, T0 } from '../helpers';
import { FakeAnthropic, reply } from './fakeAnthropic';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const IMG: LlmImage = { mediaType: 'image/jpeg', data: b64('synthetic screenshot bytes'), width: 723, height: 1568 };
const imageBlock = (data = IMG.data, extra: object = {}) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data }, ...extra });
const body = (...content: object[]) => ({ model: 'm', messages: [{ role: 'user', content: [...content, { type: 'text', text: 'yb this person' }] }] });

describe('egress: image blocks', () => {
  it('leave only when their exact bytes were approved; documents, URL sources and odd types never do', () => {
    const approved = new Set([imageHash(IMG.data)]);
    const approve = (h: string) => approved.has(h);
    expect(() => checkMedia(body(imageBlock()), approve)).not.toThrow();
    expect(() => checkMedia(body(imageBlock()))).toThrow(EgressRefused);
    expect(() => checkMedia(body(imageBlock(b64('other bytes'))), approve)).toThrow(EgressRefused);
    expect(() => checkMedia(body({ type: 'image', source: { type: 'url', url: 'https://example.com/x.png' } }), () => true)).toThrow(EgressRefused);
    expect(() => checkMedia(body({ type: 'image', source: { type: 'base64', media_type: 'image/heic', data: IMG.data } }), () => true)).toThrow(EgressRefused);
    expect(() => checkMedia(body({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: IMG.data } }), () => true)).toThrow(
      EgressRefused,
    );
    // Inside a tool result too.
    expect(() => checkMedia({ messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [imageBlock()] }] }] })).toThrow(EgressRefused);
  });

  it('image bytes are never read as text, so base64 can neither leak into the scan nor trip it', () => {
    const tricky = imageBlock(b64('+15125550100 owner@example.com @handle'));
    expect(userTextOfParams(body(tricky))).toBe('yb this person');
    expect(() => scanRequestBody(body(tricky), () => true)).not.toThrow();
    // The text beside it is still scanned.
    expect(() => scanRequestBody({ messages: [{ role: 'user', content: [tricky, { type: 'text', text: 'call @sam' }] }] }, () => true)).toThrow();
  });

  it('a batch never carries an image, approved or not', () => {
    const batch = { requests: [{ custom_id: 'x', params: body(imageBlock()) }] };
    expect(() => scanRequestBody(batch, () => true)).toThrow(EgressRefused);
  });

  it('the fetch wrapper answers a local 400 for an unapproved image and forwards an approved one', async () => {
    const reached: string[] = [];
    const inner = (async () => {
      reached.push('sent');
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const init = { method: 'POST', body: JSON.stringify(body(imageBlock())) };
    const closed = egressFetch({ fetch: inner });
    expect((await closed('https://api.anthropic.com/v1/messages', init)).status).toBe(400);
    const open = egressFetch({ fetch: inner, approveMedia: (h) => h === imageHash(IMG.data) });
    expect((await open('https://api.anthropic.com/v1/messages', init)).status).toBe(200);
    expect(reached).toEqual(['sent']);
  });
});

describe('client: images on a vision route', () => {
  const Out = z.object({ ok: z.boolean() });
  function setup() {
    const db = memDb();
    writeSettings(db, { tz: 'UTC' }, { actor: 'user', now: T0 });
    const api = new FakeAnthropic().onMessage(() => reply({ json: { ok: true } }));
    const llm = createLlmClient({ db, apiKey: 'synthetic-test-key', egress: createEgress(db), fetch: api.fetch, now: () => T0, maxRetries: 0 });
    return { api, llm };
  }
  const req = (route: 'intent' | 'tiebreak', images: LlmImage[]) => ({
    kind: 'intent' as const,
    route,
    subjectRef: 'cmd:1',
    promptVersion: 'v1',
    system: 'Classify the note.',
    messages: [{ role: 'user' as const, content: '### NOTE\nyb this person' }],
    images,
    schema: Out,
  });

  it('only the intent route takes images (≤2)', () => {
    expect(ROUTES.intent.maxImages).toBe(2);
    for (const [route, p] of Object.entries(ROUTES)) if (route !== 'intent') expect(p.maxImages, route).toBe(0);
    expect(imageIssue([IMG], 0)).toBe('route takes no images');
    expect(imageIssue([IMG, IMG, IMG], 2)).toBe('more than 2 images');
    expect(imageIssue([{ ...IMG, data: 'not base64!' }], 2)).toBe('image data');
    expect(imageIssue([IMG], 2)).toBeNull();
  });

  it('the image goes first in the user turn, through the real egress fetch; Haiku, thinking off', async () => {
    const { api, llm } = setup();
    const out = await llm.parse(req('intent', [IMG]));
    expect(out.status).toBe('ok');
    const sent = api.messageRequests[0]!.body as { model: string; thinking: unknown; messages: { content: { type: string; text?: string }[] }[] };
    expect(sent.model).toBe('claude-haiku-5-5');
    expect(sent.thinking).toEqual({ type: 'disabled' });
    expect(sent.messages[0]!.content.map((b) => b.type)).toEqual(['image', 'text']);
    expect(sent.messages[0]!.content[1]!.text).toBe('### NOTE\nyb this person');
    // A route without an image allowance refuses them before anything is sent.
    expect((await llm.parse(req('tiebreak', [IMG]))).status).toBe('unavailable');
    expect(api.messageRequests).toHaveLength(1);
  });

  it('the size guard counts an image at the high-resolution ceiling, not its base64 length', () => {
    const big: LlmImage = { ...IMG, data: 'A'.repeat(600_000) };
    const params = { messages: withImages([{ role: 'user', content: 'hi' }], [big]) };
    expect(promptTokens(params)).toBeLessThan(IMAGE_MAX_TOKENS + 50);
    expect(promptTokens(params)).toBeGreaterThanOrEqual(IMAGE_MAX_TOKENS);
  });
});
