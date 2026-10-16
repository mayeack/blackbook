/**
 * A fake Anthropic API behind the real SDK (passed as LlmClientOptions.fetch, i.e. UNDER the egress guard). It
 * answers POST /v1/messages (JSON, or SSE when the body asks for a stream), POST /v1/messages/batches, GET a batch
 * and GET its JSONL results, and records every request that reached it. Nothing touches the network.
 *
 *   const api = new FakeAnthropic().onMessage(() => reply({ json: { ok: true } }));
 *   const llm = createLlmClient({ db, apiKey: 'synthetic-test-key', egress, fetch: api.fetch });
 */
import { DEFAULT_MODEL } from '../../src/llm/models';

export interface FakeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_1h_input_tokens: number; ephemeral_5m_input_tokens: number } | null;
  iterations?: { type: 'message' | 'fallback_message'; model: string; input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; cache_creation: null }[] | null;
}

export type FakeBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'fallback'; from: { model: string }; to: { model: string } };

export interface FakeMessage {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: FakeBlock[];
  stop_reason: string;
  stop_sequence: null;
  stop_details: { type: 'refusal'; category: string | null; explanation: string | null } | null;
  container: null;
  usage: FakeUsage & { input_tokens: number; output_tokens: number };
}

let msgSeq = 0;

/** Builds an assistant message. An empty thinking block always comes first (adaptive thinking can emit one). */
export function reply(o: {
  json?: unknown;
  text?: string;
  toolUses?: { name: string; input: unknown; id?: string }[];
  stop?: 'end_turn' | 'max_tokens' | 'tool_use' | 'refusal' | 'pause_turn';
  category?: string | null;
  usage?: FakeUsage;
  model?: string;
  fallbackFrom?: string;
  /** Text emitted by a declined attempt before the fallback switch point. */
  declinedText?: string;
}): FakeMessage {
  const content: FakeBlock[] = [{ type: 'thinking', thinking: '', signature: 'sig-fake' }];
  if (o.fallbackFrom) {
    if (o.declinedText) content.push({ type: 'text', text: o.declinedText });
    content.push({ type: 'fallback', from: { model: o.fallbackFrom }, to: { model: o.model ?? 'claude-sonnet-5' } });
  }
  const text = o.json !== undefined ? JSON.stringify(o.json) : o.text;
  if (text !== undefined && o.stop !== 'refusal') content.push({ type: 'text', text });
  for (const [i, t] of (o.toolUses ?? []).entries()) content.push({ type: 'tool_use', id: t.id ?? `toolu_fake_${++msgSeq}_${i}`, name: t.name, input: t.input });
  const stop = o.stop ?? (o.toolUses?.length ? 'tool_use' : 'end_turn');
  return {
    id: `msg_fake_${++msgSeq}`,
    type: 'message',
    role: 'assistant',
    model: o.model ?? DEFAULT_MODEL,
    content,
    stop_reason: stop,
    stop_sequence: null,
    stop_details: stop === 'refusal' ? { type: 'refusal', category: o.category ?? null, explanation: null } : null,
    container: null,
    usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: null, iterations: null, ...o.usage },
  };
}

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

export type BatchItemReply =
  | { message: FakeMessage }
  | { errored: 'invalid_request_error' | 'api_error' }
  | { canceled: true }
  | { expired: true };

interface FakeBatch {
  id: string;
  requests: { custom_id: string; params: Record<string, unknown> }[];
  status: 'in_progress' | 'ended';
  created: string;
}

const json = (v: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json', 'request-id': 'req_fake', ...headers } });

function sse(m: FakeMessage): Response {
  const lines: string[] = [];
  const ev = (type: string, data: unknown) => lines.push(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  ev('message_start', { type: 'message_start', message: { ...m, content: [], stop_reason: null, stop_details: null } });
  m.content.forEach((b, index) => {
    if (b.type === 'text') {
      ev('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      for (const piece of b.text.match(/[\s\S]{1,7}/g) ?? []) ev('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } });
    } else if (b.type === 'tool_use') {
      ev('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
      ev('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
    } else if (b.type === 'thinking') {
      ev('content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } });
      ev('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: b.signature } });
    } else {
      ev('content_block_start', { type: 'content_block_start', index, content_block: b });
    }
    ev('content_block_stop', { type: 'content_block_stop', index });
  });
  ev('message_delta', { type: 'message_delta', delta: { stop_reason: m.stop_reason, stop_sequence: null, stop_details: m.stop_details }, usage: m.usage });
  ev('message_stop', { type: 'message_stop' });
  return new Response(lines.join(''), { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_fake' } });
}

export class FakeAnthropic {
  readonly requests: RecordedRequest[] = [];
  private messageHandlers: ((body: Record<string, unknown>, n: number) => FakeMessage | Response)[] = [];
  private batchHandler: (req: { custom_id: string; params: Record<string, unknown> }) => BatchItemReply = () => ({ message: reply({ json: {} }) });
  readonly batches = new Map<string, FakeBatch>();
  private batchSeq = 0;
  private messageCalls = 0;
  /** Batches stay in_progress for this many retrieves. */
  pendingPolls = 0;
  private polls = new Map<string, number>();

  /** Replies for POST /v1/messages, used in order (the last one repeats). */
  onMessage(...handlers: ((body: Record<string, unknown>, n: number) => FakeMessage | Response)[]): this {
    this.messageHandlers.push(...handlers);
    return this;
  }

  onBatchItem(h: (req: { custom_id: string; params: Record<string, unknown> }) => BatchItemReply): this {
    this.batchHandler = h;
    return this;
  }

  get messageRequests(): RecordedRequest[] {
    return this.requests.filter((r) => r.method === 'POST' && r.path === '/v1/messages');
  }

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    this.requests.push({ method, path: url.pathname, headers, body });

    if (method === 'POST' && url.pathname === '/v1/messages') {
      const n = this.messageCalls++;
      const h = this.messageHandlers[Math.min(n, this.messageHandlers.length - 1)];
      if (!h) return json({ type: 'error', error: { type: 'api_error', message: 'no fake reply scripted' } }, 500);
      const m = h(body!, n);
      if (m instanceof Response) return m;
      return body?.stream ? sse(m) : json(m);
    }
    if (method === 'POST' && url.pathname === '/v1/messages/batches') {
      const id = `msgbatch_fake${++this.batchSeq}`;
      const b: FakeBatch = { id, requests: body!.requests as FakeBatch['requests'], status: 'in_progress', created: new Date(0).toISOString() };
      this.batches.set(id, b);
      return json(this.batchJson(b));
    }
    const m = /^\/v1\/messages\/batches\/([^/]+)(\/results)?$/.exec(url.pathname);
    if (method === 'GET' && m) {
      const b = this.batches.get(m[1]!);
      if (!b) return json({ type: 'error', error: { type: 'not_found_error', message: 'no such batch' } }, 404);
      if (!m[2]) {
        const seen = (this.polls.get(b.id) ?? 0) + 1;
        this.polls.set(b.id, seen);
        if (seen > this.pendingPolls) b.status = 'ended';
        return json(this.batchJson(b));
      }
      // Results in REVERSE order: callers must key by custom_id.
      const lines = [...b.requests].reverse().map((r) => {
        const out = this.batchHandler(r);
        const result =
          'message' in out
            ? { type: 'succeeded', message: out.message }
            : 'errored' in out
              ? { type: 'errored', error: { type: 'error', error: { type: out.errored, message: 'fake' } } }
              : 'canceled' in out
                ? { type: 'canceled' }
                : { type: 'expired' };
        return JSON.stringify({ custom_id: r.custom_id, result });
      });
      return new Response(lines.join('\n') + '\n', { status: 200, headers: { 'content-type': 'application/binary' } });
    }
    return json({ type: 'error', error: { type: 'not_found_error', message: 'unknown fake route' } }, 404);
  }) as typeof fetch;

  private batchJson(b: FakeBatch) {
    const n = b.requests.length;
    const ended = b.status === 'ended';
    return {
      id: b.id,
      type: 'message_batch',
      processing_status: b.status,
      request_counts: { processing: ended ? 0 : n, succeeded: ended ? n : 0, errored: 0, canceled: 0, expired: 0 },
      ended_at: ended ? '2026-10-15T08:00:00Z' : null,
      created_at: b.created,
      expires_at: '2026-10-16T08:00:00Z',
      archived_at: null,
      cancel_initiated_at: null,
      results_url: ended ? `https://api.anthropic.com/v1/messages/batches/${b.id}/results` : null,
    };
  }
}
