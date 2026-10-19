/**
 * The recurring API-efficiency check (owner, 2026-10-18: "regularly make sure you are being as token and model
 * efficient as possible", meaning the paid API calls). Read-only over llm_requests; counts and dollars only, never
 * ids, names or content.
 *
 *   efficiencyReport(db, now, {days})   per kind × mode: requests, the four token meters, cost, the cache-read share of
 *                                       the prompt, what caching saved (negative = the writes cost more than the reads
 *                                       saved), estimate accuracy, spend on unusable outcomes, prompts billed on
 *                                       Haiku's >100K card, requests off the route's default model; totals and a
 *                                       30-day projection of the steady pool; and the findings.
 *   formatEfficiencyReport(report)      the lines `yb llm-usage` prints.
 *
 * Findings are fixed sentences with counts. 'warning' = spend that would scale with volume (the weekly llm-efficiency
 * job opens the 'llm' alert for it); 'info' = worth knowing, printed by `yb llm-usage`. Thresholds are loose on
 * purpose: the bill is pennies a day, so a finding means a pattern, not a rounding error.
 *
 * This is the measured profile the cost-optimization workflow starts from ("the app's own usage logs"): it decides
 * which lever is worth an eval cycle before any prompt, model or effort change.
 */
import { localDate } from '@yb/shared';
import type { DB } from '../db/connection';
import { ROUTE_OF_KIND } from './batches';
import type { CacheTtl } from './caching';
import { formatUsd, modelLabel, priceTokens, PROMPT_TOKEN_LIMIT, requestCacheTtl, ROUTES, type LlmRoute } from './models';
import type { LlmUsage } from './types';

/** Rate findings (cache, estimates, sync share) need at least this many billed requests in the window. */
export const MIN_REQUESTS = 10;
/** wasted_spend: unusable outcomes at or above this share of a kind's spend (and at least WASTE_MIN_COUNT of them). */
export const WASTE_SHARE = 0.1;
export const WASTE_MIN_COUNT = 3;
/** estimate_low: actual cost above this multiple of the pre-flight estimates (the budget gates trust those). */
export const ESTIMATE_LOW_RATIO = 1.5;
/** failed_requests: at least this many requests the API rejected or that failed outright. */
export const FAILED_MIN_COUNT = 5;

/** Kinds whose ledger row covers a whole tool loop (usage summed over turns, so the >100K check can't apply). */
const LOOP_KINDS: ReadonlySet<string> = new Set(['ask']);
/** Billed outcomes that produced nothing usable. ('rejected' is not one: valid output the gates declined.) */
const WASTE_STATUSES: ReadonlySet<string> = new Set(['schema_invalid', 'max_tokens', 'refused', 'errored', 'dead_letter', 'expired']);

export interface KindProfile {
  kind: string;
  mode: 'sync' | 'batch';
  /** The route the kind is sent on (null for a kind outside the table). */
  route: LlmRoute | null;
  /** Ledger rows created in the window. */
  requests: number;
  /** Rows with usage (the API answered and billed). */
  billed: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  costUsd: number;
  /** Cache reads ÷ the whole prompt (uncached + read + write); null with no prompt tokens. */
  cacheReadShare: number | null;
  /** What the same tokens would have cost with no caching, minus what they cost. Negative = caching lost money. */
  cacheSavedUsd: number;
  /** Σ cost ÷ Σ estimate over billed rows that carried an estimate; null when none did. */
  estimateRatio: number | null;
  estimated: number;
  /** Billed rows whose outcome was unusable (schema_invalid, max_tokens, refused, a billed error). */
  wasted: number;
  wastedUsd: number;
  /** Unbilled rows the API rejected or that failed (no usage). */
  failed: number;
  /** Single-request rows whose prompt went over PROMPT_TOKEN_LIMIT (billed on Haiku's long-context card). */
  overLimit: number;
  /** Rows on a model other than the route's default (an owner override). */
  offDefaultModel: number;
  models: string[];
}

export type FindingCode = 'cache_unpaid' | 'long_context' | 'wasted_spend' | 'estimate_low' | 'off_default_model' | 'sync_on_batch_route' | 'failed_requests';

export interface EfficiencyFinding {
  code: FindingCode;
  severity: 'warning' | 'info';
  kind: string;
  mode: 'sync' | 'batch';
  /** A fixed sentence with counts (safe for logs and the alert list). */
  message: string;
}

export interface EfficiencyReport {
  days: number;
  since: number;
  until: number;
  kinds: KindProfile[];
  totals: {
    requests: number;
    billed: number;
    costUsd: number;
    steadyUsd: number;
    backfillUsd: number;
    cacheReadShare: number | null;
    cacheSavedUsd: number;
    /** The steady pool's spend scaled to 30 days (the backfill is one-time, so it is left out). */
    projectedSteady30dUsd: number;
  };
  findings: EfficiencyFinding[];
}

interface Row {
  kind: string;
  mode: 'sync' | 'batch';
  model: string;
  status: string;
  pool: string;
  usage: string | null;
  cost_usd: number | null;
  estimate_usd: number | null;
  cache_ttl: string | null;
}

const isTtl = (v: unknown): v is CacheTtl => v === '5m' || v === '1h';

/** The TTL a row's cache writes were billed at: its stored params, else the route's TTL for the row's mode. */
function ttlOf(r: Row, route: LlmRoute | null): CacheTtl {
  if (isTtl(r.cache_ttl)) return r.cache_ttl;
  return (route && requestCacheTtl(ROUTES[route], r.mode)) ?? '5m';
}

export function efficiencyReport(db: DB, now: number, o: { days?: number } = {}): EfficiencyReport {
  const days = Math.max(1, Math.min(90, Math.floor(o.days ?? 7)));
  const since = now - days * 86_400_000;
  const rows = db
    .prepare(
      `SELECT kind, mode, model, status, pool, usage, cost_usd, estimate_usd,
              CASE WHEN params IS NOT NULL AND json_valid(params) THEN json_extract(params, '$.cacheTtl') END AS cache_ttl
       FROM llm_requests WHERE created_at >= ? AND created_at <= ?`,
    )
    .all(since, now) as Row[];

  const groups = new Map<string, KindProfile & { est: number; estCost: number; modelSet: Set<string> }>();
  let steadyUsd = 0;
  let backfillUsd = 0;
  for (const r of rows) {
    const key = `${r.kind}\u0000${r.mode}`;
    const route = (ROUTE_OF_KIND as Record<string, LlmRoute | undefined>)[r.kind] ?? null;
    let g = groups.get(key);
    if (!g) {
      g = {
        kind: r.kind,
        mode: r.mode,
        route,
        requests: 0,
        billed: 0,
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        cacheReadShare: null,
        cacheSavedUsd: 0,
        estimateRatio: null,
        estimated: 0,
        wasted: 0,
        wastedUsd: 0,
        failed: 0,
        overLimit: 0,
        offDefaultModel: 0,
        models: [],
        est: 0,
        estCost: 0,
        modelSet: new Set(),
      };
      groups.set(key, g);
    }
    g.requests++;
    g.modelSet.add(r.model);
    if (route && r.model !== ROUTES[route].model) g.offDefaultModel++;
    const u = r.usage ? (JSON.parse(r.usage) as Partial<LlmUsage>) : null;
    if (!u) {
      if (r.status === 'errored' || r.status === 'dead_letter') g.failed++;
      continue;
    }
    const input = u.inputTokens ?? 0;
    const read = u.cacheReadInputTokens ?? 0;
    const write = u.cacheCreationInputTokens ?? 0;
    const output = u.outputTokens ?? 0;
    const cost = r.cost_usd ?? 0;
    g.billed++;
    g.inputTokens += input;
    g.cacheReadTokens += read;
    g.cacheWriteTokens += write;
    g.outputTokens += output;
    g.costUsd += cost;
    if (r.pool === 'backfill') backfillUsd += cost;
    else steadyUsd += cost;
    const ttl = ttlOf(r, route);
    const priced = { model: r.model, mode: r.mode };
    const withCache = priceTokens({ input, output, cacheRead: read, cacheWrite5m: ttl === '5m' ? write : 0, cacheWrite1h: ttl === '1h' ? write : 0 }, priced);
    const noCache = priceTokens({ input: input + read + write, output, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, priced);
    g.cacheSavedUsd += noCache - withCache;
    if (r.estimate_usd !== null && r.estimate_usd > 0) {
      g.estimated++;
      g.est += r.estimate_usd;
      g.estCost += cost;
    }
    if (WASTE_STATUSES.has(r.status)) {
      g.wasted++;
      g.wastedUsd += cost;
    }
    if (!LOOP_KINDS.has(r.kind) && input + read + write > PROMPT_TOKEN_LIMIT) g.overLimit++;
  }

  const kinds: KindProfile[] = [...groups.values()]
    .map(({ est, estCost, modelSet, ...g }) => {
      const prompt = g.inputTokens + g.cacheReadTokens + g.cacheWriteTokens;
      return { ...g, cacheReadShare: prompt ? g.cacheReadTokens / prompt : null, estimateRatio: est > 0 ? estCost / est : null, models: [...modelSet].sort() };
    })
    .sort((a, b) => b.costUsd - a.costUsd || a.kind.localeCompare(b.kind) || a.mode.localeCompare(b.mode));

  const sum = (f: (k: KindProfile) => number) => kinds.reduce((n, k) => n + f(k), 0);
  const prompt = sum((k) => k.inputTokens + k.cacheReadTokens + k.cacheWriteTokens);
  return {
    days,
    since,
    until: now,
    kinds,
    totals: {
      requests: sum((k) => k.requests),
      billed: sum((k) => k.billed),
      costUsd: sum((k) => k.costUsd),
      steadyUsd,
      backfillUsd,
      cacheReadShare: prompt ? sum((k) => k.cacheReadTokens) / prompt : null,
      cacheSavedUsd: sum((k) => k.cacheSavedUsd),
      projectedSteady30dUsd: (steadyUsd / days) * 30,
    },
    findings: kinds.flatMap(findingsFor),
  };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** The findings for one kind × mode profile (fixed sentences; counts and dollars only). */
export function findingsFor(k: KindProfile): EfficiencyFinding[] {
  const out: EfficiencyFinding[] = [];
  const add = (code: FindingCode, severity: EfficiencyFinding['severity'], message: string) => out.push({ code, severity, kind: k.kind, mode: k.mode, message: `${k.kind} (${k.mode}): ${message}` });
  if (k.billed >= MIN_REQUESTS && k.cacheWriteTokens > 0 && k.cacheSavedUsd < 0) {
    add(
      'cache_unpaid',
      'warning',
      `prompt caching cost ${formatUsd(-k.cacheSavedUsd)} more than it saved (${k.cacheWriteTokens} tokens written, ${k.cacheReadTokens} read): look for a volatile system prompt, or a TTL longer than the gap between calls.`,
    );
  }
  if (k.overLimit > 0) {
    add('long_context', 'warning', `${k.overLimit} request(s) went over ${PROMPT_TOKEN_LIMIT / 1000}K prompt tokens and were billed at Haiku's 5× long-context rate: tighten the packet or window size.`);
  }
  if (k.wasted >= WASTE_MIN_COUNT && k.costUsd > 0 && k.wastedUsd / k.costUsd >= WASTE_SHARE) {
    add(
      'wasted_spend',
      'warning',
      `${k.wasted} of ${k.billed} billed request(s) (${pct(k.wastedUsd / k.costUsd)} of its spend) produced nothing usable (invalid output, max_tokens or refusal): check the prompt, schema and max_tokens.`,
    );
  }
  if (k.estimated >= MIN_REQUESTS && k.estimateRatio !== null && k.estimateRatio > ESTIMATE_LOW_RATIO) {
    add('estimate_low', 'warning', `actual cost ran ${k.estimateRatio.toFixed(1)}× the pre-flight estimates, so the budget gates under-count it: recalibrate its estimate.`);
  }
  if (k.offDefaultModel > 0 && k.route) {
    const others = k.models.filter((m) => m !== ROUTES[k.route!].model).map(modelLabel);
    add('off_default_model', 'info', `${k.offDefaultModel} request(s) ran on ${others.join(', ')} instead of ${modelLabel(ROUTES[k.route].model)}: keep a route override only while an eval shows the default falls short.`);
  }
  if (k.mode === 'sync' && k.route && ROUTES[k.route].mode === 'batch' && k.billed >= MIN_REQUESTS) {
    add('sync_on_batch_route', 'info', `${k.billed} synchronous request(s) on a batch route, at twice the batch price (${formatUsd(k.costUsd)}).`);
  }
  if (k.failed >= FAILED_MIN_COUNT) {
    add('failed_requests', 'info', `${k.failed} request(s) were rejected by the API or failed (not billed, but their work was lost and may be re-sent).`);
  }
  return out;
}

/** Thousands as "12.3k", millions as "1.23M". */
const n = (x: number) => (x >= 1e6 ? `${(x / 1e6).toFixed(2)}M` : x >= 1e4 ? `${(x / 1e3).toFixed(1)}k` : String(x));

/** The report as `yb llm-usage` prints it (counts and dollars only). */
export function formatEfficiencyReport(r: EfficiencyReport, timeZone?: string): string[] {
  const t = r.totals;
  const lines = [
    `LLM usage ${timeZone ? `${localDate(r.since, timeZone)} → ${localDate(r.until, timeZone)}` : `last ${r.days} day(s)`} (counts and dollars only):`,
    `  total ${formatUsd(t.costUsd)} · ${t.requests} request(s), ${t.billed} billed · cache-read share ${t.cacheReadShare === null ? '-' : pct(t.cacheReadShare)} · caching saved ${formatUsd(t.cacheSavedUsd)}`,
    `  steady ${formatUsd(t.steadyUsd)} (≈ ${formatUsd(t.projectedSteady30dUsd)} per 30 days at this rate) · backfill ${formatUsd(t.backfillUsd)}`,
  ];
  if (r.kinds.length) {
    const head = ['kind', 'mode', 'reqs', 'input', 'cache r', 'cache w', 'output', 'cost', '$/req', 'cache%', 'cost/est'];
    const rows = r.kinds.map((k) => [
      k.kind,
      k.mode,
      String(k.requests),
      n(k.inputTokens),
      n(k.cacheReadTokens),
      n(k.cacheWriteTokens),
      n(k.outputTokens),
      formatUsd(k.costUsd),
      k.billed ? formatUsd(k.costUsd / k.billed) : '-',
      k.cacheReadShare === null ? '-' : pct(k.cacheReadShare),
      k.estimateRatio === null ? '-' : k.estimateRatio.toFixed(2),
    ]);
    const widths = [head, ...rows].reduce<number[]>((w, row) => row.map((c, i) => Math.max(w[i] ?? 0, c.length)), []);
    for (const row of [head, ...rows]) lines.push(`  ${row.map((c, i) => c.padEnd(widths[i]!)).join('  ')}`.trimEnd());
  }
  lines.push(r.findings.length ? 'findings:' : 'findings: none');
  for (const f of r.findings) lines.push(`  [${f.severity}] ${f.message}`);
  return lines;
}
