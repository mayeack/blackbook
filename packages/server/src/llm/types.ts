/**
 * LLM contracts: the client every Claude call goes through, the egress choke point, usage/budget accounting and
 * the refusal / stop_reason semantics. Implementations: llm/client.ts (Anthropic SDK), llm/egress.ts
 * (pseudonymizer + fail-closed scanner). Tests use test/fakes/llm.ts (FakeLlmClient, FakeEgress).
 *
 * Facts this contract encodes (claude-api skill, PLAN "LLM extraction"):
 *   - Every call names a ROUTE (llm/models.ts): the route table — not the call site — decides the model (default
 *     Claude Haiku 5.5), effort (explicit, default `low`), thinking (disabled on structured-output routes without
 *     tools, adaptive for the Ask tool loop), max_tokens and the cache TTL. Overrides (settings
 *     llm.route_overrides) may only pick an allowlisted model (Haiku 5.5, Sonnet 5.5).
 *   - Never sent: temperature / top_p / top_k, an assistant prefill (the last message is always the user's), and
 *     `fallbacks` on a model without server-side fallback (Haiku 5.5) or in a batch.
 *   - Structured output via `output_config.format` (zodOutputFormat). The API does NOT enforce numeric or length
 *     bounds: callers pass `validate` and the client rejects violations as 'invalid'.
 *   - Forced tool_choice is avoided: tool loops use `auto` + `strict: true` tools.
 *   - Prompt caching: a byte-stable system prompt (no timestamps, ids or flags) with cache_control
 *     {type:'ephemeral', ttl: route.cacheTtl}; volatile content goes in the user turn. Every prompt stays
 *     ≤ PROMPT_TOKEN_LIMIT (100K: Haiku 5.5's cheap rate card), checked before anything is sent.
 *   - Tool loops keep an append-only history: response.content is echoed back unchanged (preserved thinking).
 *
 * REFUSAL / STOP-REASON HANDLING (the client always checks stop_reason before reading content, and reads the
 * `text` block BY TYPE — thinking blocks may come first):
 *   1. A final stop_reason 'refusal' → outcome 'refused' with stop_details.category; the caller degrades
 *      (template copy, skip the item). Haiku 5.5 has no server-side fallback, so the default is: record and skip,
 *      no automatic retry on a bigger model. Only a route overridden to a model with sync fallbacks (Sonnet 5.5)
 *      sends betas [FALLBACK_BETA] + fallbacks: "default"; who served it is in usage.servedByModel / fallbackUsed.
 *   2. Batches NEVER carry `fallbacks`. A batch item that comes back 'succeeded' with stopReason 'refusal' is
 *      re-run ONCE through parse() only when the route's model supports sync fallbacks; otherwise it is final:
 *      the caller marks the item/window 'refused', advances its watermark, and counts it.
 *   3. stopReason 'max_tokens': batch items are re-queued once with maxTokens × 2 (attempt + 1), then split by
 *      the caller; sync calls return 'max_tokens' and the caller decides.
 *   4. errored/invalid_request → dead-letter + alert; errored/other, canceled → retry (attempt + 1);
 *      expired → resubmit next night; attempts > 3 → dead-letter.
 *
 * EGRESS: every packet is pseudonymized (Egress.pseudonymize) and the final request text is scanned
 * (Egress.scan) by the client right before it leaves; a raw E.164 number, email or @handle throws EgressBlocked
 * and the call answers 'unavailable' / 'egress_blocked' (fails closed). Tool results are pseudonymized too and
 * wrapped as untrusted data.
 *
 * BUDGET: steady-state daily + monthly caps (settings llm.daily_budget_usd / llm.monthly_budget_usd) and a
 * separate one-time backfill pool (llm.backfill_budget_usd). At a cap every call answers 'unavailable' with a
 * budget_* reason and callers fall back to deterministic/template output. No key, or llm.enabled=false →
 * 'no_key' / 'disabled'. Spend is recorded per request in llm_requests (cost_usd) / llm_batches, priced per
 * model (llm/models.ts) from usage incl. cache reads/writes and the batch discount.
 */
import { createHash } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';
import { DEFAULT_MODEL, ROUTES, type LlmEffort, type LlmRoute, type RouteParams, type TokenCounts } from './models';

export {
  costUsd,
  DEFAULT_MODEL,
  FALLBACK_BETA,
  PROMPT_TOKEN_LIMIT,
  type LlmEffort,
  type LlmModel,
  type LlmRoute,
  type RouteParams,
  type TokenCounts,
} from './models';

// ---------------------------------------------------------------------------------------------- constants

/** The default model (every route's, unless the owner overrides one). Ids live only in llm/models.ts. */
export const LLM_MODEL = DEFAULT_MODEL;

/** llm_requests.kind (the CHECK list in 001_init). */
export type LlmKind =
  | 'extract'
  | 'historical'
  | 'consolidate'
  | 'tiebreak'
  | 'digest'
  | 'ask'
  | 'command'
  | 'circle_name'
  | 'brief'
  | 'calendar'
  | 'intent';

/** One letter per kind for custom_id (`{letter}{ver}-{subject}-{attempt}`). */
export const CUSTOM_ID_LETTER: Readonly<Record<LlmKind, string>> = {
  extract: 'x',
  historical: 'h',
  consolidate: 'c',
  circle_name: 'n',
  calendar: 'a',
  tiebreak: 't',
  digest: 'd',
  ask: 'q',
  command: 'k',
  brief: 'b',
  intent: 'i',
};

/** Ask loop limits (intelligence §7). */
export const ASK_MAX_TOOL_CALLS = 8;
export const ASK_MAX_INPUT_TOKENS = 60_000;

// ---------------------------------------------------------------------------------------------- usage & budget

export type BudgetPool = 'steady' | 'backfill';

export interface LlmUsage extends TokenCounts {
  costUsd: number;
  batch: boolean;
  /** Model that produced the final answer (differs from the route's model when a fallback served it). */
  servedByModel: string | null;
  fallbackUsed: boolean;
}

export const ZERO_USAGE: LlmUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  costUsd: 0,
  batch: false,
  servedByModel: null,
  fallbackUsed: false,
};

export interface LlmSpend {
  todayUsd: number;
  monthUsd: number;
  backfillUsd: number;
  dailyBudgetUsd: number;
  monthlyBudgetUsd: number;
  backfillBudgetUsd: number;
  requestsToday: number;
  /** cache_read / (cache_read + cache_write + uncached input) over the last 7 days; null without data. */
  cacheHitRate: number | null;
}

export type LlmUnavailableReason =
  | 'no_key'
  | 'disabled'
  | 'budget_daily'
  | 'budget_monthly'
  | 'budget_backfill'
  | 'egress_blocked'
  | 'excluded'
  | 'rate_limited'
  | 'api_error'
  | 'aborted'
  /** The request would exceed PROMPT_TOKEN_LIMIT (never sent: above it Haiku 5.5 bills at 5×). */
  | 'prompt_too_large';

export type SpendCheck = { ok: true } | { ok: false; reason: LlmUnavailableReason };

// ---------------------------------------------------------------------------------------------- custom ids & prompt versions

const CUSTOM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** `prompt_version = sha256(system ‖ schemaJSON ‖ model ‖ effort)[0:8]`, stored on every derived row. */
export function promptVersion(system: string, schemaJson: string, effort: LlmEffort, model: string = LLM_MODEL): string {
  return createHash('sha256').update(`${system}\u0000${schemaJson}\u0000${model}\u0000${effort}`).digest('hex').slice(0, 8);
}

/**
 * prompt_version for a route's DEFAULT model and effort. A per-route override changes what is sent but not this
 * version (the ledger row keeps the model and effort actually used).
 */
export function routePromptVersion(route: LlmRoute, system: string, schemaJson: string): string {
  return promptVersion(system, schemaJson, ROUTES[route].effort, ROUTES[route].model);
}

/**
 * custom_id = `{kind letter}{ver}-{subject}-{attempt}`, e.g. `xa3f9c21-1k8z-0`. The subject is reduced to
 * [A-Za-z0-9_] (UUID dashes dropped) and truncated so the whole id stays ≤64 chars. Results are keyed by it
 * (they arrive in any order); never rely on position.
 */
export function customId(kind: LlmKind, version: string, subject: string, attempt: number): string {
  if (!/^[a-z0-9]{1,8}$/i.test(version)) throw new Error('prompt version must be 1–8 alphanumerics');
  if (!Number.isInteger(attempt) || attempt < 0 || attempt > 99) throw new Error('attempt must be 0–99');
  const head = `${CUSTOM_ID_LETTER[kind]}${version}-`;
  const tail = `-${attempt}`;
  const s = subject.replace(/[^A-Za-z0-9_]/g, '').slice(0, 64 - head.length - tail.length);
  if (!s) throw new Error('custom_id subject is empty');
  const id = `${head}${s}${tail}`;
  if (!CUSTOM_ID_RE.test(id)) throw new Error('invalid custom_id');
  return id;
}

export function parseCustomId(id: string): { kind: LlmKind; version: string; subject: string; attempt: number } | null {
  const m = /^([a-z])([A-Za-z0-9]{1,8})-([A-Za-z0-9_]+)-(\d{1,2})$/.exec(id);
  if (!m) return null;
  const kind = (Object.keys(CUSTOM_ID_LETTER) as LlmKind[]).find((k) => CUSTOM_ID_LETTER[k] === m[1]);
  return kind ? { kind, version: m[2]!, subject: m[3]!, attempt: Number(m[4]) } : null;
}

// ---------------------------------------------------------------------------------------------- requests & outcomes

export interface LlmRequestBase {
  kind: LlmKind;
  /** The route (llm/models.ts): model, effort, thinking, max_tokens and cache TTL all come from it. */
  route: LlmRoute;
  /** What the call is about (window id, digest date, occasion id, pair key, …): llm_requests.subject_ref. */
  subjectRef: string;
  promptVersion: string;
  /** Byte-stable system prompt; cached with the route's TTL. */
  system: string;
  /** Already pseudonymized turns (Egress.pseudonymize), ending with a user turn; the client scans them again. */
  messages: Anthropic.MessageParam[];
  /** Overrides the route's max_tokens (re-queues after a cut-off double it). */
  maxTokens?: number;
  /**
   * Evaluation only (yb eval shadow --effort): replaces the route's effort for this request. Production call sites
   * never set it, so effort stays constant per route and the cache keeps hitting.
   */
  effortOverride?: LlmEffort;
  /** Which budget pays (default 'steady'). */
  pool?: BudgetPool;
  /** Pre-flight cost estimate checked against the remaining budget. */
  estimateUsd?: number;
  /** Run that triggered it (llm_requests bookkeeping). */
  runId?: string | null;
}

export interface LlmParseRequest<T> extends LlmRequestBase {
  /** Structured output schema (zod 4 object). Every field required; use nullable instead of optional. */
  schema: z.ZodType<T>;
  /** Code-side checks the API can't enforce (bounds, lengths, ref sets). Problems → outcome 'invalid'. */
  validate?: (value: T) => string[];
  signal?: AbortSignal;
}

export type LlmUnavailable = { status: 'unavailable'; reason: LlmUnavailableReason; detail?: string };

export type LlmOutcome<T> =
  | { status: 'ok'; value: T; text: string; usage: LlmUsage; requestId: string }
  | { status: 'refused'; category: string | null; usage: LlmUsage; requestId: string }
  | { status: 'max_tokens'; partialText: string; usage: LlmUsage; requestId: string }
  | { status: 'invalid'; issues: string[]; text: string; usage: LlmUsage; requestId: string }
  | LlmUnavailable;

/** A strict, read-only tool (JSON Schema with additionalProperties:false and every property required). */
export interface LlmTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface LlmToolCall {
  id: string;
  name: string;
  input: unknown;
}

/** A tool's answer. The client pseudonymizes `content` and wraps it as untrusted data before sending it back. */
export interface LlmToolResult {
  content: string;
  isError?: boolean;
  /** Citation ids this result made valid ('m:8812', 'F881', 'E12', 'P17'). */
  citableIds?: string[];
}

export interface LlmToolLoopRequest extends LlmRequestBase {
  tools: LlmTool[];
  executeTool(call: LlmToolCall): Promise<LlmToolResult>;
  /** ≤ ASK_MAX_TOOL_CALLS */
  maxToolCalls: number;
  /** Streamed answer text (already de-tokenized for display by the client). */
  onTextDelta?: (text: string) => void;
  onToolStatus?: (call: LlmToolCall, status: 'running' | 'done' | 'error') => void;
  signal?: AbortSignal;
}

export type LlmToolLoopOutcome =
  | { status: 'ok'; text: string; toolCalls: number; citableIds: string[]; usage: LlmUsage; requestId: string }
  | { status: 'refused'; category: string | null; text: string; usage: LlmUsage; requestId: string }
  | { status: 'max_tokens' | 'tool_limit'; text: string; toolCalls: number; citableIds: string[]; usage: LlmUsage; requestId: string }
  | LlmUnavailable;

// ---------------------------------------------------------------------------------------------- batches

export interface LlmBatchItem<T = unknown> extends LlmRequestBase {
  /** customId(kind, promptVersion, subject, attempt) — also the llm_requests primary key. */
  customId: string;
  schema: z.ZodType<T>;
}

export type LlmBatchSubmit = { status: 'submitted'; batchId: string; count: number } | LlmUnavailable;

export interface LlmBatchStatus {
  batchId: string;
  processing: 'in_progress' | 'canceling' | 'ended';
  counts: { processing: number; succeeded: number; errored: number; canceled: number; expired: number };
  endedAt: number | null;
}

export type LlmStopReason = 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | 'pause_turn' | 'refusal';

export type LlmBatchResult =
  | {
      customId: string;
      type: 'succeeded';
      stopReason: LlmStopReason;
      /** The `text` block, found by type (null when there is none, e.g. a refusal). */
      text: string | null;
      refusalCategory: string | null;
      usage: LlmUsage;
    }
  | { customId: string; type: 'errored'; errorType: 'invalid_request' | 'other'; message: string }
  | { customId: string; type: 'canceled' }
  | { customId: string; type: 'expired' };

// ---------------------------------------------------------------------------------------------- the client

export interface LlmClient {
  /** The default model (routes may be overridden; see params()). */
  readonly model: string;
  /** A route's effective parameters (defaults + the owner's overrides). Cheap. */
  params(route: LlmRoute): RouteParams;
  /** An API key is configured (without one every call answers 'unavailable' / 'no_key'). */
  readonly configured: boolean;
  /** Whether a call from `pool` could run now (key, llm.enabled, caps). Cheap; call before building packets. */
  canSpend(pool?: BudgetPool, estimateUsd?: number): SpendCheck;
  /** One synchronous structured-output call. Never throws for API/refusal/budget outcomes. */
  parse<T>(req: LlmParseRequest<T>): Promise<LlmOutcome<T>>;
  /** A read-only tool-use loop (tool_choice auto, strict tools, append-only history). */
  runTools(req: LlmToolLoopRequest): Promise<LlmToolLoopOutcome>;
  /** Writes llm_requests rows BEFORE the HTTP submit, then creates one Message Batch (≤5,000 items, no fallbacks). */
  submitBatch(items: LlmBatchItem[], o: { purpose: string; runId: string }): Promise<LlmBatchSubmit>;
  batchStatus(batchId: string): Promise<LlmBatchStatus>;
  /** Streams results (any order; key by customId). Records usage/cost per item. */
  batchResults(batchId: string): AsyncIterable<LlmBatchResult>;
  spend(): LlmSpend;
}

// ---------------------------------------------------------------------------------------------- egress

/** Who a pseudonym stands for (local only, `pseudonyms` table; never sent). */
export interface TokenTarget {
  kind: 'person' | 'identity' | 'me' | 'mention';
  id: string;
}

/** token ('P1a', 'H3', 'ME') → target, for de-tokenizing model output locally. */
export type TokenMap = Record<string, TokenTarget>;

export interface EgressPerson {
  personId: string;
  firstName: string | null;
  lastName?: string | null;
  isMe?: boolean;
}

export interface EgressPacket {
  /** What it's for (counts/logs only). */
  purpose: LlmKind;
  /**
   * Text sections (message lines, titles, notes, tool results). Each is scrubbed: phones → <phone:…>,
   * emails → <email>, @handles → <ig:Pxx>/<handle>, street addresses → <addr>, digit runs ≥6 → <num>, a known
   * person's last name right after their first name → last initial. First names, cities, companies and chat
   * titles are kept.
   */
  sections: { name: string; text: string }[];
  /** People who may be referenced; each gets a stable token (P<base36>; the owner is ME). */
  people?: EgressPerson[];
  /** Unresolved handles (identity ids) that may appear → H<n>. */
  identityIds?: string[];
}

export interface PseudonymizedPacket {
  sections: { name: string; text: string }[];
  /** Sections joined with `### <name>` headers. */
  text: string;
  tokenMap: TokenMap;
  /** Counts of each replacement kind (for logs/eval; never values). */
  replaced: Record<string, number>;
}

export type EgressFindingKind = 'phone' | 'email' | 'handle' | 'not_implemented';

/** Thrown when outbound LLM text still contains a raw identifier (or egress isn't available): fail closed. */
export class EgressBlocked extends Error {
  constructor(readonly findings: { kind: EgressFindingKind; count: number }[]) {
    super(`egress blocked: ${findings.map((f) => `${f.kind}×${f.count}`).join(', ')}`);
    this.name = 'EgressBlocked';
  }
}

export interface Egress {
  pseudonymize(packet: EgressPacket): PseudonymizedPacket;
  /** Throws EgressBlocked when a raw E.164 number, email or @handle remains in `text`. */
  scan(text: string): void;
  /** Tokens → display strings (first name + last initial), locally. Unknown tokens are left as-is. */
  detokenize(text: string, map: TokenMap): string;
  /** The stable token for a person (created on first use). */
  tokenFor(personId: string): string;
  /** The person (or identity) behind a token, or null. */
  resolveToken(token: string): TokenTarget | null;
}
