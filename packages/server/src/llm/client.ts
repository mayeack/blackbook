/**
 * The Anthropic-backed LlmClient (contract and semantics: llm/types.ts). Built only by services.ts; the SDK is
 * constructed with llm/egress.ts' egressFetch and nothing else, so every byte that leaves passes the choke point.
 *
 * Every request is built from its ROUTE (llm/models.ts, + settings llm.route_overrides) by requestParams():
 * model, max_tokens, thinking ({type:'disabled'} on structured-output routes; adaptive for the Ask loop; Sonnet's
 * thinking-off is 'between_tools'), output_config.effort (always explicit), a byte-stable system block with
 * cache_control at the route's TTL. Never: temperature / top_p / top_k, an assistant prefill, or `fallbacks` on a
 * model without server-side fallback (Haiku 5.5) or in a batch. requestIssues() re-checks the final shape and
 * promptTokens() keeps every prompt ≤ PROMPT_TOKEN_LIMIT (above it Haiku bills at 5×): a request that fails either is
 * never sent.
 *
 *   parse()        one synchronous structured-output call. stop_reason is checked BEFORE content; the text block
 *                  is read BY TYPE (after the last `fallback` block, when a fallback served it); zod + the
 *                  caller's `validate` decide ok/invalid. A refusal is recorded ('refused') and returned: no retry.
 *   runTools()     a read-only tool loop: strict tools, tool_choice auto, append-only history (response.content
 *                  echoed unchanged; after a mid-output fallback minus the declined attempt's thinking/tool_use
 *                  blocks), tool results pseudonymized and wrapped as untrusted data, ≤ maxToolCalls /
 *                  ASK_MAX_INPUT_TOKENS, and results that would push the NEXT request past PROMPT_TOKEN_LIMIT
 *                  (judged from this request's actual usage) replaced by the budget note; streamed text
 *                  de-tokenized locally. Caching: the explicit system
 *                  breakpoint caches tools + system; top-level automatic caching (5 min) puts the moving breakpoint
 *                  on the last user message, so every turn reads the previous turns from the cache.
 *   submitBatch()  ledger rows first, then one Message Batch (≤5,000 items, sorted by route so items that share a
 *                  prefix sit together, NO fallbacks). batchStatus() / batchResults() keep llm_batches /
 *                  llm_requests current; results are keyed by custom_id and replayed from the ledger once fetched.
 *
 * Usage is recorded per request (input, output, cache_read, cache_creation tokens) and priced per model with the
 * cache multipliers, the batch discount and Haiku's >100K rate card (llm/models.ts priceTokens). A response whose
 * actual prompt went over PROMPT_TOKEN_LIMIT (the guard is an estimate) logs `llm_prompt_over_limit`.
 * Budget: every call checks key, llm.enabled and the caps first (ledger.checkSpend) and answers 'unavailable'
 * instead of spending. Nothing here throws for API, refusal, budget or egress outcomes. Logs carry counts only; a
 * failed API call adds its content-free apiErrorCode and request id (never the API's message), and the ledger row's
 * error_type carries the same code.
 */
import { createHash } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';
import { tx } from '../db/tx';
import type { DB } from '../db/connection';
import { nullLogger, type Logger } from '../ops/logger';
import { readSetting } from '../settings/registry';
import { outputFormat, systemBlocks, type CacheTtl, type JsonOutputFormat } from './caching';
import { DeltaDetokenizer, EGRESS_BLOCKED_HEADER, egressFetch, imageHash, personIdsIn, scanText, userTextOfParams, type MediaApproval } from './egress';
import * as ledger from './ledger';
import {
  estimatePromptTokens,
  FALLBACK_BETA,
  IMAGE_MAX_BASE64_CHARS,
  IMAGE_MAX_TOKENS,
  isAllowedModel,
  priceTokens,
  PROMPT_TOKEN_LIMIT,
  requestCacheTtl,
  resolveRoute,
  sendsFallbacks,
  supportsSyncFallbacks,
  thinkingParam,
  WEB_SEARCH_USD,
  type LlmRoute,
  type RouteOverrides,
  type RouteParams,
} from './models';
import {
  ASK_MAX_INPUT_TOKENS,
  ASK_MAX_TOOL_CALLS,
  EgressBlocked,
  LLM_IMAGE_TYPES,
  LLM_MODEL,
  parseCustomId,
  ZERO_USAGE,
  type BudgetPool,
  type Egress,
  type LlmBatchItem,
  type LlmBatchResult,
  type LlmBatchStatus,
  type LlmBatchSubmit,
  type LlmClient,
  type LlmEffort,
  type LlmImage,
  type LlmOutcome,
  type LlmParseRequest,
  type LlmSpend,
  type LlmStopReason,
  type LlmTool,
  type LlmToolCall,
  type LlmToolLoopOutcome,
  type LlmToolLoopRequest,
  type LlmToolResult,
  type LlmUnavailable,
  type LlmUnavailableReason,
  type LlmUsage,
  type LlmSearchLocation,
  type LlmSearchResult,
  type LlmWebSearchOutcome,
  type LlmWebSearchRequest,
  type SpendCheck,
} from './types';

export interface LlmClientOptions {
  db: DB;
  /** ANTHROPIC_API_KEY (null = not configured). Never log it. */
  apiKey: string | null;
  egress: Egress;
  log?: Logger;
  /** The transport under the egress guard (default: global fetch; tests: a fake). */
  fetch?: typeof fetch;
  now?: () => number;
  /** SDK retries for 429 / 5xx / connection errors (default 2). */
  maxRetries?: number;
}

/** Items per Message Batch (well under the API's 100k / 256 MB, to limit the blast radius). */
export const MAX_BATCH_ITEMS = 5000;

const unavailable = (reason: LlmUnavailableReason, detail?: string): LlmUnavailable =>
  detail ? { status: 'unavailable', reason, detail } : { status: 'unavailable', reason };

// ---------------------------------------------------------------------------------------------- the inert client

/** A client that never calls anything: every request answers 'unavailable'. With a db, spend() reads the ledger. */
export function unavailableLlmClient(reason: LlmUnavailableReason = 'no_key', db?: DB): LlmClient {
  const out = unavailable(reason);
  const empty: LlmSpend = {
    todayUsd: 0,
    monthUsd: 0,
    backfillUsd: 0,
    dailyBudgetUsd: 0,
    monthlyBudgetUsd: 0,
    backfillBudgetUsd: 0,
    requestsToday: 0,
    cacheHitRate: null,
  };
  return {
    model: LLM_MODEL,
    configured: false,
    params: (route) => resolveRoute(route, db ? routeOverrides(db) : null),
    canSpend: () => ({ ok: false, reason }),
    parse: async () => out,
    runTools: async () => out,
    webSearch: async () => out,
    submitBatch: async () => out,
    batchStatus: async (batchId) => ({
      batchId,
      processing: 'ended',
      counts: { processing: 0, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
      endedAt: null,
    }),
    batchResults: async function* () {},
    spend: () => (db ? ledger.spendSnapshot(db, Date.now()) : empty),
  };
}

export function createLlmClient(o: LlmClientOptions): LlmClient {
  return o.apiKey ? new AnthropicLlmClient({ ...o, apiKey: o.apiKey }) : unavailableLlmClient('no_key', o.db);
}

// ---------------------------------------------------------------------------------------------- response helpers

interface UsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: { ephemeral_1h_input_tokens?: number | null; ephemeral_5m_input_tokens?: number | null } | null;
  iterations?: ({ type: string; model?: string | null } & Partial<UsageLike>)[] | null;
}

/**
 * Usage → token counts and cost. With server-side fallbacks `usage.iterations` is the per-attempt source of truth
 * (top-level usage covers only the attempt that answered); the served-by signal is a `fallback_message` entry. Each
 * attempt is priced on its own model's card (llm/models.ts); a model outside the table (a fallback's, e.g. Sonnet 5
 * behind Sonnet 5.5, same prices) is priced like the requested one. Cache writes are split by TTL from
 * usage.cache_creation when present, else all at `defaultTtl` (the route's).
 */
export function usageFrom(msg: { model?: string | null; usage: UsageLike }, mode: 'sync' | 'batch', defaultTtl: CacheTtl = '1h', requestModel: string = LLM_MODEL): LlmUsage {
  const iters = (msg.usage.iterations ?? []).filter((i) => i.type === 'message' || i.type === 'fallback_message');
  const parts: (UsageLike & { model?: string | null })[] = iters.length ? (iters as unknown as (UsageLike & { model?: string | null })[]) : [{ ...msg.usage, model: msg.model ?? null }];
  const t = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
  let cost = 0;
  for (const p of parts) {
    const created = p.cache_creation_input_tokens ?? 0;
    const read = p.cache_read_input_tokens ?? 0;
    let c5m: number;
    let c1h: number;
    if (p.cache_creation) {
      c5m = Math.min(created, p.cache_creation.ephemeral_5m_input_tokens ?? 0);
      c1h = Math.max(p.cache_creation.ephemeral_1h_input_tokens ?? 0, created - c5m);
    } else {
      c5m = defaultTtl === '5m' ? created : 0;
      c1h = created - c5m;
    }
    t.inputTokens += p.input_tokens ?? 0;
    t.outputTokens += p.output_tokens ?? 0;
    t.cacheReadInputTokens += read;
    t.cacheCreationInputTokens += created;
    const model = p.model && isAllowedModel(p.model) ? p.model : requestModel;
    cost += priceTokens({ input: p.input_tokens ?? 0, output: p.output_tokens ?? 0, cacheRead: read, cacheWrite5m: c5m, cacheWrite1h: c1h }, { model, mode });
  }
  return {
    ...t,
    costUsd: cost,
    batch: mode === 'batch',
    servedByModel: msg.model ?? null,
    fallbackUsed: (msg.usage.iterations ?? []).some((i) => i.type === 'fallback_message'),
  };
}

/**
 * Whole-prompt sizes (uncached + cache read + cache write) of the attempts in a response's usage that went over
 * PROMPT_TOKEN_LIMIT, i.e. were billed on Haiku's long-context card. [] = none.
 */
export function promptsOverLimit(usage: UsageLike): number[] {
  const iters = (usage.iterations ?? []).filter((i) => i.type === 'message' || i.type === 'fallback_message');
  const parts: Partial<UsageLike>[] = iters.length ? iters : [usage];
  return parts.map((p) => (p.input_tokens ?? 0) + (p.cache_read_input_tokens ?? 0) + (p.cache_creation_input_tokens ?? 0)).filter((n) => n > PROMPT_TOKEN_LIMIT);
}

export function addUsage(a: LlmUsage, b: LlmUsage): LlmUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    costUsd: a.costUsd + b.costUsd,
    batch: a.batch && b.batch,
    servedByModel: b.servedByModel ?? a.servedByModel,
    fallbackUsed: a.fallbackUsed || b.fallbackUsed,
  };
}

/** Index of the first block after the last `fallback` switch point (0 when no fallback served the response). */
export function afterLastFallback(content: readonly { type: string }[]): number {
  let start = 0;
  content.forEach((b, i) => {
    if (b.type === 'fallback') start = i + 1;
  });
  return start;
}

/**
 * The answer text, read BY TYPE: text blocks after the last `fallback` switch point (thinking blocks, possibly
 * empty, and a declined attempt's partial output come first). Null when there is no text block.
 */
export function finalText(content: readonly { type: string }[]): string | null {
  const texts = content.slice(afterLastFallback(content)).filter((b): b is { type: 'text'; text: string } => b.type === 'text' && typeof (b as { text?: unknown }).text === 'string');
  return texts.length ? texts.map((b) => b.text).join('') : null;
}

/**
 * The assistant content to echo back in a tool loop. Unchanged without a fallback; after a mid-output fallback the
 * declined attempt's model-internal blocks (thinking, redacted_thinking, tool_use, anything not text) before the
 * last `fallback` marker are omitted (model-migration "Echoing fallback turns back"); its text blocks and the marker
 * stay, everything after the boundary echoes normally.
 */
export function echoContent<T extends { type: string }>(content: readonly T[]): readonly T[] {
  const start = afterLastFallback(content);
  return start === 0 ? content : content.filter((b, i) => i >= start || b.type === 'text' || b.type === 'fallback');
}

/** Hard ceiling on searches in one webSearch() call, whatever the caller asks (each is billed). */
export const MAX_WEB_SEARCHES = 12;
/** pause_turn continuations of one webSearch() call. */
export const MAX_PAUSE_TURNS = 2;

/** The server-side web_search tool (basic version: results go straight into the context; no code execution). */
export function webSearchTool(maxUses: number, location?: LlmSearchLocation | null, blockedDomains?: readonly string[]): Record<string, unknown> {
  const tool: Record<string, unknown> = { type: 'web_search_20250305', name: 'web_search', max_uses: maxUses };
  if (location?.city) {
    tool.user_location = {
      type: 'approximate',
      city: location.city,
      ...(location.region ? { region: location.region } : {}),
      ...(location.country ? { country: location.country } : {}),
      ...(location.timezone ? { timezone: location.timezone } : {}),
    };
  }
  if (blockedDomains?.length) tool.blocked_domains = [...blockedDomains];
  return tool;
}

/**
 * What a web-search answer's content says: the queries, every result page (deduplicated by URL, in order), the
 * search errors, and the final text — the text blocks after the last search result (the model narrates before and
 * between searches). Exported for tests.
 */
export function readSearchContent(content: readonly unknown[]): { text: string; results: LlmSearchResult[]; queries: string[]; errors: string[] } {
  const results = new Map<string, LlmSearchResult>();
  const queries: string[] = [];
  const errors: string[] = [];
  let lastResult = -1;
  content.forEach((raw, i) => {
    const b = raw as { type?: string; name?: string; input?: { query?: unknown }; content?: unknown };
    if (b.type === 'server_tool_use' && b.name === 'web_search' && typeof b.input?.query === 'string') queries.push(b.input.query.slice(0, 200));
    if (b.type !== 'web_search_tool_result') return;
    lastResult = i;
    if (!Array.isArray(b.content)) {
      const code = (b.content as { error_code?: unknown } | null)?.error_code;
      errors.push(typeof code === 'string' ? code.slice(0, 40) : 'unknown');
      return;
    }
    for (const r of b.content as { type?: string; url?: unknown; title?: unknown; page_age?: unknown }[]) {
      if (r?.type !== 'web_search_result' || typeof r.url !== 'string' || results.has(r.url)) continue;
      results.set(r.url, { url: r.url, title: typeof r.title === 'string' ? r.title.slice(0, 300) : '', pageAge: typeof r.page_age === 'string' ? r.page_age.slice(0, 60) : null });
    }
  });
  const after = content.slice(lastResult + 1) as { type: string }[];
  const text = finalText(after) ?? finalText(content as { type: string }[]) ?? '';
  return { text, results: [...results.values()], queries, errors };
}

const refusalCategory = (m: unknown): string | null => (m as { stop_details?: { category?: string | null } | null }).stop_details?.category ?? null;

/** The API's error `type`s (SDK ErrorType + request_too_large); anything else is classified as 'other'. */
const API_ERROR_TYPES: ReadonlySet<string> = new Set([
  'invalid_request_error',
  'authentication_error',
  'permission_error',
  'not_found_error',
  'request_too_large',
  'rate_limit_error',
  'timeout_error',
  'overloaded_error',
  'api_error',
  'billing_error',
]);

/**
 * Known API error messages → a fixed code, first match wins (structured-outputs limits, the measured grammar cap,
 * and the 400s this client's request shape can run into on Haiku 5.5 / Sonnet 5.5). Only the code is ever logged or
 * stored, never the message (it can echo request content): words echoed from a prompt can at worst pick the
 * wrong code, never leak. 'unrecognized' = a message outside the list (look the request id up in the Console).
 */
export const API_ERROR_CODES: readonly (readonly [RegExp, string])[] = [
  [/too complex for compilation/i, 'schema_too_complex'],
  [/grammar is too large/i, 'grammar_too_large'],
  [/\bunion/i, 'strict_union_limit'],
  [/optional param/i, 'strict_optional_limit'],
  [/\bstrict\b/i, 'strict_tools'],
  [/prompt is too long/i, 'prompt_too_long'],
  [/tool_choice/i, 'tool_choice'],
  [/prefill|must end with a user/i, 'prefill'],
  [/expected `?(redacted_)?thinking/i, 'thinking_blocks'],
  [/tool_use|tool_result/i, 'tool_pairing'],
  [/signature/i, 'thinking_signature'],
  [/thinking|effort/i, 'thinking_effort'],
  [/cache_control/i, 'cache_control'],
  [/temperature|top_p|top_k/i, 'sampling_param'],
  [/max_tokens/i, 'max_tokens'],
  [/input_schema|json schema|output_config|additionalProperties/i, 'schema_unsupported'],
  [/fallback|anthropic-beta/i, 'fallbacks_beta'],
  [/extra inputs|not permitted|unexpected/i, 'unknown_field'],
  [/credit balance/i, 'credit_balance'],
];

/** Request fields an API error message may start with ("tools.3.custom.input_schema: …"). */
const ERROR_PATH_ROOTS: ReadonlySet<string> = new Set(['model', 'messages', 'system', 'tools', 'tool_choice', 'thinking', 'output_config', 'max_tokens', 'cache_control', 'fallbacks', 'metadata', 'stop_sequences']);
const ERROR_PATH_KEYS: ReadonlySet<string> = new Set(['content', 'custom', 'input_schema', 'cache_control', 'format', 'schema', 'effort', 'type', 'name', 'input', 'text', 'thinking', 'signature', 'source']);

/**
 * The leading field path of an API error message ("tools.3.custom.input_schema: …" → "tools.3.custom"): a root from
 * ERROR_PATH_ROOTS, then up to two indices or ERROR_PATH_KEYS words (stopping at the first other segment); null if
 * the message doesn't start with one.
 */
function apiErrorPath(message: string): string | null {
  const segs = /^[a-z_]+(?:\.[a-z0-9_]{1,24}){0,2}(?=[.:\s])/.exec(message)?.[0].split('.') ?? [];
  if (!ERROR_PATH_ROOTS.has(segs[0] ?? '')) return null;
  const keep = [segs[0]!];
  for (const s of segs.slice(1)) {
    if (!/^\d{1,4}$/.test(s) && !ERROR_PATH_KEYS.has(s)) break;
    keep.push(s);
  }
  return keep.join('.');
}

/**
 * A content-free classification of an API error: `{type}:{code}[:{path}]`, e.g.
 * `invalid_request_error:strict_union_limit:tools.3.custom`. Built only from fixed vocabularies (API_ERROR_TYPES,
 * API_ERROR_CODES, apiErrorPath), so it is safe to log and store; ≤80 characters (the logger's token limit).
 */
export function apiErrorCode(e: InstanceType<typeof Anthropic.APIError>): string {
  // HTTP errors carry the body in e.error; an SSE `error` event mid-stream has the same shape without a status.
  return errorBodyCode(e.error, e.type);
}

/** apiErrorCode of an error body `{type:'error', error:{type, message}}` (also a batch item's `result.error`). */
export function errorBodyCode(errorBody: unknown, typeHint?: string | null): string {
  const body = (errorBody ?? {}) as { error?: { type?: unknown; message?: unknown } };
  const rawType = typeHint ?? body.error?.type;
  const type = typeof rawType === 'string' && API_ERROR_TYPES.has(rawType) ? rawType : 'other';
  const message = typeof body.error?.message === 'string' ? body.error.message : '';
  const code = message ? (API_ERROR_CODES.find(([re]) => re.test(message))?.[1] ?? 'unrecognized') : 'no_message';
  const path = apiErrorPath(message);
  const full = path ? `${type}:${code}:${path}` : `${type}:${code}`;
  return full.length <= 80 ? full : `${type}:${code}`;
}

/**
 * SDK error → 'unavailable'. Never the error message (it may echo request content): API errors carry the
 * content-free apiErrorCode and the request id instead.
 */
export function unavailableFromError(e: unknown): LlmUnavailable {
  if (e instanceof EgressBlocked) return unavailable('egress_blocked');
  if (e instanceof Anthropic.APIUserAbortError) return unavailable('aborted');
  if (e instanceof Anthropic.APIError) {
    if (e.headers?.get(EGRESS_BLOCKED_HEADER)) return unavailable('egress_blocked');
    if (e instanceof Anthropic.RateLimitError) return unavailable('rate_limited');
    if (e instanceof Anthropic.APIConnectionError) return unavailable('api_error', e.constructor.name);
    const out: LlmUnavailable = { ...unavailable('api_error', `${e.constructor.name}${e.status ? `:${e.status}` : ''}`), errorCode: apiErrorCode(e) };
    if (typeof e.requestID === 'string' && REQUEST_ID_RE.test(e.requestID)) out.apiRequestId = e.requestID;
    return out;
  }
  if (e instanceof Error && e.name === 'AbortError') return unavailable('aborted');
  return unavailable('api_error', e instanceof Error ? e.constructor.name : 'unknown');
}

const REQUEST_ID_RE = /^req_[A-Za-z0-9]{1,64}$/;

/** The ledger's error_type for a failed sync call: the reason, plus the API error code when there is one. */
const ledgerErrorType = (u: LlmUnavailable): string => (u.errorCode ? `${u.reason}:${u.errorCode}` : u.reason);

/** llm_call_failed / llm_batch_submit_failed fields: class, content-free code, request id. */
const failureFields = (u: LlmUnavailable) => ({
  error_class: u.detail ?? u.reason,
  ...(u.errorCode ? { error_code: u.errorCode } : {}),
  ...(u.apiRequestId ? { request_id: u.apiRequestId } : {}),
});

const inputHash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 32);
const yieldLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Tool output as clearly-labelled untrusted data (there are no write tools; injection can only touch the answer). */
export function wrapUntrusted(tool: string, content: string): string {
  const safe = content.replace(/<\/?tool_output/gi, (m) => m.replace('<', '‹'));
  return `<tool_output name="${tool.replace(/[^A-Za-z0-9_-]/g, '')}" trust="untrusted">\n${safe}\n</tool_output>`;
}

const TOOL_BUDGET_NOTE = 'Tool budget reached: answer now with what you already have.';
const budgetNote = (toolUseId: string) => ({ type: 'tool_result' as const, tool_use_id: toolUseId, is_error: true, content: TOOL_BUDGET_NOTE });
/** Headroom under PROMPT_TOKEN_LIMIT for the next tool-loop request (JSON framing the per-part estimates miss). */
const NEXT_PROMPT_MARGIN = 512;

// ---------------------------------------------------------------------------------------------- request shape

/** The owner's per-route overrides (settings llm.route_overrides; invalid entries never get past the registry). */
export function routeOverrides(db: DB): RouteOverrides {
  return readSetting(db, 'llm.route_overrides') as RouteOverrides;
}

/** A route's effective parameters, with the evaluation-only effort override applied. */
export function effectiveParams(base: RouteParams, effortOverride?: LlmEffort): RouteParams {
  return effortOverride && effortOverride !== base.effort ? { ...base, effort: effortOverride, overridden: true } : base;
}

export interface RequestShapeInput {
  system: string;
  messages: readonly unknown[];
  maxTokens?: number;
  /** Structured output (parse / batch items). */
  format?: JsonOutputFormat;
  tools?: readonly LlmTool[];
  mode: 'sync' | 'batch';
}

/**
 * The Messages API body for a request on `p`, in render order tools → system → messages: tools sorted by name
 * (byte-stable), the system prompt as one block with cache_control at the route's TTL (5 min for a sync call on a
 * batch route; none on a route without a TTL), top-level automatic caching (5 min) only for tool loops. No sampling parameters, ever. `fallbacks` + beta only on sync calls to a model that
 * supports server-side fallback.
 */
export function requestParams(p: RouteParams, i: RequestShapeInput): Record<string, unknown> {
  const body: Record<string, unknown> = { model: p.model, max_tokens: i.maxTokens ?? p.maxTokens, thinking: thinkingParam(p) };
  if (i.tools) {
    body.tools = [...i.tools]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema, strict: true }));
    body.tool_choice = { type: 'auto' };
  }
  body.system = systemBlocks(i.system, requestCacheTtl(p, i.mode));
  body.messages = i.messages;
  body.output_config = i.format ? { effort: p.effort, format: i.format } : { effort: p.effort };
  // Tool loops: the moving breakpoint on the newest block (the last user message / tool results), 5 minutes.
  if (i.tools) body.cache_control = { type: 'ephemeral', ttl: '5m' };
  if (sendsFallbacks(p, i.mode)) {
    body.betas = [FALLBACK_BETA];
    body.fallbacks = 'default';
  }
  return body;
}

const SAMPLING_KEYS = ['temperature', 'top_p', 'top_k'] as const;

/** Strict tool schemas, summed over all tools in a request (above either the API answers 400). */
export const STRICT_MAX_UNION_PARAMS = 16;
export const STRICT_MAX_OPTIONAL_PARAMS = 24;

/**
 * The size of the grammar the API compiles from a request's strict schemas (output_config.format plus every strict
 * tool), in schema nodes: one per object, per property and per array, local $refs inlined. Above an unpublished
 * size the API answers 400 "The compiled grammar is too large…", even within the documented union/optional limits.
 * Measured on Haiku 5.5 on 2026-10-18 (all-required schemas): a flat object passed with 70 string properties
 * and failed with 80; nested shapes passed at up to 71 nodes and failed from 72; nullable (string|null) fields and
 * enums cost well under a node each. The one-request extraction schema had 86 nodes, so every extraction request
 * was refused. The budget keeps a margin under the smallest failing size; scripts/llm-schema-smoke.mjs re-measures.
 */
export const GRAMMAR_MAX_NODES = 64;

interface StrictSchema {
  type?: unknown;
  properties?: Record<string, unknown>;
  required?: string[];
  items?: unknown;
  anyOf?: unknown[];
  $ref?: string;
  $defs?: Record<string, unknown>;
}

/** Visits each schema with its local $refs ("#/$defs/…") resolved; false = a reference cycle (never bounded). */
function walkStrict(
  schemas: readonly unknown[],
  on: { object?: () => void; property?: (name: string, p: StrictSchema, parent: StrictSchema) => void; array?: () => void },
): boolean {
  for (const root of schemas) {
    const defs = (root as StrictSchema | null)?.$defs ?? {};
    const resolve = (s: unknown): StrictSchema => {
      const o = (s && typeof s === 'object' ? s : {}) as StrictSchema;
      const m = typeof o.$ref === 'string' ? /^#\/\$defs\/(.+)$/.exec(o.$ref) : null;
      return m ? ((defs[m[1]!] as StrictSchema | undefined) ?? {}) : o;
    };
    const visit = (s: unknown, depth: number): boolean => {
      if (depth > 32) return false;
      const o = resolve(s);
      for (const a of o.anyOf ?? []) if (!visit(a, depth + 1)) return false;
      if (o.type === 'object' || o.properties) {
        on.object?.();
        for (const [k, p] of Object.entries(o.properties ?? {})) {
          on.property?.(k, resolve(p), o);
          if (!visit(p, depth + 1)) return false;
        }
      }
      if (o.type === 'array' || o.items) {
        on.array?.();
        if (o.items !== undefined && !visit(o.items, depth + 1)) return false;
      }
      return true;
    };
    if (!visit(root, 0)) return false;
  }
  return true;
}

/** grammar nodes (see GRAMMAR_MAX_NODES) of a set of strict schemas; Infinity for a recursive schema. */
export function grammarNodes(schemas: readonly unknown[]): number {
  let n = 0;
  const bump = () => void n++;
  return walkStrict(schemas, { object: bump, property: bump, array: bump }) ? n : Number.POSITIVE_INFINITY;
}

/** Parameters with a union type (anyOf / a type array) and optional ones (not in `required`), at any depth. */
export function strictParamCounts(schemas: readonly unknown[]): { union: number; optional: number } {
  const n = { union: 0, optional: 0 };
  walkStrict(schemas, {
    property: (k, p, parent) => {
      if (p.anyOf || Array.isArray(p.type)) n.union++;
      if (!(parent.required ?? []).includes(k)) n.optional++;
    },
  });
  return n;
}

/** Why a set of strict tools would be refused by the API's schema compiler; [] = fine. */
export function strictSchemaIssues(tools: readonly { input_schema?: unknown; strict?: boolean }[]): string[] {
  const n = strictParamCounts(tools.filter((t) => t.strict).map((t) => t.input_schema));
  const issues: string[] = [];
  if (n.union > STRICT_MAX_UNION_PARAMS) issues.push(`${n.union} union-typed tool parameters (max ${STRICT_MAX_UNION_PARAMS})`);
  if (n.optional > STRICT_MAX_OPTIONAL_PARAMS) issues.push(`${n.optional} optional tool parameters (max ${STRICT_MAX_OPTIONAL_PARAMS})`);
  return issues;
}

/**
 * Why a body's strict schemas (output format + strict tools, which the API compiles into one grammar) would be
 * refused: over GRAMMAR_MAX_NODES, or, with an output format, over the union/optional limits counted across both
 * (without one, strictSchemaIssues reports the tools alone). [] = fine.
 */
export function grammarIssues(body: Record<string, unknown>): string[] {
  const tools = Array.isArray(body.tools) ? (body.tools as { input_schema?: unknown; strict?: boolean }[]) : [];
  const format = (body.output_config as { format?: { schema?: unknown } } | undefined)?.format?.schema;
  const strict = tools.filter((t) => t.strict).map((t) => t.input_schema);
  const issues = format === undefined ? strictSchemaIssues(tools) : [];
  const schemas = format === undefined ? strict : [format, ...strict];
  const nodes = grammarNodes(schemas);
  if (nodes > GRAMMAR_MAX_NODES) issues.push(`${nodes} schema nodes in the strict schemas (max ${GRAMMAR_MAX_NODES}: the compiled grammar would be too large)`);
  if (format !== undefined) {
    const n = strictParamCounts(schemas);
    if (n.union > STRICT_MAX_UNION_PARAMS) issues.push(`${n.union} union-typed parameters in the strict schemas (max ${STRICT_MAX_UNION_PARAMS})`);
    if (n.optional > STRICT_MAX_OPTIONAL_PARAMS) issues.push(`${n.optional} optional parameters in the strict schemas (max ${STRICT_MAX_OPTIONAL_PARAMS})`);
  }
  return issues;
}

/** Why a body must not be sent (each would be a 400 or a policy breach on Haiku 5.5); [] = fine. */
export function requestIssues(body: Record<string, unknown>): string[] {
  const issues: string[] = [];
  issues.push(...grammarIssues(body));
  for (const k of SAMPLING_KEYS) if (k in body) issues.push(`sampling parameter ${k}`);
  if (!isAllowedModel(body.model)) issues.push('model not in the allowlist');
  const messages = (body.messages ?? []) as { role?: string }[];
  if (!messages.length || messages[messages.length - 1]!.role !== 'user') issues.push('last message must be a user turn (no prefill)');
  if ('fallbacks' in body && !supportsSyncFallbacks(String(body.model))) issues.push('fallbacks on a model without server-side fallback');
  const thinking = body.thinking as { type?: string } | undefined;
  if (thinking?.type === 'enabled') issues.push('manual thinking budgets are not supported');
  return issues;
}

/**
 * Conservative prompt size of a body (tools + system + messages + output schema; llm/models.ts estimatePromptTokens).
 * An image block counts IMAGE_MAX_TOKENS, not the length of its base64.
 */
export function promptTokens(body: Record<string, unknown>): number {
  let images = 0;
  const media = (_k: string, v: unknown): unknown => {
    if (v && typeof v === 'object' && (v as { type?: unknown }).type === 'image') {
      images++;
      return { type: 'image' };
    }
    return v;
  };
  const parts = [body.tools, body.system, body.messages, (body.output_config as { format?: unknown } | undefined)?.format];
  return parts.reduce<number>((n, x) => n + (x === undefined ? 0 : estimatePromptTokens(JSON.stringify(x, media))), 0) + images * IMAGE_MAX_TOKENS;
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Why `images` can't go out on this route (null = fine): the route's allowance, accepted types, sane base64. */
export function imageIssue(images: readonly LlmImage[], maxImages: number): string | null {
  if (images.length > maxImages) return maxImages ? `more than ${maxImages} images` : 'route takes no images';
  for (const i of images) {
    if (!(LLM_IMAGE_TYPES as readonly string[]).includes(i.mediaType)) return 'image type';
    if (!i.data || i.data.length > IMAGE_MAX_BASE64_CHARS || !BASE64.test(i.data)) return 'image data';
  }
  return null;
}

/** The images go first in the last user turn (the API reads them best before the text). */
export function withImages(messages: readonly Anthropic.MessageParam[], images: readonly LlmImage[]): Anthropic.MessageParam[] {
  if (!images.length) return [...messages];
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user') return [...messages];
  const blocks: Anthropic.ImageBlockParam[] = images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } }));
  const rest = typeof last.content === 'string' ? [{ type: 'text' as const, text: last.content }] : last.content;
  return [...messages.slice(0, -1), { role: 'user', content: [...blocks, ...rest] }];
}

/** requestIssues + the PROMPT_TOKEN_LIMIT guard → the 'unavailable' answer, or null when the body may go out. */
function shapeGate(body: Record<string, unknown>, log: Logger, job: string): LlmUnavailable | null {
  const issues = requestIssues(body);
  if (issues.length) {
    log.error('llm_request_rejected', { job, counts: { issues: issues.length } });
    return unavailable('api_error', `bad_request_shape: ${issues.join('; ')}`);
  }
  if (promptTokens(body) > PROMPT_TOKEN_LIMIT) {
    log.warn('llm_prompt_too_large', { job, counts: { tokens: promptTokens(body) } });
    return unavailable('prompt_too_large');
  }
  return null;
}

// ---------------------------------------------------------------------------------------------- the client

/** THE SDK instance: built on egressFetch and nothing else (test/llm/entryPoint.test.ts). */
function buildSdk(o: { apiKey: string; fetch?: typeof fetch; maxRetries?: number; log: Logger; approveMedia?: MediaApproval }): Anthropic {
  return new Anthropic({
    apiKey: o.apiKey,
    baseURL: 'https://api.anthropic.com',
    fetch: egressFetch({
      fetch: o.fetch ?? globalThis.fetch,
      onBlocked: (e) => o.log.warn('llm_egress_blocked', { counts: Object.fromEntries(e.findings.map((f) => [f.kind, f.count])) }),
      approveMedia: o.approveMedia,
    }),
    maxRetries: o.maxRetries ?? 2,
    logLevel: 'off',
  });
}

export interface SchemaSmokeCase {
  name: string;
  route: LlmRoute;
  /** A structured-output schema (output_config.format) … */
  schema?: z.ZodType;
  /** … and/or strict tools, compiled into the same grammar. */
  tools?: readonly LlmTool[];
}

export interface SchemaSmokeResult {
  name: string;
  model: string;
  nodes: number;
  /** HTTP status; 'local' when requestIssues refused the body; 'not_sent' without an API key (counts only). */
  status: number | 'local' | 'not_sent';
  /** stop_reason on 200; the API's error text otherwise (or the local issues). */
  detail: string;
}

export const SMOKE_SYSTEM = 'You return JSON that matches the given schema.';
export const SMOKE_USER = 'Return an empty result.';

/**
 * Check of the API's schema compiler (`yb llm-smoke`): each case's body is built like a real request on its route
 * (requestParams, then requestIssues); with an API key (opt-in: --live) one tiny synchronous request per case is
 * sent with fixed literal system and user text, so the API compiles exactly the grammar production would send. The
 * request carries no data, so the API's error text is returned as is. No ledger rows, no budget gate: a handful of
 * Haiku calls cost far under a cent. Without a key nothing is sent (node counts and local issues only).
 */
export async function smokeSchemas(o: {
  apiKey: string | null;
  cases: readonly SchemaSmokeCase[];
  overrides?: RouteOverrides | null;
  fetch?: typeof fetch;
  log?: Logger;
}): Promise<SchemaSmokeResult[]> {
  const sdk = o.apiKey ? buildSdk({ apiKey: o.apiKey, fetch: o.fetch, maxRetries: 0, log: o.log ?? nullLogger }) : null;
  const out: SchemaSmokeResult[] = [];
  for (const c of o.cases) {
    const rp = resolveRoute(c.route, o.overrides);
    const body = requestParams(rp, {
      system: SMOKE_SYSTEM,
      messages: [{ role: 'user', content: SMOKE_USER }],
      maxTokens: 2000,
      ...(c.schema ? { format: outputFormat(c.schema) } : {}),
      ...(c.tools ? { tools: c.tools } : {}),
      mode: 'sync',
    });
    const format = (body.output_config as { format?: JsonOutputFormat }).format;
    const strict = ((body.tools ?? []) as { input_schema: unknown }[]).map((t) => t.input_schema);
    const base = { name: c.name, model: rp.model, nodes: grammarNodes(format ? [format.schema, ...strict] : strict) };
    const issues = requestIssues(body);
    if (issues.length) {
      out.push({ ...base, status: 'local', detail: issues.join('; ') });
      continue;
    }
    if (!sdk) {
      out.push({ ...base, status: 'not_sent', detail: '' });
      continue;
    }
    try {
      const msg = await sdk.beta.messages.create(body as unknown as BetaParams);
      out.push({ ...base, status: 200, detail: String(msg.stop_reason) });
    } catch (e) {
      if (e instanceof Anthropic.APIError) {
        const apiText = (e.error as { error?: { message?: unknown } } | undefined)?.error?.message;
        out.push({ ...base, status: e.status ?? 0, detail: typeof apiText === 'string' ? apiText : e.constructor.name });
      } else out.push({ ...base, status: 0, detail: e instanceof Error ? e.constructor.name : 'unknown' });
    }
  }
  return out;
}

type BetaMessage = Anthropic.Beta.Messages.BetaMessage;
type BetaParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
type BetaStreamParams = Parameters<Anthropic['beta']['messages']['stream']>[0];

class AnthropicLlmClient implements LlmClient {
  readonly model = LLM_MODEL;
  readonly configured = true;
  private readonly sdk: Anthropic;
  private readonly db: DB;
  private readonly log: Logger;
  private readonly now: () => number;
  /** Image hashes approved for requests in flight (count per hash): the egress fetch lets exactly these out. */
  private readonly approvedMedia = new Map<string, number>();

  constructor(private readonly o: LlmClientOptions & { apiKey: string }) {
    this.db = o.db;
    this.log = o.log ?? nullLogger;
    this.now = o.now ?? Date.now;
    this.sdk = buildSdk({
      apiKey: o.apiKey,
      fetch: o.fetch,
      maxRetries: o.maxRetries,
      log: this.log,
      approveMedia: (hash) => (this.approvedMedia.get(hash) ?? 0) > 0,
    });
  }

  params(route: LlmRoute): RouteParams {
    return resolveRoute(route, routeOverrides(this.db));
  }

  canSpend(pool: BudgetPool = 'steady', estimateUsd = 0): SpendCheck {
    return ledger.checkSpend(this.db, true, pool, estimateUsd, this.now());
  }

  spend(): LlmSpend {
    return ledger.spendSnapshot(this.db, this.now());
  }

  /** Budget, exclusions and the fail-closed scan, before anything is written or sent. */
  private gate(pool: BudgetPool, estimateUsd: number, userText: string): LlmUnavailable | null {
    return this.spendGate(pool, estimateUsd) ?? this.contentGate(userText, new Set(readSetting(this.db, 'llm.excluded_person_ids')));
  }

  private spendGate(pool: BudgetPool, estimateUsd: number): LlmUnavailable | null {
    const spend = this.canSpend(pool, estimateUsd);
    if (spend.ok) return null;
    this.log.debug('llm_skipped', { counts: { [spend.reason]: 1 } });
    return unavailable(spend.reason);
  }

  /** Excluded people (by their tokens) and the fail-closed raw-identifier scan of the user turns. */
  private contentGate(userText: string, excluded: ReadonlySet<string>): LlmUnavailable | null {
    if (excluded.size && personIdsIn(this.o.egress, userText).some((id) => excluded.has(id))) return unavailable('excluded');
    try {
      scanText(userText);
      this.o.egress.scan(userText);
    } catch (e) {
      if (e instanceof EgressBlocked) {
        this.log.warn('llm_egress_blocked', { counts: Object.fromEntries(e.findings.map((f) => [f.kind, f.count])) });
        return unavailable('egress_blocked');
      }
      throw e;
    }
    return null;
  }

  /** A response billed on the long-context card (the ≤100K guard is an estimate): visible in the logs, counts only. */
  private checkPromptSize(kind: string, usage: UsageLike | null | undefined): void {
    const over = usage ? promptsOverLimit(usage) : [];
    if (over.length) this.log.warn('llm_prompt_over_limit', { job: kind, counts: { attempts: over.length, prompt_tokens: Math.max(...over) } });
  }

  private logCall(event: string, kind: string, usage: LlmUsage | null, extra: Record<string, number> = {}): void {
    this.log.info(event, {
      job: kind,
      counts: usage
        ? { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, cache_read: usage.cacheReadInputTokens, cache_write: usage.cacheCreationInputTokens, ...extra }
        : extra,
    });
  }

  // ---- sync structured output

  async parse<T>(req: LlmParseRequest<T>): Promise<LlmOutcome<T>> {
    const pool = req.pool ?? 'steady';
    const rp = effectiveParams(this.params(req.route), req.effortOverride);
    const images = req.images ?? [];
    const badImages = imageIssue(images, rp.maxImages);
    if (badImages) {
      this.log.warn('llm_images_refused', { job: req.kind, counts: { images: images.length } });
      return unavailable('egress_blocked', badImages);
    }
    const messages = withImages(req.messages, images);
    const params = requestParams(rp, { system: req.system, messages, maxTokens: req.maxTokens, format: outputFormat(req.schema), mode: 'sync' });
    const bad = shapeGate(params, this.log, req.kind);
    if (bad) return bad;
    const blocked = this.gate(pool, req.estimateUsd ?? 0, userTextOfParams(params as { messages: unknown[] }));
    if (blocked) return blocked;

    const started = this.now();
    const id = ledger.syncRequestId(started);
    ledger.insertRequest(
      this.db,
      {
        customId: id,
        kind: req.kind,
        subjectRef: req.subjectRef,
        attempt: 0,
        promptVersion: req.promptVersion,
        model: rp.model,
        inputHash: inputHash(params),
        pool,
        mode: 'sync',
        runId: req.runId ?? null,
        purpose: req.kind,
        effort: rp.effort,
        maxTokens: params.max_tokens as number,
        params: null,
        estimateUsd: req.estimateUsd ?? null,
      },
      started,
    );
    let msg: BetaMessage;
    const hashes = images.map((i) => imageHash(i.data));
    for (const h of hashes) this.approvedMedia.set(h, (this.approvedMedia.get(h) ?? 0) + 1);
    try {
      msg = await this.sdk.beta.messages.create(params as unknown as BetaParams, req.signal ? { signal: req.signal } : undefined);
    } catch (e) {
      const u = unavailableFromError(e);
      ledger.recordOutcome(this.db, id, { status: 'errored', errorType: ledgerErrorType(u) }, this.now());
      this.log.warn('llm_call_failed', { job: req.kind, ...failureFields(u) });
      return u;
    } finally {
      for (const h of hashes) {
        const n = (this.approvedMedia.get(h) ?? 1) - 1;
        if (n > 0) this.approvedMedia.set(h, n);
        else this.approvedMedia.delete(h);
      }
    }
    return this.settleParse(msg, req, id, rp);
  }

  private settleParse<T>(msg: BetaMessage, req: LlmParseRequest<T>, id: string, rp: RouteParams): LlmOutcome<T> {
    const now = this.now();
    const usage = usageFrom(msg as never, 'sync', requestCacheTtl(rp, 'sync') ?? '5m', rp.model);
    const stop = msg.stop_reason as LlmStopReason | null;
    const base = { stopReason: stop, servedByModel: msg.model, usage };
    this.logCall('llm_call', req.kind, usage);
    this.checkPromptSize(req.kind, msg.usage as UsageLike);
    // stop_reason first, content second. A refusal is final here (no automatic retry on another model).
    if (stop === 'refusal') {
      const category = refusalCategory(msg);
      ledger.recordOutcome(this.db, id, { ...base, status: 'refused', refusalCategory: category }, now);
      return { status: 'refused', category, usage, requestId: id };
    }
    const text = finalText(msg.content) ?? '';
    if (stop === 'max_tokens') {
      ledger.recordOutcome(this.db, id, { ...base, status: 'max_tokens', output: text }, now);
      return { status: 'max_tokens', partialText: text, usage, requestId: id };
    }
    const invalid = (issues: string[]): LlmOutcome<T> => {
      ledger.recordOutcome(this.db, id, { ...base, status: 'schema_invalid', output: text }, now);
      return { status: 'invalid', issues, text, usage, requestId: id };
    };
    if (stop !== 'end_turn' && stop !== 'stop_sequence') return invalid([`unexpected stop_reason ${String(stop)}`]);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return invalid(['not JSON']);
    }
    const parsed = req.schema.safeParse(json);
    if (!parsed.success) return invalid(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
    const problems = req.validate?.(parsed.data) ?? [];
    if (problems.length) return invalid(problems);
    ledger.recordOutcome(this.db, id, { ...base, status: 'succeeded', output: text }, now);
    return { status: 'ok', value: parsed.data, text, usage, requestId: id };
  }

  // ---- server-side web search

  async webSearch(req: LlmWebSearchRequest): Promise<LlmWebSearchOutcome> {
    const pool = req.pool ?? 'steady';
    const rp = effectiveParams(this.params(req.route), req.effortOverride);
    const maxSearches = Math.max(1, Math.min(MAX_WEB_SEARCHES, Math.floor(req.maxSearches)));
    const params = requestParams(rp, { system: req.system, messages: req.messages, maxTokens: req.maxTokens, mode: 'sync' });
    params.tools = [webSearchTool(maxSearches, req.location, req.blockedDomains)];
    const bad = shapeGate(params, this.log, req.kind);
    if (bad) return bad;
    // The searches are billed on top of the tokens: the budget check sees the worst case.
    const estimate = (req.estimateUsd ?? 0) + maxSearches * WEB_SEARCH_USD;
    const blocked = this.gate(pool, estimate, userTextOfParams(params as { messages: unknown[] }));
    if (blocked) return blocked;

    const started = this.now();
    const id = ledger.syncRequestId(started);
    ledger.insertRequest(
      this.db,
      {
        customId: id,
        kind: req.kind,
        subjectRef: req.subjectRef,
        attempt: 0,
        promptVersion: req.promptVersion,
        model: rp.model,
        inputHash: inputHash(params),
        pool,
        mode: 'sync',
        runId: req.runId ?? null,
        purpose: req.kind,
        effort: rp.effort,
        maxTokens: params.max_tokens as number,
        params: null,
        estimateUsd: estimate,
      },
      started,
    );
    const content: unknown[] = [];
    let messages: unknown[] = [...req.messages];
    let usage: LlmUsage = ZERO_USAGE;
    let searches = 0;
    let msg: BetaMessage | null = null;
    const withSearches = (): LlmUsage => ({ ...usage, costUsd: usage.costUsd + searches * WEB_SEARCH_USD });
    for (let turn = 0; turn <= MAX_PAUSE_TURNS; turn++) {
      try {
        msg = await this.sdk.beta.messages.create({ ...params, messages } as unknown as BetaParams, req.signal ? { signal: req.signal } : undefined);
      } catch (e) {
        const u = unavailableFromError(e);
        ledger.recordOutcome(this.db, id, { status: 'errored', errorType: ledgerErrorType(u), ...(turn ? { usage: withSearches() } : {}) }, this.now());
        this.log.warn('llm_call_failed', { job: req.kind, ...failureFields(u) });
        return u;
      }
      usage = addUsage(usage, usageFrom(msg as never, 'sync', '5m', rp.model));
      searches += (msg.usage as { server_tool_use?: { web_search_requests?: number | null } | null }).server_tool_use?.web_search_requests ?? 0;
      this.checkPromptSize(req.kind, msg.usage as UsageLike);
      content.push(...msg.content);
      // A paused turn continues with its content echoed back unchanged (the API resumes the same turn).
      if (msg.stop_reason !== 'pause_turn') break;
      messages = [...req.messages, { role: 'assistant', content: [...content] }];
    }
    const total = withSearches();
    const stop = msg!.stop_reason as LlmStopReason | null;
    const base = { stopReason: stop, servedByModel: msg!.model, usage: total };
    this.logCall('llm_call', req.kind, total, { searches });
    if (stop === 'refusal') {
      const category = refusalCategory(msg);
      ledger.recordOutcome(this.db, id, { ...base, status: 'refused', refusalCategory: category }, this.now());
      return { status: 'refused', category, usage: total, requestId: id };
    }
    const read = readSearchContent(content);
    const status = stop === 'end_turn' || stop === 'stop_sequence' ? 'ok' : 'max_tokens';
    ledger.recordOutcome(this.db, id, { ...base, status: status === 'ok' ? 'succeeded' : 'max_tokens', output: read.text.slice(0, 20_000) }, this.now());
    return { status, text: read.text, results: read.results, queries: read.queries, searches, searchErrors: read.errors, usage: total, requestId: id };
  }

  // ---- read-only tool loop

  async runTools(req: LlmToolLoopRequest): Promise<LlmToolLoopOutcome> {
    for (const t of req.tools) {
      if (t.inputSchema.type !== 'object' || t.inputSchema.additionalProperties !== false) {
        throw new Error(`tool ${t.name}: strict tools need an object schema with additionalProperties:false`);
      }
    }
    const pool = req.pool ?? 'steady';
    const rp = effectiveParams(this.params(req.route), req.effortOverride);
    const maxCalls = Math.max(0, Math.min(req.maxToolCalls, ASK_MAX_TOOL_CALLS));
    // With server-side fallbacks (a route overridden to Sonnet 5.5) a mid-output decline keeps the declined partial
    // in the same stream before the `fallback` block, so text is buffered per turn and only the answering model's
    // (finalText) is emitted. Haiku never sends fallbacks and streams deltas as they come.
    const bufferText = sendsFallbacks(rp, 'sync');
    // Append-only: assistant turns are echoed back exactly as received (preserved thinking).
    const history: unknown[] = [...req.messages];
    const body = () => requestParams(rp, { system: req.system, messages: history, maxTokens: req.maxTokens, tools: req.tools, mode: 'sync' });
    const first = body();
    const bad = shapeGate(first, this.log, req.kind);
    if (bad) return bad;
    const blocked = this.gate(pool, req.estimateUsd ?? 0, userTextOfParams({ messages: history }));
    if (blocked) return blocked;

    const started = this.now();
    const id = ledger.syncRequestId(started);
    ledger.insertRequest(
      this.db,
      {
        customId: id,
        kind: req.kind,
        subjectRef: req.subjectRef,
        attempt: 0,
        promptVersion: req.promptVersion,
        model: rp.model,
        inputHash: inputHash({ system: req.system, messages: req.messages, tools: first.tools }),
        pool,
        mode: 'sync',
        runId: req.runId ?? null,
        purpose: req.kind,
        effort: rp.effort,
        maxTokens: first.max_tokens as number,
        params: null,
        estimateUsd: req.estimateUsd ?? null,
      },
      started,
    );

    let usage: LlmUsage = { ...ZERO_USAGE };
    let toolCalls = 0;
    let budgetNoticeSent = false;
    /** Results had to be dropped to keep the next request ≤ PROMPT_TOKEN_LIMIT: no further tool calls. */
    let contextFull = false;
    const citableIds: string[] = [];
    const detok = new DeltaDetokenizer(this.o.egress);
    const emit = (s: string) => {
      if (s) req.onTextDelta?.(s);
    };
    const finish = (status: ledger.LedgerStatus, out: LlmToolLoopOutcome, text = '', stop: string | null = null): LlmToolLoopOutcome => {
      ledger.recordOutcome(
        this.db,
        id,
        {
          status,
          stopReason: stop,
          servedByModel: usage.servedByModel,
          output: text || null,
          usage: usage.inputTokens + usage.outputTokens > 0 ? usage : null,
          errorType: out.status === 'unavailable' ? ledgerErrorType(out) : null,
        },
        this.now(),
      );
      this.logCall('llm_tools', req.kind, usage, { tool_calls: toolCalls });
      return out;
    };

    for (let turn = 0; turn <= maxCalls + 3; turn++) {
      if (req.signal?.aborted) return finish('errored', unavailable('aborted'));
      const params = turn === 0 ? first : body();
      if (turn > 0) {
        const again = this.gate(pool, 0, userTextOfParams({ messages: history.slice(-1) })) ?? shapeGate(params, this.log, req.kind);
        if (again) return finish('errored', again);
      }
      let msg: BetaMessage;
      try {
        const stream = this.sdk.beta.messages.stream(params as unknown as BetaStreamParams, req.signal ? { signal: req.signal } : undefined);
        if (req.onTextDelta && !bufferText) stream.on('text', (delta) => emit(detok.push(delta)));
        msg = await stream.finalMessage();
      } catch (e) {
        const u = unavailableFromError(e);
        this.log.warn('llm_call_failed', { job: req.kind, ...failureFields(u), counts: { turn } });
        return finish('errored', u);
      }
      if (bufferText && req.onTextDelta && msg.stop_reason !== 'refusal') emit(detok.push(finalText(msg.content) ?? ''));
      emit(detok.flush());
      this.checkPromptSize(req.kind, msg.usage as UsageLike);
      const turnUsage = usageFrom(msg as never, 'sync', requestCacheTtl(rp, 'sync') ?? '5m', rp.model);
      usage = addUsage(usage, turnUsage);
      ledger.recordUsage(this.db, id, usage, this.now());
      const stop = msg.stop_reason as LlmStopReason | null;
      const text = finalText(msg.content) ?? '';
      if (stop === 'refusal') {
        const category = refusalCategory(msg);
        ledger.recordOutcome(this.db, id, { status: 'refused', stopReason: stop, usage, refusalCategory: category, servedByModel: msg.model }, this.now());
        return { status: 'refused', category, text, usage, requestId: id };
      }
      if (stop === 'max_tokens') return finish('max_tokens', { status: 'max_tokens', text, toolCalls, citableIds, usage, requestId: id }, text, stop);
      // (No server tools here, so no pause_turn continuation: a resent assistant tail would be a prefill.)
      if (stop !== 'tool_use') return finish('succeeded', { status: 'ok', text, toolCalls, citableIds, usage, requestId: id }, text, stop);

      // Only the answering model's tool calls (after the last `fallback` marker) are run.
      const uses = msg.content.slice(afterLastFallback(msg.content)).filter((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === 'tool_use');
      if (!uses.length) return finish('succeeded', { status: 'ok', text, toolCalls, citableIds, usage, requestId: id }, text, stop);
      const echoed = echoContent(msg.content);
      history.push({ role: 'assistant', content: echoed });
      const prompt = turnUsage.inputTokens + turnUsage.cacheReadInputTokens + turnUsage.cacheCreationInputTokens;
      const remaining = contextFull || prompt >= ASK_MAX_INPUT_TOKENS ? 0 : maxCalls - toolCalls;
      if (remaining <= 0 && budgetNoticeSent) {
        return finish('succeeded', { status: 'tool_limit', text, toolCalls, citableIds, usage, requestId: id }, text, stop);
      }
      const allowed = Math.min(uses.length, Math.max(0, remaining));
      toolCalls += allowed;
      const outs = await Promise.all(uses.map((u, i) => (i < allowed ? this.runTool(req, u) : Promise.resolve({ block: budgetNote(u.id), citable: [] as string[] }))));
      if (allowed < uses.length) budgetNoticeSent = true;
      // Keep the NEXT request ≤ PROMPT_TOKEN_LIMIT, sized from this request's ACTUAL prompt (usage) as well as the
      // conservative estimate the shape gate uses, so results the estimate undercounts can't push it onto Haiku's
      // long-context card: results that don't fit are replaced (last first) by the budget note.
      const nextBase = Math.max(prompt + turnUsage.outputTokens, promptTokens(params) + estimatePromptTokens(JSON.stringify(echoed)));
      let size = nextBase + outs.reduce((n, o) => n + estimatePromptTokens(JSON.stringify(o.block)), 0);
      let dropped = 0;
      for (let i = outs.length - 1; i >= 0 && size > PROMPT_TOKEN_LIMIT - NEXT_PROMPT_MARGIN; i--) {
        if (outs[i]!.block.content === TOOL_BUDGET_NOTE) continue;
        const note = budgetNote(uses[i]!.id);
        size += estimatePromptTokens(JSON.stringify(note)) - estimatePromptTokens(JSON.stringify(outs[i]!.block));
        outs[i] = { block: note, citable: [] };
        dropped++;
      }
      if (dropped) {
        contextFull = true;
        budgetNoticeSent = true;
        this.log.warn('llm_tool_results_dropped', { job: req.kind, counts: { results: dropped, prompt_tokens: size } });
      }
      if (size > PROMPT_TOKEN_LIMIT - NEXT_PROMPT_MARGIN) return finish('succeeded', { status: 'tool_limit', text, toolCalls, citableIds, usage, requestId: id }, text, stop);
      for (const o of outs) citableIds.push(...o.citable);
      history.push({ role: 'user', content: outs.map((o) => o.block) });
    }
    return finish('succeeded', { status: 'tool_limit', text: '', toolCalls, citableIds, usage, requestId: id });
  }

  /** Runs one tool call → its tool_result block and the citable ids it showed (added only if the block is sent). */
  private async runTool(req: LlmToolLoopRequest, use: { id: string; name: string; input: unknown }) {
    const call: LlmToolCall = { id: use.id, name: use.name, input: use.input };
    req.onToolStatus?.(call, 'running');
    let res: LlmToolResult;
    try {
      res = await req.executeTool(call);
    } catch {
      res = { content: 'The tool failed.', isError: true };
    }
    let content = res.content;
    if (content) {
      try {
        content = this.o.egress.pseudonymize({ purpose: req.kind, sections: [{ name: 'tool_result', text: content }] }).sections[0]!.text;
      } catch (e) {
        if (!(e instanceof EgressBlocked)) throw e;
        content = 'Result withheld by the privacy filter.';
        res = { content, isError: true };
      }
    }
    req.onToolStatus?.(call, res.isError ? 'error' : 'done');
    return {
      block: { type: 'tool_result' as const, tool_use_id: use.id, ...(res.isError ? { is_error: true } : {}), content: wrapUntrusted(use.name, content) },
      citable: res.isError ? [] : (res.citableIds ?? []),
    };
  }

  // ---- batches

  async submitBatch(items: LlmBatchItem[], o: { purpose: string; runId: string }): Promise<LlmBatchSubmit> {
    if (!items.length) return unavailable('api_error', 'empty_batch');
    if (items.length > MAX_BATCH_ITEMS) return unavailable('api_error', 'too_many_items');
    const pool = items[0]!.pool ?? 'steady';
    if (items.some((i) => (i.pool ?? 'steady') !== pool)) return unavailable('api_error', 'mixed_pools');
    if (new Set(items.map((i) => i.customId)).size !== items.length) return unavailable('api_error', 'duplicate_custom_id');
    if (items.some((i) => !/^[A-Za-z0-9_-]{1,64}$/.test(i.customId))) return unavailable('api_error', 'bad_custom_id');

    // Items that share a route (and so a cacheable prefix) sit together; ties keep the caller's order.
    const ordered = items.map((it, i) => ({ it, i })).sort((a, b) => (a.it.route < b.it.route ? -1 : a.it.route > b.it.route ? 1 : a.i - b.i)).map((x) => x.it);
    const routeParams = new Map<LlmRoute, RouteParams>();
    const paramsOf = (it: LlmBatchItem): RouteParams => {
      let p = routeParams.get(it.route);
      if (!p) routeParams.set(it.route, (p = this.params(it.route)));
      return effectiveParams(p, it.effortOverride);
    };
    // No `fallbacks` and no betas: the Batches API rejects them.
    const requests = ordered.map((it) => ({
      custom_id: it.customId,
      rp: paramsOf(it),
      params: requestParams(paramsOf(it), { system: it.system, messages: it.messages, maxTokens: it.maxTokens, format: outputFormat(it.schema), mode: 'batch' }),
    }));
    for (const r of requests) {
      const bad = shapeGate(r.params, this.log, o.purpose);
      if (bad) return bad;
    }
    const estimate = items.reduce((s, i) => s + (i.estimateUsd ?? 0), 0);
    const spendBlocked = this.spendGate(pool, estimate);
    if (spendBlocked) return spendBlocked;
    const excluded = new Set(readSetting(this.db, 'llm.excluded_person_ids'));
    for (const [i, r] of requests.entries()) {
      // One bad item fails the whole submit closed (nothing is written or sent).
      const blocked = this.contentGate(userTextOfParams(r.params as { messages: unknown[] }), excluded);
      if (blocked) return blocked;
      if (i % 50 === 49) await yieldLoop();
    }

    const now = this.now();
    const taken: string[] = [];
    try {
      tx(this.db, () => {
        requests.forEach((r, i) => {
          const it = ordered[i]!;
          const ok = ledger.reuseUnsentRequest(
            this.db,
            {
              customId: it.customId,
              kind: it.kind,
              subjectRef: it.subjectRef,
              attempt: parseCustomId(it.customId)?.attempt ?? 0,
              promptVersion: it.promptVersion,
              model: r.rp.model,
              inputHash: inputHash(r.params),
              pool,
              mode: 'batch',
              runId: it.runId ?? o.runId,
              purpose: o.purpose,
              effort: r.rp.effort,
              maxTokens: r.params.max_tokens as number,
              params: {
                route: it.route,
                system: it.system,
                cacheTtl: r.rp.cacheTtl ?? '5m',
                messages: it.messages,
                outputSchema: (r.params.output_config as { format: JsonOutputFormat }).format.schema,
                ...(it.effortOverride ? { effortOverride: it.effortOverride } : {}),
              },
              estimateUsd: it.estimateUsd ?? null,
            },
            now,
          );
          if (!ok) taken.push(it.customId);
        });
        if (taken.length) throw new DuplicateCustomId();
      });
    } catch (e) {
      if (e instanceof DuplicateCustomId) return unavailable('api_error', 'duplicate_custom_id');
      throw e;
    }

    let batch: Anthropic.Messages.MessageBatch;
    try {
      batch = await this.sdk.messages.batches.create({ requests: requests.map((r) => ({ custom_id: r.custom_id, params: r.params })) } as unknown as Anthropic.Messages.BatchCreateParams);
    } catch (e) {
      const u = unavailableFromError(e);
      const mark = this.db.prepare(`UPDATE llm_requests SET status = 'errored', error_type = 'submit_failed', completed_at = ? WHERE custom_id = ? AND batch_id IS NULL`);
      tx(this.db, () => items.forEach((it) => mark.run(this.now(), it.customId)));
      this.log.warn('llm_batch_submit_failed', { ...failureFields(u), counts: { items: items.length } });
      return u;
    }
    const at = this.now();
    tx(this.db, () => {
      const upd = this.db.prepare(`UPDATE llm_requests SET batch_id = ?, status = 'submitted' WHERE custom_id = ?`);
      for (const it of items) upd.run(batch.id, it.customId);
      this.db
        .prepare(
          `INSERT INTO llm_batches (id, run_id, purpose, status, request_count, submitted_at, pool) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET request_count = excluded.request_count`,
        )
        .run(batch.id, o.runId, o.purpose, batch.processing_status, items.length, at, pool);
    });
    this.log.info('llm_batch_submitted', { batch_id: batch.id, counts: { items: items.length } });
    return { status: 'submitted', batchId: batch.id, count: items.length };
  }

  async batchStatus(batchId: string): Promise<LlmBatchStatus> {
    const b = await this.sdk.messages.batches.retrieve(batchId);
    const c = b.request_counts;
    const status: LlmBatchStatus = {
      batchId,
      processing: b.processing_status,
      counts: { processing: c.processing, succeeded: c.succeeded, errored: c.errored, canceled: c.canceled, expired: c.expired },
      endedAt: b.ended_at ? Date.parse(b.ended_at) : null,
    };
    this.db
      .prepare(`UPDATE llm_batches SET status = ?, counts = ?, last_polled_at = ?, poll_count = poll_count + 1, ended_at = COALESCE(?, ended_at) WHERE id = ?`)
      .run(status.processing, JSON.stringify(status.counts), this.now(), status.endedAt, batchId);
    return status;
  }

  async *batchResults(batchId: string): AsyncIterable<LlmBatchResult> {
    const row = ledger.getBatch(this.db, batchId);
    if (row?.results_fetched_at) {
      yield* replayFromLedger(this.db, batchId);
      return;
    }
    const decoder = await this.sdk.messages.batches.results(batchId);
    const rowOf = this.db.prepare('SELECT kind, model, params FROM llm_requests WHERE custom_id = ?');
    let n = 0;
    /** Errored items per content-free error code (errorBodyCode), so a batch of 400s says why in the log. */
    const errored: Record<string, number> = {};
    for await (const r of decoder) {
      const row = rowOf.get(r.custom_id) as { kind: string; model: string; params: string | null } | undefined;
      const ttl = row?.params ? ((JSON.parse(row.params) as { cacheTtl?: CacheTtl }).cacheTtl ?? '1h') : '1h';
      const res = mapBatchResult(r, { model: row?.model ?? LLM_MODEL, cacheTtl: ttl });
      if (r.result.type === 'succeeded') this.checkPromptSize(row?.kind ?? 'batch', r.result.message.usage as UsageLike);
      if (r.result.type === 'errored') {
        const code = errorBodyCode(r.result.error);
        errored[code] = (errored[code] ?? 0) + 1;
      }
      persistBatchResult(this.db, res, this.now());
      yield res;
      if (++n % 50 === 0) await yieldLoop();
    }
    const t = ledger.batchTotals(this.db, batchId);
    this.db
      .prepare(`UPDATE llm_batches SET results_fetched_at = ?, status = 'ended', usage = ?, cost_usd = ? WHERE id = ?`)
      .run(this.now(), JSON.stringify(t.usage), t.costUsd, batchId);
    this.log.info('llm_batch_results', { batch_id: batchId, counts: { results: n, ...errored } });
  }
}

class DuplicateCustomId extends Error {}

// ---------------------------------------------------------------------------------------------- batch result mapping

/** One JSONL result → LlmBatchResult (stop_reason first; text by type; refusals carry no text). */
export function mapBatchResult(r: Anthropic.Messages.MessageBatchIndividualResponse, o: { model?: string; cacheTtl?: CacheTtl } = {}): LlmBatchResult {
  const customId = r.custom_id;
  switch (r.result.type) {
    case 'succeeded': {
      const m = r.result.message;
      const stopReason = (m.stop_reason ?? 'end_turn') as LlmStopReason;
      return {
        customId,
        type: 'succeeded',
        stopReason,
        text: stopReason === 'refusal' ? null : finalText(m.content),
        refusalCategory: stopReason === 'refusal' ? refusalCategory(m) : null,
        usage: usageFrom(m as never, 'batch', o.cacheTtl ?? '1h', o.model ?? LLM_MODEL),
      };
    }
    case 'errored': {
      const t = (r.result.error as { error?: { type?: string } } | undefined)?.error?.type;
      // Only the error class is kept: API messages may echo request content.
      const errorType = t === 'invalid_request_error' ? 'invalid_request' : 'other';
      return { customId, type: 'errored', errorType, message: errorType };
    }
    case 'canceled':
      return { customId, type: 'canceled' };
    default:
      return { customId, type: 'expired' };
  }
}

function persistBatchResult(db: DB, r: LlmBatchResult, now: number): void {
  switch (r.type) {
    case 'succeeded': {
      const status: ledger.LedgerStatus = r.stopReason === 'refusal' ? 'refused' : r.stopReason === 'max_tokens' ? 'max_tokens' : 'succeeded';
      ledger.recordOutcome(
        db,
        r.customId,
        { status, stopReason: r.stopReason, servedByModel: r.usage.servedByModel, output: r.text, usage: r.usage, refusalCategory: r.refusalCategory },
        now,
        { onlyIfOpen: true },
      );
      return;
    }
    case 'errored':
      ledger.recordOutcome(db, r.customId, { status: 'errored', errorType: r.errorType }, now, { onlyIfOpen: true });
      return;
    case 'canceled':
      ledger.recordOutcome(db, r.customId, { status: 'errored', errorType: 'canceled' }, now, { onlyIfOpen: true });
      return;
    case 'expired':
      ledger.recordOutcome(db, r.customId, { status: 'expired' }, now, { onlyIfOpen: true });
  }
}

/** Results already fetched, rebuilt from llm_requests (any order; outputs purged after 30 days come back null). */
export function* replayFromLedger(db: DB, batchId: string): Generator<LlmBatchResult> {
  const rows = db.prepare(`SELECT * FROM llm_requests WHERE batch_id = ? AND status NOT IN ('pending','submitted')`).all(batchId) as ledger.RequestRow[];
  for (const row of rows) {
    if (row.status === 'expired' || row.error_type === 'expired') yield { customId: row.custom_id, type: 'expired' };
    else if (row.error_type === 'canceled') yield { customId: row.custom_id, type: 'canceled' };
    else if (row.error_type === 'invalid_request' || row.error_type === 'other')
      yield { customId: row.custom_id, type: 'errored', errorType: row.error_type, message: row.error_type };
    else if (row.stop_reason) {
      const usage = row.usage ? (JSON.parse(row.usage) as LlmUsage) : { ...ZERO_USAGE, batch: true };
      yield {
        customId: row.custom_id,
        type: 'succeeded',
        stopReason: row.stop_reason as LlmStopReason,
        text: row.stop_reason === 'refusal' ? null : row.output,
        refusalCategory: row.refusal_category,
        usage,
      };
    }
  }
}
