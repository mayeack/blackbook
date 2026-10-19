/**
 * Deterministic, scriptable LlmClient and Egress for tests. Nothing here touches the network.
 *
 *   const llm = new FakeLlmClient()
 *     .on('extract', { json: { summary: '', facts: [] } })       // every extract call
 *     .on('digest:2026-10-14', { refusal: 'cyber' })              // one subject
 *     .on('ask', { toolCalls: [{ name: 'search_people', input: { query: 'Austin' } }], then: { text: 'Sam [P1]' } });
 *   const out = await llm.parse({ kind: 'extract', … });           // validated with req.schema + req.validate
 *   llm.calls                                                       // every request, in order
 *
 * Replies are looked up as `${kind}:${subjectRef}` first, then `kind`, then the default responder. A queued
 * script (several replies for one key) is consumed in order; the last one repeats. Batches: submitBatch stores
 * the items; batchResults answers each from the same script (keyed by the item's kind/subjectRef) with
 * `batch: true` usage and NO fallbacks (a refusal comes back as stopReason 'refusal').
 *
 * Extraction windows send two requests (knowledge, then obligations: a custom_id ending in "_o-<n>", or the
 * ExtractionObligations schema on a sync call). The obligations request gets `obligations:${subjectRef}` when
 * scripted, else the reply its knowledge request just got, so one scripted reply still means one attempt (the
 * window merges each part's own keys from it).
 *
 * Every structured-output schema passes the real client's grammar check (llm/client.ts grammarIssues), so a schema
 * the API would refuse fails the test that uses it.
 *
 * Every call is recorded with its route's resolved parameters (llm/models.ts + `overrides`): model, effort,
 * thinking, max_tokens and whether the real client would send `fallbacks` (only sync calls on a model that has
 * server-side fallback — never Haiku 5.5, never batches). Usage is priced on that model.
 */
import type { z } from 'zod';
import { resolveRoute, sendsFallbacks, type LlmRoute, type RouteOverrides, type RouteParams } from '../../src/llm/models';
import {
  costUsd,
  EgressBlocked,
  LLM_MODEL,
  type BudgetPool,
  type Egress,
  type EgressPacket,
  type LlmBatchItem,
  type LlmBatchResult,
  type LlmBatchStatus,
  type LlmBatchSubmit,
  type LlmClient,
  type LlmKind,
  type LlmOutcome,
  type LlmParseRequest,
  type LlmSpend,
  type LlmToolLoopOutcome,
  type LlmToolLoopRequest,
  type LlmUnavailableReason,
  type LlmUsage,
  type PseudonymizedPacket,
  type SpendCheck,
  type TokenMap,
  type TokenTarget,
} from '../../src/llm/types';
import { findRawIdentifiers } from '../../src/llm/egress';
import { outputFormat } from '../../src/llm/caching';
import { grammarIssues } from '../../src/llm/client';
import { ExtractionObligations } from '../../src/extraction/schema';

const OBLIGATIONS_ID = /_o-\d{1,2}$/;

/** The API's schema compiler, as the real client checks it before sending. */
function assertCompiles(schema: z.ZodType): void {
  const issues = grammarIssues({ output_config: { format: outputFormat(schema) } });
  if (issues.length) throw new Error(`FakeLlmClient: the API would refuse this output schema: ${issues.join('; ')}`);
}

export type FakeReply =
  /** A structured answer (JSON-serialized as the text block). */
  | { json: unknown; usage?: Partial<LlmUsage> }
  /** Raw text (for invalid-JSON tests, or the final text of a tool loop). */
  | { text: string; usage?: Partial<LlmUsage> }
  | { refusal: string | null }
  | { maxTokens: true; partialText?: string }
  | { unavailable: LlmUnavailableReason }
  /** Tool loop: call these tools in order (one turn each), then answer with `then`. */
  | { toolCalls: { name: string; input: unknown }[]; then: FakeReply }
  /** Batch only. */
  | { batchError: 'invalid_request' | 'other' }
  | { expired: true }
  | { canceled: true }
  /** Throws (a programming error / unexpected SDK exception). */
  | { throws: string };

export interface FakeCall {
  method: 'parse' | 'runTools' | 'batch';
  kind: LlmKind;
  route: LlmRoute;
  model: string;
  thinking: RouteParams['thinking'];
  subjectRef: string;
  effort: string;
  maxTokens: number;
  /** Whether the real client would send server-side fallbacks for this call. */
  fallbacks: boolean;
  system: string;
  /** Concatenated text of the user messages (already pseudonymized by the caller). */
  userText: string;
  /** Images attached to a parse() call (vision routes only). */
  images: number;
  customId?: string;
}

export interface FakeLlmOptions {
  /** false = no API key: everything answers 'unavailable' / 'no_key'. */
  configured?: boolean;
  /** Fallback when nothing is scripted for a key (default: { json: {} }). */
  responder?: (call: FakeCall) => FakeReply;
  /** Fixed per-request token counts (default 1000 in / 200 out / 0 cache). */
  tokens?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  /** Simulated spend caps (USD); null = unlimited. */
  budget?: { steady: number | null; backfill: number | null };
  /** Scan every outgoing user text with the egress rules (default true): raw identifiers fail closed. */
  scanEgress?: boolean;
  /** The owner's per-route overrides (settings llm.route_overrides). */
  overrides?: RouteOverrides;
}

const textOf = (messages: LlmParseRequest<unknown>['messages']): string =>
  messages
    .filter((m) => m.role === 'user')
    .map((m) =>
      typeof m.content === 'string'
        ? m.content
        : m.content
            .map((b) => (b.type === 'text' ? b.text : b.type === 'tool_result' ? (typeof b.content === 'string' ? b.content : JSON.stringify(b.content)) : ''))
            .join('\n'),
    )
    .join('\n');

export class FakeLlmClient implements LlmClient {
  readonly model = LLM_MODEL;
  readonly configured: boolean;
  readonly calls: FakeCall[] = [];
  private readonly scripts = new Map<string, FakeReply[]>();
  /** The last reply per subjectRef (an extraction window's obligations request reuses it). */
  private readonly lastReply = new Map<string, FakeReply>();
  private readonly batches = new Map<string, LlmBatchItem[]>();
  private batchSeq = 0;
  private reqSeq = 0;
  private spent = { steady: 0, backfill: 0 };

  constructor(private readonly o: FakeLlmOptions = {}) {
    this.configured = o.configured ?? true;
  }

  /** Script replies for `kind` or `kind:subjectRef` (consumed in order; the last repeats). */
  on(key: string, ...replies: FakeReply[]): this {
    if (!replies.length) throw new Error('FakeLlmClient.on needs at least one reply');
    this.scripts.set(key, [...(this.scripts.get(key) ?? []), ...replies]);
    return this;
  }

  params(route: LlmRoute): RouteParams {
    return resolveRoute(route, this.o.overrides);
  }

  /** Simulate spend already made today (budget tests). */
  addSpend(pool: BudgetPool, usd: number): this {
    this.spent[pool] += usd;
    return this;
  }

  private reply(call: FakeCall, obligations = false): FakeReply {
    const take = (key: string) => {
      const queue = this.scripts.get(key);
      return queue?.length ? (queue.length > 1 ? queue.shift()! : queue[0]!) : undefined;
    };
    if (obligations) return take(`obligations:${call.subjectRef}`) ?? this.lastReply.get(call.subjectRef) ?? this.reply(call);
    const r = take(`${call.kind}:${call.subjectRef}`) ?? take(call.kind) ?? this.o.responder?.(call) ?? { json: {} };
    this.lastReply.set(call.subjectRef, r);
    return r;
  }

  private usage(batch: boolean, extra?: Partial<LlmUsage>, p?: RouteParams): LlmUsage {
    const t = this.o.tokens ?? { input: 1000, output: 200 };
    const counts = {
      inputTokens: t.input,
      outputTokens: t.output,
      cacheReadInputTokens: t.cacheRead ?? 0,
      cacheCreationInputTokens: t.cacheWrite ?? 0,
    };
    const model = p?.model ?? LLM_MODEL;
    return { ...counts, costUsd: costUsd(counts, batch ? 'batch' : 'sync', p?.cacheTtl ?? '1h', model), batch, servedByModel: model, fallbackUsed: false, ...extra };
  }

  canSpend(pool: BudgetPool = 'steady', estimateUsd = 0): SpendCheck {
    if (!this.configured) return { ok: false, reason: 'no_key' };
    const cap = this.o.budget?.[pool] ?? null;
    if (cap !== null && this.spent[pool] + estimateUsd >= cap) return { ok: false, reason: pool === 'steady' ? 'budget_daily' : 'budget_backfill' };
    return { ok: true };
  }

  private record(method: FakeCall['method'], req: LlmParseRequest<unknown> | LlmToolLoopRequest | LlmBatchItem, customId?: string): FakeCall {
    const p = this.params(req.route);
    const call: FakeCall = {
      method,
      kind: req.kind,
      route: req.route,
      model: p.model,
      thinking: p.thinking,
      subjectRef: req.subjectRef,
      effort: req.effortOverride ?? p.effort,
      maxTokens: req.maxTokens ?? p.maxTokens,
      fallbacks: sendsFallbacks(p, method === 'batch' ? 'batch' : 'sync'),
      system: req.system,
      userText: textOf(req.messages),
      images: 'images' in req ? (req.images?.length ?? 0) : 0,
      ...(customId ? { customId } : {}),
    };
    this.calls.push(call);
    return call;
  }

  private gate(req: { pool?: BudgetPool; estimateUsd?: number }, text: string): { status: 'unavailable'; reason: LlmUnavailableReason } | null {
    const spend = this.canSpend(req.pool ?? 'steady', req.estimateUsd ?? 0);
    if (!spend.ok) return { status: 'unavailable', reason: spend.reason };
    if ((this.o.scanEgress ?? true) && findRawIdentifiers(text).length) return { status: 'unavailable', reason: 'egress_blocked' };
    return null;
  }

  async parse<T>(req: LlmParseRequest<T>): Promise<LlmOutcome<T>> {
    assertCompiles(req.schema);
    const call = this.record('parse', req as LlmParseRequest<unknown>);
    const blocked = this.gate(req, call.userText);
    if (blocked) return blocked;
    // Like the real client: only a route with an image allowance may carry images.
    if (call.images > this.params(req.route).maxImages) return { status: 'unavailable', reason: 'egress_blocked' };
    const requestId = `fake_req_${++this.reqSeq}`;
    const r = this.reply(call, req.schema === (ExtractionObligations as unknown));
    return this.settle(r, req.schema, req.validate, requestId, req.pool ?? 'steady', this.params(req.route));
  }

  private settle<T>(r: FakeReply, schema: z.ZodType<T>, validate: ((v: T) => string[]) | undefined, requestId: string, pool: BudgetPool, p?: RouteParams): LlmOutcome<T> {
    if ('throws' in r) throw new Error(r.throws);
    if ('unavailable' in r) return { status: 'unavailable', reason: r.unavailable };
    const usage = this.usage(false, 'usage' in r ? r.usage : undefined, p);
    this.spent[pool] += usage.costUsd;
    if ('refusal' in r) return { status: 'refused', category: r.refusal, usage, requestId };
    if ('maxTokens' in r) return { status: 'max_tokens', partialText: r.partialText ?? '', usage, requestId };
    if ('toolCalls' in r) return this.settle(r.then, schema, validate, requestId, pool, p);
    if (!('json' in r) && !('text' in r)) throw new Error('FakeLlmClient: batch-only reply used for a sync call');
    const text = 'json' in r ? JSON.stringify(r.json) : r.text;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { status: 'invalid', issues: ['not JSON'], text, usage, requestId };
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) return { status: 'invalid', issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`), text, usage, requestId };
    const problems = validate?.(parsed.data) ?? [];
    if (problems.length) return { status: 'invalid', issues: problems, text, usage, requestId };
    return { status: 'ok', value: parsed.data, text, usage, requestId };
  }

  async runTools(req: LlmToolLoopRequest): Promise<LlmToolLoopOutcome> {
    const call = this.record('runTools', req);
    const blocked = this.gate(req, call.userText);
    if (blocked) return blocked;
    const requestId = `fake_req_${++this.reqSeq}`;
    let r = this.reply(call);
    let toolCalls = 0;
    const citableIds: string[] = [];
    const usage = this.usage(false, undefined, this.params(req.route));
    while ('toolCalls' in r) {
      for (const [i, tc] of r.toolCalls.entries()) {
        if (toolCalls >= req.maxToolCalls) return { status: 'tool_limit', text: '', toolCalls, citableIds, usage, requestId };
        if (req.signal?.aborted) return { status: 'unavailable', reason: 'aborted' };
        const tcall = { id: `toolu_fake_${toolCalls}_${i}`, name: tc.name, input: tc.input };
        req.onToolStatus?.(tcall, 'running');
        try {
          const result = await req.executeTool(tcall);
          citableIds.push(...(result.citableIds ?? []));
          req.onToolStatus?.(tcall, result.isError ? 'error' : 'done');
        } catch {
          req.onToolStatus?.(tcall, 'error');
        }
        toolCalls++;
      }
      r = r.then;
    }
    if ('throws' in r) throw new Error(r.throws);
    if ('unavailable' in r) return { status: 'unavailable', reason: r.unavailable };
    if ('refusal' in r) return { status: 'refused', category: r.refusal, text: '', usage, requestId };
    if ('maxTokens' in r) return { status: 'max_tokens', text: r.partialText ?? '', toolCalls, citableIds, usage, requestId };
    const text = 'text' in r ? r.text : 'json' in r ? JSON.stringify(r.json) : '';
    // Stream it in a few deltas, like the real client.
    for (const piece of text.match(/.{1,16}/gs) ?? []) req.onTextDelta?.(piece);
    this.spent[req.pool ?? 'steady'] += usage.costUsd;
    return { status: 'ok', text, toolCalls, citableIds, usage, requestId };
  }

  async submitBatch(items: LlmBatchItem[], _o: { purpose: string; runId: string }): Promise<LlmBatchSubmit> {
    const pool = items[0]?.pool ?? 'steady';
    const spend = this.canSpend(pool);
    if (!spend.ok) return { status: 'unavailable', reason: spend.reason };
    for (const it of items) {
      assertCompiles(it.schema);
      if ((this.o.scanEgress ?? true) && findRawIdentifiers(textOf(it.messages)).length) return { status: 'unavailable', reason: 'egress_blocked' };
    }
    const batchId = `msgbatch_fake_${++this.batchSeq}`;
    this.batches.set(batchId, items);
    for (const it of items) this.record('batch', it, it.customId);
    return { status: 'submitted', batchId, count: items.length };
  }

  async batchStatus(batchId: string): Promise<LlmBatchStatus> {
    const n = this.batches.get(batchId)?.length ?? 0;
    return { batchId, processing: 'ended', counts: { processing: 0, succeeded: n, errored: 0, canceled: 0, expired: 0 }, endedAt: 0 };
  }

  async *batchResults(batchId: string): AsyncIterable<LlmBatchResult> {
    // Replies are picked in submission order (a window's obligations request follows its knowledge request), then
    // returned in reverse: any order, callers must key by customId.
    const answered = (this.batches.get(batchId) ?? []).map((it) => ({ it, r: this.reply(this.calls.find((c) => c.customId === it.customId)!, OBLIGATIONS_ID.test(it.customId)) }));
    for (const { it, r } of answered.reverse()) {
      if ('batchError' in r) yield { customId: it.customId, type: 'errored', errorType: r.batchError, message: 'fake error' };
      else if ('expired' in r) yield { customId: it.customId, type: 'expired' };
      else if ('canceled' in r) yield { customId: it.customId, type: 'canceled' };
      else {
        const usage = this.usage(true, 'usage' in r ? r.usage : undefined, this.params(it.route));
        this.spent[it.pool ?? 'steady'] += usage.costUsd;
        if ('refusal' in r) yield { customId: it.customId, type: 'succeeded', stopReason: 'refusal', text: null, refusalCategory: r.refusal, usage };
        else if ('maxTokens' in r) yield { customId: it.customId, type: 'succeeded', stopReason: 'max_tokens', text: r.partialText ?? '', refusalCategory: null, usage };
        else if ('json' in r || 'text' in r)
          yield { customId: it.customId, type: 'succeeded', stopReason: 'end_turn', text: 'json' in r ? JSON.stringify(r.json) : r.text, refusalCategory: null, usage };
        else yield { customId: it.customId, type: 'errored', errorType: 'other', message: 'unscriptable reply for a batch' };
      }
    }
  }

  spend(): LlmSpend {
    return {
      todayUsd: this.spent.steady,
      monthUsd: this.spent.steady,
      backfillUsd: this.spent.backfill,
      dailyBudgetUsd: this.o.budget?.steady ?? 1,
      monthlyBudgetUsd: 10,
      backfillBudgetUsd: this.o.budget?.backfill ?? 20,
      requestsToday: this.calls.length,
      cacheHitRate: null,
    };
  }
}

/**
 * Minimal deterministic egress: people become P<n> in order of first use, the owner ME; known first+last names
 * collapse to first + initial; phones/emails/@handles are replaced; scan() fails closed like the real one.
 */
export class FakeEgress implements Egress {
  private readonly tokens = new Map<string, string>();
  private readonly targets = new Map<string, TokenTarget>();

  tokenFor(personId: string): string {
    let t = this.tokens.get(personId);
    if (!t) {
      t = `P${(this.tokens.size + 1).toString(36)}`;
      this.tokens.set(personId, t);
      this.targets.set(t, { kind: 'person', id: personId });
    }
    return t;
  }

  resolveToken(token: string): TokenTarget | null {
    return this.targets.get(token) ?? null;
  }

  pseudonymize(packet: EgressPacket): PseudonymizedPacket {
    const tokenMap: TokenMap = {};
    const replaced: Record<string, number> = {};
    const bump = (k: string) => (replaced[k] = (replaced[k] ?? 0) + 1);
    for (const p of packet.people ?? []) {
      const t = p.isMe ? 'ME' : this.tokenFor(p.personId);
      tokenMap[t] = p.isMe ? { kind: 'me', id: p.personId } : { kind: 'person', id: p.personId };
    }
    const sections = packet.sections.map((s) => {
      let text = s.text
        .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, () => (bump('email'), '<email>'))
        .replace(/(?:\+\d[\d\s().-]{6,18}\d)|(?:\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b)/g, () => (bump('phone'), '<phone>'))
        .replace(/(?<![A-Za-z0-9._%+-])@[A-Za-z0-9._]{2,30}\b/g, () => (bump('handle'), '<handle>'));
      for (const p of packet.people ?? []) {
        if (p.firstName && p.lastName) {
          text = text.split(`${p.firstName} ${p.lastName}`).join(`${p.firstName} ${p.lastName[0]}.`);
        }
      }
      return { name: s.name, text };
    });
    return { sections, text: sections.map((s) => `### ${s.name}\n${s.text}`).join('\n\n'), tokenMap, replaced };
  }

  scan(text: string): void {
    const f = findRawIdentifiers(text);
    if (f.length) throw new EgressBlocked(f);
  }

  detokenize(text: string, map: TokenMap): string {
    return text.replace(/\b(P[0-9a-z]+|ME)\b/g, (t) => (map[t] ? `[${map[t]!.kind}:${map[t]!.id}]` : t));
  }
}
