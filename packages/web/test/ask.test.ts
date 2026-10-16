import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { encodeSseEvent, type AskCitation, type AskEvent, type AskTurn } from '@yb/shared';
import { ApiError } from '../src/api/client';
import { applyEvent, citationHref, citationPersonId, fromStored, isNeedsKeyAnswer, newTurn, parseAnswer, superscript, toolLabel } from '../src/pages/ask/logic';
import { AskStore, mergeTurns } from '../src/pages/ask/store';
import { streamAsk, type StreamEnv } from '../src/pages/ask/stream';

// Suite-wide network guard: nothing in these tests may reach a real endpoint.
beforeAll(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('network disabled in tests');
  });
});
afterAll(() => vi.unstubAllGlobals());

const PID = '0198f0a2-0000-7000-8000-000000000001';
const cites: AskCitation[] = [
  { ref: 'm:2n9c', kind: 'message', label: 'Avery · iMessage Oct 3', href: `/p/${PID}?m=123456`, at: 1_700_000_000_000 },
  { ref: 'F1a', kind: 'fact', label: 'Avery — lives in Springfield', href: `/p/${PID}`, at: null },
  { ref: 'E4', kind: 'event', label: 'Board game night · Nov 22', href: '/e/0198f0a2-0000-7000-8000-0000000000e4', at: null },
  { ref: 'P1a', kind: 'person', label: 'Avery Quinn', href: `/p/${PID}`, at: null },
];

describe('live turn reducer', () => {
  it('walks start → tools → deltas → citation → done', () => {
    let t = newTurn('k', 'Who lives in Springfield?', null, 1);
    const events: AskEvent[] = [
      { type: 'start', conversationId: 'conv-1', turnId: 'turn-1' },
      { type: 'tool_status', tool: 'search_people', status: 'running', summary: 'Searching people in Springfield', count: null },
      { type: 'tool_status', tool: 'search_facts', status: 'running', summary: null, count: null },
      { type: 'tool_status', tool: 'search_people', status: 'done', summary: null, count: 2 },
      { type: 'delta', text: 'Avery ' },
      { type: 'delta', text: 'lives there [F1a].' },
      { type: 'citation', citation: cites[1]! },
      { type: 'citation', citation: cites[1]! },
    ];
    for (const e of events) t = applyEvent(t, e);
    expect(t.status).toBe('streaming');
    expect(t.conversationId).toBe('conv-1');
    expect(t.text).toBe('Avery lives there [F1a].');
    expect(t.citations).toHaveLength(1);
    expect(t.tools.map((s) => [s.tool, s.status])).toEqual([
      ['search_people', 'done'],
      ['search_facts', 'running'],
    ]);
    // the running summary survives the done event
    expect(toolLabel(t.tools[0]!)).toBe('Searching people in Springfield');
    expect(toolLabel(t.tools[1]!)).toBe('Checking what you know');

    t = applyEvent(t, {
      type: 'done',
      conversationId: 'conv-1',
      turnId: 'turn-1',
      answer: 'Avery lives there [F1a].',
      citations: [cites[1]!],
      people: [{ id: PID, displayName: 'Avery Quinn', firstName: 'Avery', state: 'steady' }],
      degraded: false,
      usage: { toolCalls: 2, inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
    });
    expect(t.status).toBe('done');
    expect(t.tools.every((s) => s.status !== 'running')).toBe(true);
    // nothing changes after done
    expect(applyEvent(t, { type: 'delta', text: 'more' })).toBe(t);
  });

  it('marks degraded answers and errors', () => {
    const base = applyEvent(newTurn('k', 'q', null), { type: 'start', conversationId: 'c', turnId: 't' });
    const d = applyEvent(base, { type: 'done', conversationId: 'c', turnId: 't', answer: 'Ask needs the Anthropic API key to write answers.', citations: [], people: [], degraded: true, usage: null });
    expect(d.status).toBe('degraded');
    expect(isNeedsKeyAnswer(d.text)).toBe(true);
    const e = applyEvent(base, { type: 'error', code: 'internal', message: 'Ask hit a problem.' });
    expect(e.status).toBe('error');
    expect(e.error?.message).toBe('Ask hit a problem.');
  });

  it('maps stored turns', () => {
    const stored: AskTurn = { id: 'turn-9', question: 'q', answer: 'a', citations: [], people: [], channel: 'web', status: 'degraded', createdAt: 5 };
    expect(fromStored(stored, 'c').status).toBe('degraded');
    expect(fromStored({ ...stored, status: 'running' }, 'c').status).toBe('pending');
  });
});

describe('answer parsing', () => {
  it('numbers footnotes by first appearance, inlines person chips, drops unknown ids', () => {
    const p = parseAnswer('Avery [P1a] lives in Springfield [F1a][m:2n9c]. Also [F1a] and [F9z].\n\n- Game night [E4]\n- Second', cites);
    expect(p.footnotes.map((f) => [f.n, f.citation.ref])).toEqual([
      [1, 'F1a'],
      [2, 'm:2n9c'],
      [3, 'E4'],
    ]);
    expect(p.blocks).toHaveLength(2);
    const para = p.blocks[0]!;
    expect(para.kind).toBe('p');
    if (para.kind !== 'p') throw new Error('expected a paragraph');
    expect(para.inlines.filter((x) => x.kind === 'person')).toHaveLength(1);
    expect(para.inlines.filter((x) => x.kind === 'cite').map((x) => (x.kind === 'cite' ? x.n : 0))).toEqual([1, 2, 1]);
    // [F9z] looks like an id but has no citation: gone, no marker left
    expect(para.inlines.map((x) => (x.kind === 'text' ? x.text : '')).join('')).not.toContain('F9z');
    const list = p.blocks[1]!;
    expect(list.kind === 'ul' && list.items.length).toBe(2);
  });

  it('accepts citation groups and leaves bracketed words alone', () => {
    const p = parseAnswer('See [F1a, E4]. [Pizza] night.', cites);
    expect(p.footnotes.map((f) => f.citation.ref)).toEqual(['F1a', 'E4']);
    const text = p.blocks[0]!.kind === 'p' ? p.blocks[0]!.inlines.map((x) => (x.kind === 'text' ? x.text : '')).join('') : '';
    expect(text).toContain('[Pizza]');
  });

  it('builds safe links and superscripts', () => {
    expect(citationHref(cites[0]!)).toBe(`/p/${PID}?m=123456&at=1700000000000`);
    expect(citationHref(cites[1]!)).toBe(`/p/${PID}`);
    expect(citationHref({ href: 'https://example.com/x', kind: 'fact', at: null })).toBeNull();
    expect(citationHref({ href: '//example.com/x', kind: 'fact', at: null })).toBeNull();
    expect(citationPersonId(cites[3]!)).toBe(PID);
    expect(citationPersonId({ href: '/e/abc' })).toBeNull();
    expect(superscript(12)).toBe('¹²');
  });
});

// ---------------------------------------------------------------------------------------------- streaming

function sseResponse(chunks: string[], init: ResponseInit = {}): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(ctl) {
      for (const c of chunks) ctl.enqueue(enc.encode(c));
      ctl.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' }, ...init });
}

const doneEvent: AskEvent = { type: 'done', conversationId: 'conv-1', turnId: 'turn-1', answer: 'Hi [F1a]', citations: [cites[1]!], people: [], degraded: false, usage: null };

function env(fetchImpl: StreamEnv['fetch']): StreamEnv & { relogins: number } {
  const e = { relogins: 0, fetch: fetchImpl, relogin: () => void e.relogins++ };
  return e;
}

describe('streamAsk', () => {
  it('posts JSON with X-YB and parses frames split across chunks', async () => {
    const frames = [encodeSseEvent({ type: 'start', conversationId: 'conv-1', turnId: 'turn-1' }), ': ping\n\n', encodeSseEvent({ type: 'delta', text: 'Hi ' }), encodeSseEvent(doneEvent)].join('');
    const chunks = [frames.slice(0, 17), frames.slice(17, 60), frames.slice(60)];
    const calls: { url: string; init: RequestInit }[] = [];
    const e = env(async (url, init) => {
      calls.push({ url, init });
      return sseResponse(chunks);
    });
    const got: AskEvent[] = [];
    await streamAsk(e, { question: 'hello' }, (ev) => got.push(ev));
    expect(got.map((x) => x.type)).toEqual(['start', 'delta', 'done']);
    expect(calls[0]!.url).toBe('/api/v1/ask');
    expect(calls[0]!.init.method).toBe('POST');
    expect((calls[0]!.init.headers as Record<string, string>)['X-YB']).toBe('1');
    expect(calls[0]!.init.redirect).toBe('manual');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ question: 'hello' });
  });

  it('turns JSON errors into ApiError and a bounce into a re-login', async () => {
    const e1 = env(async () => new Response(JSON.stringify({ error: { code: 'VALIDATION', message: 'Bad question.' } }), { status: 400, headers: { 'Content-Type': 'application/json' } }));
    await expect(streamAsk(e1, { question: 'x' }, () => {})).rejects.toMatchObject({ status: 400, code: 'VALIDATION', message: 'Bad question.' });

    const e2 = env(async () => new Response('', { status: 429 }));
    await expect(streamAsk(e2, { question: 'x' }, () => {})).rejects.toBeInstanceOf(ApiError);

    const e3 = env(async () => new Response('<html>login</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }));
    await expect(streamAsk(e3, { question: 'x' }, () => {})).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    expect(e3.relogins).toBe(1);

    const e4 = env(async () => {
      throw new TypeError('offline');
    });
    await expect(streamAsk(e4, { question: 'x' }, () => {})).rejects.toMatchObject({ code: 'NETWORK' });
  });
});

describe('AskStore', () => {
  it('tracks a turn through the stream and reports when it settles', async () => {
    const frames = [encodeSseEvent({ type: 'start', conversationId: 'conv-1', turnId: 'turn-1' }), encodeSseEvent({ type: 'delta', text: 'Hi ' }), encodeSseEvent(doneEvent)];
    const settled: string[] = [];
    const store = new AskStore({ env: env(async () => sseResponse(frames)), onSettled: (t) => settled.push(t.status), now: () => 42 });
    let versions = 0;
    store.subscribe(() => versions++);
    const key = store.ask('hello', null);
    expect(store.get(key)?.status).toBe('pending');
    expect(store.busy(null, key)).toBe(true);
    await vi.waitFor(() => expect(settled).toEqual(['done']));
    expect(store.forDraft(key).map((t) => t.conversationId)).toEqual(['conv-1']);
    expect(store.forConversation('conv-1')[0]!.text).toBe('Hi [F1a]');
    expect(store.busy('conv-1')).toBe(false);
    expect(versions).toBeGreaterThan(2);
  });

  it('marks a stream that ends without done as cut off, and a stop as stopped', async () => {
    const cut = new AskStore({ env: env(async () => sseResponse([encodeSseEvent({ type: 'start', conversationId: 'c', turnId: 't' })])) });
    const k1 = cut.ask('q', null);
    await vi.waitFor(() => expect(cut.get(k1)?.status).toBe('error'));

    const hang = new AskStore({
      env: env(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          }),
      ),
    });
    const k2 = hang.ask('q', 'conv-2');
    hang.stopAll('conv-2');
    await vi.waitFor(() => expect(hang.get(k2)?.status).toBe('stopped'));
  });

  it('merges stored turns with live ones (live wins by turn id, unsaved follow)', () => {
    const stored = [fromStored({ id: 't1', question: 'a', answer: 'old', citations: [], people: [], channel: 'web', status: 'done', createdAt: 1 }, 'c')];
    const live = [
      { ...newTurn('k1', 'a', 'c'), turnId: 't1', text: 'new', status: 'done' as const },
      { ...newTurn('k2', 'b', 'c'), status: 'streaming' as const },
    ];
    const merged = mergeTurns(stored, live);
    expect(merged.map((t) => t.text)).toEqual(['new', '']);
    expect(merged).toHaveLength(2);
  });
});
