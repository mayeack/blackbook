/**
 * The LLM ledger: llm_requests (custom_id ledger + spend per request) and llm_batches, plus the budget guard.
 *
 * Every request gets a row BEFORE anything leaves the Mac (batch items before the HTTP submit; sync calls before
 * the call). Cost lands on the row when the usage is known, with the budget day (`spent_date`, local date in the
 * settings time zone). Budgets (settings): steady-state daily + monthly caps over pool 'steady', and a separate
 * one-time backfill pool. Batch items still in flight count with their estimate, so a night of submits can't
 * overshoot a cap before results arrive.
 */
import { localDate, uuidv7 } from '@yb/shared';
import type { DB } from '../db/connection';
import { readSetting, settingTimeZone } from '../settings/registry';
import type { BudgetPool, LlmClient, LlmEffort, LlmKind, LlmRoute, LlmSpend, LlmStopReason, LlmUnavailableReason, LlmUsage, SpendCheck } from './types';

/** llm_requests.status (CHECK list in 001_init). */
export type LedgerStatus =
  | 'pending'
  | 'submitted'
  | 'succeeded'
  | 'refused'
  | 'errored'
  | 'expired'
  | 'max_tokens'
  | 'schema_invalid'
  | 'applied'
  | 'rejected'
  | 'dead_letter';

/** Statuses that are final for the collector (a consumer handled the item). */
export const HANDLED_STATUSES: readonly LedgerStatus[] = ['applied', 'rejected', 'dead_letter'];

/** Outputs (and stored request bodies) are purged after this long. */
export const OUTPUT_RETENTION_MS = 30 * 86_400_000;

/** In-flight batch items count toward the caps with their estimate for this long (batches expire at 24 h). */
const IN_FLIGHT_WINDOW_MS = 25 * 3_600_000;

/** The pseudonymized request body kept for re-runs (route, system, messages, output JSON schema). */
export interface StoredParams {
  /** The route it was sent on (absent on rows written before routes existed: derived from the kind). */
  route?: LlmRoute;
  system: string;
  /** The TTL its system block was cached with (prices the cache write when the result arrives). */
  cacheTtl: '5m' | '1h';
  messages: unknown[];
  outputSchema: Record<string, unknown> | null;
  /** Evaluation runs only. */
  effortOverride?: LlmEffort;
}

export interface RequestRow {
  custom_id: string;
  batch_id: string | null;
  kind: LlmKind;
  subject_ref: string;
  attempt: number;
  prompt_version: string;
  model: string;
  input_hash: string;
  status: LedgerStatus;
  stop_reason: string | null;
  served_by_model: string | null;
  output: string | null;
  usage: string | null;
  cost_usd: number | null;
  created_at: number;
  applied_at: number | null;
  purged_at: number | null;
  pool: BudgetPool;
  mode: 'sync' | 'batch';
  run_id: string | null;
  purpose: string | null;
  effort: LlmEffort | null;
  max_tokens: number | null;
  params: string | null;
  estimate_usd: number | null;
  refusal_category: string | null;
  error_type: string | null;
  fallback_used: 0 | 1;
  retry_of: string | null;
  completed_at: number | null;
  not_before: number | null;
  spent_date: string | null;
}

export interface NewRequest {
  customId: string;
  kind: LlmKind;
  subjectRef: string;
  attempt: number;
  promptVersion: string;
  model: string;
  inputHash: string;
  pool: BudgetPool;
  mode: 'sync' | 'batch';
  runId: string | null;
  purpose: string | null;
  effort: LlmEffort;
  maxTokens: number;
  params: StoredParams | null;
  estimateUsd: number | null;
  retryOf?: string | null;
  status?: LedgerStatus;
  notBefore?: number | null;
}

/** A sync call's ledger id: `s_<uuid hex>` (never parses as a batch custom_id). */
export const syncRequestId = (now = Date.now()): string => `s_${uuidv7(now).replace(/-/g, '')}`;

export function getRequest(db: DB, customId: string): RequestRow | undefined {
  return db.prepare('SELECT * FROM llm_requests WHERE custom_id = ?').get(customId) as RequestRow | undefined;
}

export function insertRequest(db: DB, r: NewRequest, now: number): void {
  db.prepare(
    `INSERT INTO llm_requests (custom_id, kind, subject_ref, attempt, prompt_version, model, input_hash, status, pool, mode, run_id, purpose,
       effort, max_tokens, params, estimate_usd, retry_of, not_before, created_at)
     VALUES (@customId, @kind, @subjectRef, @attempt, @promptVersion, @model, @inputHash, @status, @pool, @mode, @runId, @purpose,
       @effort, @maxTokens, @params, @estimateUsd, @retryOf, @notBefore, @now)`,
  ).run({
    ...r,
    status: r.status ?? 'pending',
    params: r.params ? JSON.stringify(r.params) : null,
    retryOf: r.retryOf ?? null,
    notBefore: r.notBefore ?? null,
    now,
  });
}

/** Re-uses a row that never reached the API (failed submit) for the same custom_id; false if the id is taken. */
export function reuseUnsentRequest(db: DB, r: NewRequest, now: number): boolean {
  const row = getRequest(db, r.customId);
  if (!row) {
    insertRequest(db, r, now);
    return true;
  }
  if (row.batch_id !== null || !['pending', 'errored'].includes(row.status)) return false;
  db.prepare('DELETE FROM llm_requests WHERE custom_id = ?').run(r.customId);
  insertRequest(db, { ...r, retryOf: r.retryOf ?? row.retry_of }, now);
  return true;
}

export interface RequestOutcome {
  status: LedgerStatus;
  stopReason?: LlmStopReason | string | null;
  servedByModel?: string | null;
  output?: string | null;
  usage?: LlmUsage | null;
  refusalCategory?: string | null;
  errorType?: string | null;
}

/** Records a result (usage, cost on the budget day, output). */
export function recordOutcome(db: DB, customId: string, o: RequestOutcome, now: number, o2: { onlyIfOpen?: boolean } = {}): boolean {
  const day = o.usage ? localDate(now, settingTimeZone(db)) : null;
  const res = db
    .prepare(
      `UPDATE llm_requests SET status = @status, stop_reason = @stopReason, served_by_model = COALESCE(@servedByModel, served_by_model),
         output = @output, usage = COALESCE(@usage, usage), cost_usd = COALESCE(@cost, cost_usd), refusal_category = @refusalCategory,
         error_type = @errorType, fallback_used = MAX(fallback_used, @fallback), completed_at = @now, spent_date = COALESCE(@day, spent_date)
       WHERE custom_id = @customId ${o2.onlyIfOpen ? `AND status IN ('pending','submitted')` : ''}`,
    )
    .run({
      customId,
      status: o.status,
      stopReason: o.stopReason ?? null,
      servedByModel: o.servedByModel ?? null,
      output: o.output ?? null,
      usage: o.usage ? JSON.stringify(o.usage) : null,
      cost: o.usage ? o.usage.costUsd : null,
      refusalCategory: o.refusalCategory ?? null,
      errorType: o.errorType ?? null,
      fallback: o.usage?.fallbackUsed ? 1 : 0,
      now,
      day,
    });
  return res.changes > 0;
}

/** Cumulative usage for a call that spans several HTTP requests (tool loops). */
export function recordUsage(db: DB, customId: string, usage: LlmUsage, now: number): void {
  db.prepare(`UPDATE llm_requests SET usage = ?, cost_usd = ?, served_by_model = ?, fallback_used = ?, spent_date = ? WHERE custom_id = ?`).run(
    JSON.stringify(usage),
    usage.costUsd,
    usage.servedByModel,
    usage.fallbackUsed ? 1 : 0,
    localDate(now, settingTimeZone(db)),
    customId,
  );
}

/**
 * The collector handled an item: its final status here, and `applied_at` doubles as "handled at" so a replayed
 * result is never handled twice.
 */
export function markHandled(db: DB, customId: string, status: LedgerStatus, now: number, errorType?: string | null): void {
  db.prepare(`UPDATE llm_requests SET status = ?, applied_at = ?, error_type = COALESCE(?, error_type) WHERE custom_id = ?`).run(status, now, errorType ?? null, customId);
}

/** For consumers: an item was applied / rejected / dead-lettered (or any other ledger status). */
export function markRequest(db: DB, customId: string, status: LedgerStatus, now = Date.now(), errorType?: string): void {
  db.prepare(
    `UPDATE llm_requests SET status = ?, applied_at = CASE WHEN ? IN ('applied','rejected') THEN ? ELSE applied_at END,
       error_type = COALESCE(?, error_type) WHERE custom_id = ?`,
  ).run(status, status, now, errorType ?? null, customId);
}

// ---------------------------------------------------------------------------------------------- batches

export interface BatchRow {
  id: string;
  run_id: string;
  purpose: string;
  status: string;
  request_count: number;
  submitted_at: number | null;
  ended_at: number | null;
  results_fetched_at: number | null;
  usage: string | null;
  cost_usd: number | null;
  pool: BudgetPool;
  counts: string | null;
  last_polled_at: number | null;
  poll_count: number;
  collected_at: number | null;
}

export function getBatch(db: DB, id: string): BatchRow | undefined {
  return db.prepare('SELECT * FROM llm_batches WHERE id = ?').get(id) as BatchRow | undefined;
}

export function openBatches(db: DB): BatchRow[] {
  return db.prepare('SELECT * FROM llm_batches WHERE collected_at IS NULL ORDER BY submitted_at, id').all() as BatchRow[];
}

/** Totals over a batch's items (after its results were fetched). */
export function batchTotals(db: DB, batchId: string): { usage: Record<string, number>; costUsd: number } {
  const rows = db.prepare('SELECT usage, cost_usd FROM llm_requests WHERE batch_id = ? AND usage IS NOT NULL').all(batchId) as { usage: string; cost_usd: number | null }[];
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
  let costUsd = 0;
  for (const r of rows) {
    const u = JSON.parse(r.usage) as Partial<LlmUsage>;
    usage.inputTokens += u.inputTokens ?? 0;
    usage.outputTokens += u.outputTokens ?? 0;
    usage.cacheReadInputTokens += u.cacheReadInputTokens ?? 0;
    usage.cacheCreationInputTokens += u.cacheCreationInputTokens ?? 0;
    costUsd += r.cost_usd ?? 0;
  }
  return { usage, costUsd };
}

// ---------------------------------------------------------------------------------------------- budget

export interface BudgetSettings {
  enabled: boolean;
  daily: number;
  monthly: number;
  backfill: number;
}

export function budgetSettings(db: DB): BudgetSettings {
  return {
    enabled: readSetting(db, 'llm.enabled'),
    daily: readSetting(db, 'llm.daily_budget_usd'),
    monthly: readSetting(db, 'llm.monthly_budget_usd'),
    backfill: readSetting(db, 'llm.backfill_budget_usd'),
  };
}

interface SpendTotals {
  today: number;
  month: number;
  backfill: number;
  inFlightSteady: number;
  inFlightBackfill: number;
  requestsToday: number;
}

function totals(db: DB, now: number): SpendTotals {
  const today = localDate(now, settingTimeZone(db));
  const month = today.slice(0, 7);
  const sum = (sql: string, ...args: unknown[]) => (db.prepare(sql).pluck().get(...args) as number | null) ?? 0;
  return {
    today: sum(`SELECT SUM(cost_usd) FROM llm_requests WHERE pool = 'steady' AND spent_date = ?`, today),
    month: sum(`SELECT SUM(cost_usd) FROM llm_requests WHERE pool = 'steady' AND spent_date >= ? AND spent_date < ?`, `${month}-01`, `${month}-32`),
    backfill: sum(`SELECT SUM(cost_usd) FROM llm_requests WHERE pool = 'backfill'`),
    inFlightSteady: sum(
      `SELECT SUM(estimate_usd) FROM llm_requests WHERE pool = 'steady' AND status = 'submitted' AND cost_usd IS NULL AND created_at >= ?`,
      now - IN_FLIGHT_WINDOW_MS,
    ),
    inFlightBackfill: sum(
      `SELECT SUM(estimate_usd) FROM llm_requests WHERE pool = 'backfill' AND status = 'submitted' AND cost_usd IS NULL AND created_at >= ?`,
      now - IN_FLIGHT_WINDOW_MS,
    ),
    requestsToday: sum(`SELECT COUNT(*) FROM llm_requests WHERE spent_date = ?`, today),
  };
}

/** Key/enabled/caps. At a cap: budget_daily / budget_monthly / budget_backfill (callers fall back). */
export function checkSpend(db: DB, configured: boolean, pool: BudgetPool, estimateUsd: number, now: number): SpendCheck {
  if (!configured) return { ok: false, reason: 'no_key' };
  const s = budgetSettings(db);
  if (!s.enabled) return { ok: false, reason: 'disabled' };
  const t = totals(db, now);
  const est = Math.max(0, estimateUsd);
  if (pool === 'backfill') {
    return t.backfill + t.inFlightBackfill + est >= s.backfill ? { ok: false, reason: 'budget_backfill' } : { ok: true };
  }
  if (t.today + t.inFlightSteady + est >= s.daily) return { ok: false, reason: 'budget_daily' };
  if (t.month + t.inFlightSteady + est >= s.monthly) return { ok: false, reason: 'budget_monthly' };
  return { ok: true };
}

export function spendSnapshot(db: DB, now: number): LlmSpend {
  const s = budgetSettings(db);
  const t = totals(db, now);
  const since = localDate(now - 6 * 86_400_000, settingTimeZone(db));
  const c = db
    .prepare(
      `SELECT SUM(json_extract(usage, '$.cacheReadInputTokens')) AS hit,
              SUM(json_extract(usage, '$.cacheReadInputTokens') + json_extract(usage, '$.cacheCreationInputTokens') + json_extract(usage, '$.inputTokens')) AS total
       FROM llm_requests WHERE usage IS NOT NULL AND spent_date >= ?`,
    )
    .get(since) as { hit: number | null; total: number | null };
  return {
    todayUsd: round(t.today),
    monthUsd: round(t.month),
    backfillUsd: round(t.backfill),
    dailyBudgetUsd: s.daily,
    monthlyBudgetUsd: s.monthly,
    backfillBudgetUsd: s.backfill,
    requestsToday: t.requestsToday,
    cacheHitRate: c.total ? (c.hit ?? 0) / c.total : null,
  };
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

/** For callers that prefer an exception to an 'unavailable' outcome: at a cap (or no key / disabled). */
export class BudgetExceeded extends Error {
  constructor(readonly reason: LlmUnavailableReason) {
    super(`llm unavailable: ${reason}`);
    this.name = 'BudgetExceeded';
  }
}

/** Throws BudgetExceeded unless a call from `pool` (with `estimateUsd`) may run now. */
export function requireBudget(llm: Pick<LlmClient, 'canSpend'>, pool: BudgetPool = 'steady', estimateUsd = 0): void {
  const s = llm.canSpend(pool, estimateUsd);
  if (!s.ok) throw new BudgetExceeded(s.reason);
}

/** People and conversations the owner excluded from the model (settings llm.excluded_*): never put them in a packet. */
export function llmExclusions(db: DB): { people: ReadonlySet<string>; conversations: ReadonlySet<string> } {
  return { people: new Set(readSetting(db, 'llm.excluded_person_ids')), conversations: new Set(readSetting(db, 'llm.excluded_conversation_ids')) };
}

// ---------------------------------------------------------------------------------------------- alerts & purge

/** Opens (or keeps) the one 'llm' alert. The message is fixed text: never ids, names or content. */
export function openLlmAlert(db: DB, message: string, now: number, severity: 'info' | 'warning' | 'critical' = 'warning'): void {
  const open = db.prepare(`SELECT id FROM alerts WHERE source = 'llm' AND resolved_at IS NULL`).pluck().get();
  if (open) return;
  db.prepare(`INSERT INTO alerts (id, source, severity, message, opened_at) VALUES (?, 'llm', ?, ?, ?)`).run(uuidv7(now), severity, message, now);
}

/** Clears outputs and stored request bodies older than 30 days, in chunks. Returns rows purged. */
export function purgeOutputsChunk(db: DB, now: number, limit = 500): number {
  return db
    .prepare(
      `UPDATE llm_requests SET output = NULL, params = NULL, purged_at = ?
       WHERE custom_id IN (SELECT custom_id FROM llm_requests WHERE purged_at IS NULL AND created_at < ? AND (output IS NOT NULL OR params IS NOT NULL) LIMIT ?)`,
    )
    .run(now, now - OUTPUT_RETENTION_MS, limit).changes;
}
