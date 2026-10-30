/**
 * THE LLM route table: which model, effort, thinking mode, max_tokens and cache TTL every Claude call uses. This is
 * the ONLY file in packages/server/src that names a model id (test/llm/models.test.ts fails on a `claude-…` literal
 * anywhere else). Call sites pass a `route`; the client resolves it here (plus the owner's overrides) and builds the
 * request from the result, so effort/thinking stay constant per route (changing either between requests
 * invalidates the prompt cache).
 *
 * Owner requirement (2026-10-16): cheapest model first, token/cost efficient, maximize prompt caching. So:
 *   - every route defaults to Claude Haiku 5.5 at effort `low`;
 *   - structured-output routes WITHOUT tools run with thinking disabled (Haiku accepts {type:'disabled'} at
 *     effort low/medium/high), so no output tokens go to thinking; the Ask tool loop keeps adaptive thinking at low
 *     effort (with thinking off the model can skip a needed tool call);
 *   - an override (settings `llm.route_overrides`) may move ONE route to another allowlisted model or effort. The
 *     allowlist is Haiku 5.5 and Sonnet 5.5; Opus is deliberately not selectable.
 *
 * Model facts encoded below (claude-api skill, model-migration "Migrating to Claude Haiku 5.5" / "Sonnet 5.5"):
 *   - Haiku 5.5: $0.10 / $0.50 per MTok in/out while the prompt is ≤100K tokens, $0.50 / $2.50 above → every prompt
 *     is kept ≤ PROMPT_TOKEN_LIMIT. No sampling params, no assistant prefill (both 400). Refusals have NO server-side
 *     fallback (`fallbacks` must not be sent): a refusal is recorded and skipped, never escalated automatically.
 *   - Sonnet 5.5: $2 / $10, cache reads $0.20. `{type:'disabled'}` thinking is a 400 → its thinking-off spelling is
 *     `{type:'between_tools'}` (effort ≤ high). Sync calls on the Claude API may send `fallbacks: "default"`.
 *   - Both: cache reads 0.1× input, 5-minute writes 1.25×, 1-hour writes 2×; Message Batches 50% off every token
 *     (cache reads/writes included); minimum cacheable prefix 512 tokens (shorter prefixes silently don't cache and
 *     aren't charged a write).
 *
 * Cache TTL per route (prompt-caching "Choosing the TTL": pick by the start-to-start gap between requests that share
 * the prefix): Batch routes → 1 h (items of one batch, and its re-queues/overflow waves, run minutes to hours apart);
 * a synchronous call on a batch route (on-demand consolidation, a refusal re-run) writes at 5 min (requestCacheTtl).
 * Synchronous routes → 5 min: their calls that share a prefix run back-to-back (a nightly tie-break pass, an Ask tool
 * loop, a shadow replay). Routes whose calls are hours apart (the daily digest, sporadic intent notes) send no marker
 * at all (cacheTtl null): neither TTL would be read, so a write would only cost more.
 */
import type { CacheTtl } from './caching';

export type LlmEffort = 'low' | 'medium' | 'high';
export const LLM_EFFORTS: readonly LlmEffort[] = ['low', 'medium', 'high'];

// ---------------------------------------------------------------------------------------------- models

export const HAIKU_5_5 = 'claude-haiku-5-5' as const;
export const SONNET_5_5 = 'claude-sonnet-5-5' as const;
/** Every route's default. */
export const DEFAULT_MODEL = HAIKU_5_5;
/** Models a route may be overridden to. Opus is intentionally absent: add it here only if the owner asks. */
export const MODEL_ALLOWLIST = [HAIKU_5_5, SONNET_5_5] as const;
export type LlmModel = (typeof MODEL_ALLOWLIST)[number];
export const isAllowedModel = (m: unknown): m is LlmModel => typeof m === 'string' && (MODEL_ALLOWLIST as readonly string[]).includes(m);

/** USD per million tokens, synchronous, before cache multipliers and the batch discount. */
export interface RateCard {
  input: number;
  output: number;
}

export interface ModelSpec {
  label: string;
  /** The rate card for prompts up to `longContext.above` tokens (any length when longContext is null). */
  base: RateCard;
  /** A second rate card for longer prompts (Haiku 5.5: above 100K prompt tokens). */
  longContext: { above: number; card: RateCard } | null;
  /** How a route's thinking-off is spelled on this model. */
  thinkingOff: 'disabled' | 'between_tools';
  /** Server-side refusal fallbacks on synchronous Claude API calls (never in batches). */
  syncFallbacks: boolean;
  /** Minimum cacheable prefix (tokens). */
  minCacheTokens: number;
}

export const MODEL_SPECS: Readonly<Record<LlmModel, ModelSpec>> = {
  [HAIKU_5_5]: {
    label: 'Claude Haiku 5.5',
    base: { input: 0.1, output: 0.5 },
    longContext: { above: 100_000, card: { input: 0.5, output: 2.5 } },
    thinkingOff: 'disabled',
    syncFallbacks: false,
    minCacheTokens: 512,
  },
  [SONNET_5_5]: {
    label: 'Claude Sonnet 5.5',
    base: { input: 2, output: 10 },
    longContext: null,
    thinkingOff: 'between_tools',
    syncFallbacks: true,
    minCacheTokens: 512,
  },
};

/** Server-side refusal fallbacks (synchronous calls only, models with syncFallbacks), with `fallbacks: "default"`. */
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01' as const;
/**
 * The refusal categories server-side fallback retries (Sonnet 5.5: `cyber` and `frontier_llm`). `bio`,
 * `reasoning_extraction` and `general_harms` declines (and uncategorized ones) are not retried, so re-sending them
 * would only pay for a second refusal.
 */
export const FALLBACK_RETRIED_CATEGORIES: ReadonlySet<string> = new Set(['cyber', 'frontier_llm']);

export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_MULTIPLIER: Readonly<Record<CacheTtl, number>> = { '5m': 1.25, '1h': 2 };
/** Message Batches: 50% off every token, cache reads and writes included. */
export const BATCH_MULTIPLIER = 0.5;

/** Every prompt stays at or under this (Haiku 5.5's cheap rate card ends here). Enforced by the client. */
export const PROMPT_TOKEN_LIMIT = 100_000;
/**
 * Conservative ASCII characters per token for size guards and estimates. Haiku 5.5's tokenizer counts ~30% more
 * tokens than the old ≈4 chars/token rule, so 3 over-estimates English rather than under-estimating it.
 */
export const CHARS_PER_TOKEN = 3;
/**
 * Conservative token count of `text`: ASCII at CHARS_PER_TOKEN, every other code point as at least one token (CJK
 * is about one token per character) and astral ones (emoji, rare CJK) as two, so non-Latin text can't slip past the
 * ≤100K guard on a character count. A number is a character count of (mostly ASCII) text.
 */
export function estimatePromptTokens(text: string | number): number {
  if (typeof text === 'number') return Math.ceil(text / CHARS_PER_TOKEN);
  let ascii = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) ascii++;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
      other += 2;
    } else other++;
  }
  return Math.ceil(ascii / CHARS_PER_TOKEN) + other;
}

/** The spec that prices `model`; a model outside the table (e.g. a fallback's) is priced like `requested`. */
export function specFor(model: string | null | undefined, requested: string = DEFAULT_MODEL): ModelSpec {
  if (isAllowedModel(model)) return MODEL_SPECS[model];
  return isAllowedModel(requested) ? MODEL_SPECS[requested] : MODEL_SPECS[DEFAULT_MODEL];
}

/** The rate card a prompt of `promptTokens` (uncached + cache read + cache write) is billed on. */
export function rateCard(model: string, promptTokens: number): RateCard {
  const s = specFor(model);
  return s.longContext && promptTokens > s.longContext.above ? s.longContext.card : s.base;
}

export function supportsSyncFallbacks(model: string | null | undefined): boolean {
  return isAllowedModel(model) && MODEL_SPECS[model].syncFallbacks;
}

/**
 * Whether a refused BATCH item is worth one synchronous re-run with server-side fallbacks: it went out on a model
 * with sync fallbacks, its route still resolves to one (the re-run goes through parse() on the route's CURRENT
 * parameters; never an escalation off Haiku), and the decline is a category the fallback retries.
 */
export function refusalRerunnable(sentModel: string | null | undefined, routeModel: string | null | undefined, category: string | null | undefined): boolean {
  return supportsSyncFallbacks(sentModel) && supportsSyncFallbacks(routeModel) && !!category && FALLBACK_RETRIED_CATEGORIES.has(category);
}

// ---------------------------------------------------------------------------------------------- pricing

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

/** Token counts with the cache writes split by TTL (usage.cache_creation). */
export interface PricedTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

/** USD for one request's tokens on `model` (the >100K rate card is chosen from the whole prompt). */
export function priceTokens(t: PricedTokens, o: { model: string; mode: 'sync' | 'batch' }): number {
  const prompt = t.input + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h;
  const card = rateCard(o.model, prompt);
  const k = o.mode === 'batch' ? BATCH_MULTIPLIER : 1;
  const inputUsd =
    t.input * card.input +
    t.cacheRead * card.input * CACHE_READ_MULTIPLIER +
    t.cacheWrite5m * card.input * CACHE_WRITE_MULTIPLIER['5m'] +
    t.cacheWrite1h * card.input * CACHE_WRITE_MULTIPLIER['1h'];
  return (k * (inputUsd + t.output * card.output)) / 1e6;
}

/**
 * Server-side web search (web_search tool): USD per search, on top of the tokens its results add to the prompt.
 * Claude API price, docs "Web search tool" → Usage and pricing ($10 per 1,000 searches; 2026-10-22). A search that
 * errors is not billed.
 */
export const WEB_SEARCH_USD = 0.01;

/** Cost of one request from its token counts (all cache writes at `cacheTtl`). */
export function costUsd(t: TokenCounts, mode: 'sync' | 'batch', cacheTtl: CacheTtl = '1h', model: string = DEFAULT_MODEL): number {
  return priceTokens(
    {
      input: t.inputTokens,
      output: t.outputTokens,
      cacheRead: t.cacheReadInputTokens,
      cacheWrite5m: cacheTtl === '5m' ? t.cacheCreationInputTokens : 0,
      cacheWrite1h: cacheTtl === '1h' ? t.cacheCreationInputTokens : 0,
    },
    { model, mode },
  );
}

// ---------------------------------------------------------------------------------------------- routes

export const LLM_ROUTES = [
  'extract_steady',
  'extract_historical',
  'extract_consolidate',
  'tiebreak',
  'intent',
  'circle_name',
  'adjudicate',
  'digest_compose',
  'draft_openers',
  'ask_web',
  'ask_imessage',
  'eval_shadow',
  'ticket_parse',
  'events_search',
  'events_extract',
  'events_newsletter',
] as const;
export type LlmRoute = (typeof LLM_ROUTES)[number];
export const isLlmRoute = (r: unknown): r is LlmRoute => typeof r === 'string' && (LLM_ROUTES as readonly string[]).includes(r);

export type ThinkingMode = 'disabled' | 'adaptive';

export interface RouteDefaults {
  model: LlmModel;
  effort: LlmEffort;
  /** 'disabled' on structured-output routes without tools; 'adaptive' for the Ask tool loop. */
  thinking: ThinkingMode;
  /** max_tokens (a backstop: thinking counts toward it on adaptive routes). Non-streaming calls stay ≤16k. */
  maxTokens: number;
  /** The system marker's TTL; null = no cache_control at all (a prefix that is never re-read within any TTL). */
  cacheTtl: CacheTtl | null;
  /** How the route is normally sent (estimates price batch routes at 50%). */
  mode: 'sync' | 'batch';
  /** Expected output tokens per request, for pre-flight estimates. */
  estOutputTokens: number;
  /** Images one request may carry (0 = text only; the egress choke point refuses images on every other route). */
  maxImages: number;
}

const r = (
  model: LlmModel,
  effort: LlmEffort,
  thinking: ThinkingMode,
  maxTokens: number,
  cacheTtl: CacheTtl | null,
  mode: 'sync' | 'batch',
  estOutputTokens: number,
  maxImages = 0,
): RouteDefaults => ({
  model,
  effort,
  thinking,
  maxTokens,
  cacheTtl,
  mode,
  estOutputTokens,
  maxImages,
});

/**
 * Images cost about width × height / 750 tokens: a phone screenshot downscaled to 1568 px on the long side
 * (~723 × 1568) is ~1.5k input tokens (≈ $0.00015 on Haiku 5.5). Size guards count every image at the
 * high-resolution ceiling, so the ≤100K guard never under-counts.
 */
export const IMAGE_MAX_TOKENS = 4784;
/** Base64 characters one image may have (the API's per-image limit is 5 MB). */
export const IMAGE_MAX_BASE64_CHARS = 5_000_000;

/**
 * Defaults per route. Max tokens: JSON-only routes get a few × their typical output (batch items that hit the cap
 * are re-queued once at ×2, then split); the Ask loop leaves room for low-effort thinking plus the answer.
 * Cacheable prefixes (system + schema/tools, measured at the conservative 3 chars/token): extraction ~7k, Ask ~3k,
 * adjudication ~1.7k, intent ~1.2k, consolidation ~0.8k, digest ~0.6k tokens; tie-break, circle naming and drafts
 * are under the 512-token minimum, so their marker is a no-op (no write is charged). They run a handful of times a
 * night or on request, so padding them up to 512 would cost more than the cache could save.
 * No marker at all (cacheTtl null) where the prefix clears 512 tokens but is never re-read inside a TTL, so a write
 * would be pure premium (prompt-caching: "zero reads → leave it off"): digest_compose (once a day) and intent
 * (sporadic free-text notes, usually hours apart).
 */
export const ROUTES: Readonly<Record<LlmRoute, RouteDefaults>> = {
  /** Nightly extraction of tonight's windows (≤4k NEW tokens each), Message Batches. */
  extract_steady: r(HAIKU_5_5, 'low', 'disabled', 4000, '1h', 'batch', 700),
  /** One-time backfill windows (≤8k NEW tokens), Message Batches, backfill pool. */
  extract_historical: r(HAIKU_5_5, 'low', 'disabled', 8000, '1h', 'batch', 1200),
  /** Per-person fact consolidation after the backfill (batched) or on demand (sync). */
  extract_consolidate: r(HAIKU_5_5, 'low', 'disabled', 4000, '1h', 'batch', 600),
  /** Identity tie-break: ≤10 sequential calls a night. */
  tiebreak: r(HAIKU_5_5, 'low', 'disabled', 1000, '5m', 'sync', 250),
  /** Free-text command intent (iMessage self-thread), with up to 2 attached screenshots (Haiku 5.5 reads images). */
  intent: r(HAIKU_5_5, 'low', 'disabled', 1000, null, 'sync', 200, 2),
  /** Auto-circle names: a few sequential calls per run. */
  circle_name: r(HAIKU_5_5, 'low', 'disabled', 600, '5m', 'sync', 120),
  /** Calendar attendee adjudication, nightly Message Batch. */
  adjudicate: r(HAIKU_5_5, 'low', 'disabled', 2000, '1h', 'batch', 500),
  /** The morning digest copy: one call a day. */
  digest_compose: r(HAIKU_5_5, 'low', 'disabled', 3000, null, 'sync', 1200),
  /** Two conversation-starter drafts on request (web "draft", iMessage `draft N`). */
  draft_openers: r(HAIKU_5_5, 'low', 'disabled', 600, '5m', 'sync', 150),
  /** Ask on the web: read-only tool loop, streamed. */
  ask_web: r(HAIKU_5_5, 'low', 'adaptive', 4000, '5m', 'sync', 900),
  /** Ask over iMessage (≤450-character answers): same system prompt and tools as the web, so they share a cache. */
  ask_imessage: r(HAIKU_5_5, 'low', 'adaptive', 2500, '5m', 'sync', 500),
  /** Shadow replays of extraction windows (yb eval shadow), sequential-ish sync calls. */
  eval_shadow: r(HAIKU_5_5, 'low', 'disabled', 8000, '5m', 'sync', 700),
  /** Ticket emails (adapters/gmail): one Message Batch per Gmail pass with new candidates; the backfill pool while backfilling. */
  ticket_parse: r(HAIKU_5_5, 'low', 'disabled', 1200, '1h', 'batch', 220),
  /**
   * Weekly event picks (intel/eventPicks): two web_search calls a week (candidates, then ticket pages), free-text
   * JSON answers. A week apart, so no cache marker. Search results count as input (~10–15K tokens per search).
   */
  events_search: r(HAIKU_5_5, 'low', 'disabled', 6000, null, 'sync', 2000),
  /** The fallback when a search answer isn't parseable JSON: the same answer, structured. Rare. */
  events_extract: r(HAIKU_5_5, 'low', 'disabled', 4000, null, 'sync', 1500),
  /** The past week's event newsletters from Gmail (masked text, links as refs) → events on the free nights. Weekly. */
  events_newsletter: r(HAIKU_5_5, 'low', 'disabled', 4000, null, 'sync', 1500),
};

// ---------------------------------------------------------------------------------------------- overrides

/** One route's override (settings `llm.route_overrides`). */
export interface RouteOverride {
  model?: LlmModel;
  effort?: LlmEffort;
}
export type RouteOverrides = Partial<Record<LlmRoute, RouteOverride>>;

/** Problems with an override map (unknown routes, models outside the allowlist, bad efforts); [] = valid. */
export function routeOverrideIssues(v: unknown): string[] {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return ['must be an object of route → {model?, effort?}'];
  const issues: string[] = [];
  for (const [route, o] of Object.entries(v as Record<string, unknown>)) {
    if (!isLlmRoute(route)) {
      issues.push(`unknown route "${route}"`);
      continue;
    }
    if (!o || typeof o !== 'object' || Array.isArray(o)) {
      issues.push(`${route}: must be {model?, effort?}`);
      continue;
    }
    for (const [k, val] of Object.entries(o as Record<string, unknown>)) {
      if (k === 'model') {
        if (!isAllowedModel(val)) issues.push(`${route}: model must be one of ${MODEL_ALLOWLIST.join(', ')}`);
      } else if (k === 'effort') {
        if (!(LLM_EFFORTS as readonly unknown[]).includes(val)) issues.push(`${route}: effort must be low, medium or high`);
      } else issues.push(`${route}: unknown field "${k}"`);
    }
  }
  return issues;
}

/** A route's effective parameters. */
export interface RouteParams extends RouteDefaults {
  route: LlmRoute;
  /** The model or effort came from an override. */
  overridden: boolean;
}

/** Defaults + a valid override (anything outside the allowlist is ignored, so Opus can never be selected). */
export function resolveRoute(route: LlmRoute, overrides?: RouteOverrides | null): RouteParams {
  const d = ROUTES[route];
  const o = overrides?.[route];
  const model = o && isAllowedModel(o.model) ? o.model : d.model;
  const effort = o?.effort && (LLM_EFFORTS as readonly string[]).includes(o.effort) ? o.effort : d.effort;
  return { ...d, route, model, effort, overridden: model !== d.model || effort !== d.effort };
}

export type ThinkingParam = { type: 'adaptive' } | { type: 'disabled' } | { type: 'between_tools' };

/** The `thinking` request field for a route on its resolved model. */
export function thinkingParam(p: Pick<RouteParams, 'model' | 'thinking'>): ThinkingParam {
  if (p.thinking === 'adaptive') return { type: 'adaptive' };
  return { type: specFor(p.model).thinkingOff };
}

/**
 * The system marker's TTL for a request sent in `mode`. A synchronous call on a batch route (on-demand
 * consolidation, a refusal re-run) writes at 5 min (1.25×) instead of the batch's 1 h (2×): a one-off is rarely
 * re-read 5–60 minutes later, and a 5-minute request still reads a live 1-hour entry a batch left.
 */
export function requestCacheTtl(p: Pick<RouteParams, 'cacheTtl' | 'mode'>, mode: 'sync' | 'batch'): CacheTtl | null {
  return p.cacheTtl && mode === 'sync' && p.mode === 'batch' ? '5m' : p.cacheTtl;
}

/** Whether a request on these params carries server-side fallbacks (sync only, models that support them). */
export function sendsFallbacks(p: Pick<RouteParams, 'model'>, mode: 'sync' | 'batch'): boolean {
  return mode === 'sync' && supportsSyncFallbacks(p.model);
}

/** Dollars as the CLIs print them: cents from $1 up, else four decimals (Haiku-priced amounts are often < 1¢). */
export const formatUsd = (n: number): string => `$${n >= 1 || n === 0 ? n.toFixed(2) : n.toFixed(4)}`;

/** Human label for a model id ("Claude Haiku 5.5"); unknown ids are returned as is. */
export const modelLabel = (model: string): string => (isAllowedModel(model) ? MODEL_SPECS[model].label : model);

// ---------------------------------------------------------------------------------------------- estimates

/**
 * Share of batch items assumed to MISS the cached system prefix (and write it at the route TTL) in pre-flight
 * estimates: cache hits inside a concurrent batch are best-effort (cost-optimization §2.5), and a 1-hour write costs
 * 20× a read, so budget gates must not assume every item reads.
 */
export const BATCH_CACHE_MISS_SHARE = 0.25;

/**
 * Pre-flight USD estimate for one request on a route: the user turn uncached, the route's expected output, and the
 * system prefix — read from the cache on sync routes, BATCH_CACHE_MISS_SHARE of it written (at the route TTL) on
 * batch requests, all of it written with `systemCached: false` (a cold call), and plain input on a route without a
 * marker or a prefix under the model's minimum cacheable size.
 */
export function estimateRouteUsd(
  p: Pick<RouteParams, 'model' | 'cacheTtl' | 'estOutputTokens'> & { mode?: 'sync' | 'batch' },
  o: { userTokens: number; systemTokens: number; mode: 'sync' | 'batch'; outputTokens?: number; systemCached?: boolean; cacheMissShare?: number },
): number {
  const system = Math.max(0, o.systemTokens);
  const ttl = p.mode ? requestCacheTtl({ cacheTtl: p.cacheTtl, mode: p.mode }, o.mode) : p.cacheTtl;
  const cacheable = ttl !== null && system >= specFor(p.model).minCacheTokens;
  const miss = !cacheable ? 0 : o.systemCached === false ? 1 : o.systemCached === true ? 0 : Math.min(1, Math.max(0, o.cacheMissShare ?? (o.mode === 'batch' ? BATCH_CACHE_MISS_SHARE : 0)));
  const written = cacheable ? system * miss : 0;
  return priceTokens(
    {
      input: Math.max(0, o.userTokens) + (cacheable ? 0 : system),
      output: Math.max(0, o.outputTokens ?? p.estOutputTokens),
      cacheRead: cacheable ? system - written : 0,
      cacheWrite5m: ttl === '5m' ? written : 0,
      cacheWrite1h: ttl === '1h' ? written : 0,
    },
    { model: p.model, mode: o.mode },
  );
}
