/**
 * Batch orchestration (intelligence §4.6 / §4.7) over any LlmClient and the llm_requests ledger.
 *
 * Stages that submit Message Batches (extraction, consolidation, circle naming, calendar adjudication) register a
 * BatchConsumer for their `purpose` (the `purpose` passed to submitBatch). The llm-collect job (llm/jobs.ts) then
 * polls open batches, streams results (any order, keyed by custom_id) and applies the policy per item:
 *
 *   succeeded/end_turn      → zod + validate → consumer.apply. Invalid JSON/schema: re-queued once, then dead-letter.
 *   succeeded/refusal       → final: status 'refused' + consumer.fail('refused') (Haiku 5.5 has no server-side
 *                             fallback, and re-sending the same request would only pay for a second refusal). Only
 *                             when the item went out on a model with sync fallbacks (a route overridden to Sonnet 5.5),
 *                             its route still resolves to one, and the decline is a category the fallback retries
 *                             (`cyber`, `frontier_llm`; never bio / general_harms / reasoning_extraction) is it re-run
 *                             ONCE synchronously through parse(), which sends them.
 *   succeeded/max_tokens    → re-queued once with max_tokens × 2 (attempt + 1); again → consumer.split (the split
 *                             hook: smaller items with fresh ids) or dead-letter.
 *   errored/invalid_request → dead-letter + an 'llm' alert (a prompt or schema bug).
 *   errored/other, canceled → re-queued (immediately before 06:00 local, else with the next night's submit).
 *   expired                 → re-queued for the next night.        attempts > 3 → dead-letter.
 *
 * Re-queued items wait as 'pending' ledger rows (batch_id NULL, not_before) and go out on a later collect run, on
 * the route stored with them (its current parameters: model, effort, thinking and TTL come from llm/models.ts).
 * A stage that runs its own collect loop (extraction: extract-collect) simply registers no consumer: its batches
 * are left to it (its batchResults() calls book the ledger). A batch nobody fetched within ORPHAN_AFTER_MS is
 * booked here (results and costs land in the ledger) and nothing is re-run.
 * Every item is handled once (ledger applied_at = handled at), so replays and restarts are idempotent.
 */
import { localParts } from '@yb/shared';
import type { z } from 'zod';
import type { DB } from '../db/connection';
import { errorFields, nullLogger, type Logger } from '../ops/logger';
import { settingTimeZone } from '../settings/registry';
import { AGENT_TIMES } from '../scheduler/timetable';
import * as ledger from './ledger';
import { isLlmRoute, refusalRerunnable, type LlmRoute } from './models';
import {
  customId as makeCustomId,
  parseCustomId,
  type BudgetPool,
  type LlmBatchItem,
  type LlmBatchResult,
  type LlmClient,
  type LlmEffort,
  type LlmKind,
  type LlmUsage,
} from './types';

export const MAX_ATTEMPTS = 3;
/** max_tokens never doubles past this (batch calls have no timeout concern; output pricing does). */
export const MAX_TOKENS_CEILING = 32_000;
/** A batch without a consumer whose results nobody fetched by then is booked by the collector. */
export const ORPHAN_AFTER_MS = 26 * 3_600_000;
/** Late errors (after this local time) wait for the next night's submit. */
export const RETRY_IMMEDIATELY_BEFORE = '06:00';

/** The route of a ledger row written before routes existed (by its kind). */
export const ROUTE_OF_KIND: Readonly<Record<LlmKind, LlmRoute>> = {
  extract: 'extract_steady',
  historical: 'extract_historical',
  consolidate: 'extract_consolidate',
  tiebreak: 'tiebreak',
  intent: 'intent',
  circle_name: 'circle_name',
  calendar: 'adjudicate',
  digest: 'digest_compose',
  command: 'draft_openers',
  brief: 'digest_compose',
  ask: 'ask_web',
  ticket: 'ticket_parse',
};

/** A ledger row as the consumer sees it (the pseudonymized request it was built from, for re-runs). */
export interface StoredBatchItem {
  customId: string;
  kind: LlmKind;
  route: LlmRoute;
  /** The model it was sent with. */
  model: string;
  subjectRef: string;
  promptVersion: string;
  attempt: number;
  pool: BudgetPool;
  runId: string | null;
  purpose: string;
  effort: LlmEffort;
  maxTokens: number;
  estimateUsd: number | null;
  retryOf: string | null;
  system: string;
  cacheTtl: '5m' | '1h';
  messages: LlmBatchItem['messages'];
  effortOverride?: LlmEffort;
}

export type BatchFailure = 'refused' | 'invalid' | 'max_tokens' | 'dead_letter';

export interface ApplyMeta {
  usage: LlmUsage | null;
  /** The value came from the synchronous refusal re-run (only for models with server-side fallbacks). */
  viaSync: boolean;
  fallbackUsed: boolean;
}

export interface BatchConsumer<T = unknown> {
  purpose: string;
  /** The zod schema the item was submitted with. */
  schema(item: StoredBatchItem): z.ZodType<T>;
  /** Code-side checks the API can't enforce (bounds, refs). Problems count as invalid output. */
  validate?(value: T, item: StoredBatchItem): string[];
  /** Validate-and-apply (journaled by the consumer). 'rejected' = valid JSON the gates threw away. */
  apply(db: DB, item: StoredBatchItem, value: T, meta: ApplyMeta): 'applied' | 'rejected';
  /** Final failure: the caller advances its watermark, marks the window refused, counts it. */
  fail?(db: DB, item: StoredBatchItem, why: BatchFailure): void;
  /** Split hook after a second max_tokens: smaller items (fresh custom ids), or [] to give up. */
  split?(item: StoredBatchItem): LlmBatchItem[];
}

const consumers = new Map<string, BatchConsumer<unknown>>();

/** Registers the consumer for a batch purpose; returns an unregister function. */
export function registerBatchConsumer<T>(c: BatchConsumer<T>): () => void {
  consumers.set(c.purpose, c as BatchConsumer<unknown>);
  return () => {
    if (consumers.get(c.purpose) === (c as BatchConsumer<unknown>)) consumers.delete(c.purpose);
  };
}

export const batchConsumer = (purpose: string): BatchConsumer<unknown> | undefined => consumers.get(purpose);

// ---------------------------------------------------------------------------------------------- policy

export type BatchAction =
  | { do: 'apply' }
  | { do: 'rerun_sync' }
  | { do: 'refused' }
  | { do: 'requeue'; maxTokens: number; nextNight: boolean }
  | { do: 'split' }
  | { do: 'dead_letter'; alert: boolean };

/**
 * What to do with one batch result (pure). `previous` is the status of the item this one retried, if any;
 * `rerunRefusal` is true only when a sync re-run with server-side fallbacks could rescue the refusal
 * (llm/models.ts refusalRerunnable: the item's and the route's current model support them, and the category is one
 * the fallback retries).
 */
export function batchAction(
  r: LlmBatchResult,
  item: { attempt: number; maxTokens: number; previous: ledger.LedgerStatus | null; rerunRefusal?: boolean },
  lateNow = false,
): BatchAction {
  const exhausted = item.attempt >= MAX_ATTEMPTS;
  if (r.type === 'succeeded') {
    if (r.stopReason === 'refusal') return item.rerunRefusal ? { do: 'rerun_sync' } : { do: 'refused' };
    if (r.stopReason === 'max_tokens') {
      if (item.previous === 'max_tokens' || item.maxTokens >= MAX_TOKENS_CEILING) return { do: 'split' };
      return exhausted ? { do: 'dead_letter', alert: false } : { do: 'requeue', maxTokens: Math.min(item.maxTokens * 2, MAX_TOKENS_CEILING), nextNight: false };
    }
    return { do: 'apply' };
  }
  if (r.type === 'errored' && r.errorType === 'invalid_request') return { do: 'dead_letter', alert: true };
  if (exhausted) return { do: 'dead_letter', alert: false };
  return { do: 'requeue', maxTokens: item.maxTokens, nextNight: r.type === 'expired' || lateNow };
}

/** A re-queued item: attempt + 1 in the custom_id (null when the id isn't a `{kind}{ver}-{subject}-{attempt}` id). */
export function retryCustomId(id: string): string | null {
  const p = parseCustomId(id);
  if (!p || p.attempt >= 99) return null;
  try {
    return makeCustomId(p.kind, p.version, p.subject, p.attempt + 1);
  } catch {
    return null;
  }
}

/** The item a stored row describes (null when its request body was purged). */
export function storedItem(row: ledger.RequestRow): StoredBatchItem | null {
  if (!row.params) return null;
  const p = JSON.parse(row.params) as ledger.StoredParams;
  return {
    customId: row.custom_id,
    kind: row.kind,
    route: p.route && isLlmRoute(p.route) ? p.route : ROUTE_OF_KIND[row.kind],
    model: row.model,
    subjectRef: row.subject_ref,
    promptVersion: row.prompt_version,
    attempt: row.attempt,
    pool: row.pool,
    runId: row.run_id,
    purpose: row.purpose ?? row.kind,
    effort: row.effort ?? 'low',
    maxTokens: row.max_tokens ?? 4000,
    estimateUsd: row.estimate_usd,
    retryOf: row.retry_of,
    system: p.system,
    cacheTtl: p.cacheTtl,
    messages: p.messages as LlmBatchItem['messages'],
    ...(p.effortOverride ? { effortOverride: p.effortOverride } : {}),
  };
}

/** ms from `now` until the next local HH:MM (DST-naive; good enough for "next night"). */
function msUntil(now: number, hhmm: string, tz: string): number {
  const [h, m] = localParts(now, tz).hhmm.split(':').map(Number) as [number, number];
  const [th, tm] = hhmm.split(':').map(Number) as [number, number];
  const mins = (th * 60 + tm - (h * 60 + m) + 1440) % 1440 || 1440;
  return mins * 60_000;
}

/** Writes the re-queued item as a pending ledger row; false when it can't be re-queued. */
export function requeue(db: DB, row: ledger.RequestRow, o: { maxTokens: number; notBefore: number | null; now: number }): boolean {
  const next = retryCustomId(row.custom_id);
  if (!next || !row.params || ledger.getRequest(db, next)) return false;
  ledger.insertRequest(
    db,
    {
      customId: next,
      kind: row.kind,
      subjectRef: row.subject_ref,
      attempt: row.attempt + 1,
      promptVersion: row.prompt_version,
      model: row.model,
      inputHash: row.input_hash,
      pool: row.pool,
      mode: 'batch',
      runId: row.run_id,
      purpose: row.purpose,
      effort: row.effort ?? 'low',
      maxTokens: o.maxTokens,
      params: JSON.parse(row.params) as ledger.StoredParams,
      estimateUsd: row.estimate_usd,
      retryOf: row.custom_id,
      notBefore: o.notBefore,
    },
    o.now,
  );
  return true;
}

// ---------------------------------------------------------------------------------------------- collect

export interface CollectOptions {
  db: DB;
  llm: LlmClient;
  now?: () => number;
  signal?: AbortSignal;
  log?: Logger;
}

export interface CollectStats extends Record<string, number> {
  batches_open: number;
  batches_ended: number;
  /** Batches of stages that collect their own results (no consumer registered). */
  batches_owned: number;
  results: number;
  unconsumed: number;
  applied: number;
  rejected: number;
  /** Refusals recorded as final (no re-run). */
  refused: number;
  rerun_sync: number;
  requeued: number;
  split: number;
  failed: number;
  dead_letter: number;
  poll_errors: number;
  apply_errors: number;
  submitted: number;
}

const yieldLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

const DEAD_LETTER_ALERT = 'An LLM batch request was rejected as invalid and dead-lettered. Check the stage prompt or schema.';

/** One collect pass: poll → stream → validate → apply / re-run / re-queue, then submit due re-queues. */
export async function collectBatches(o: CollectOptions): Promise<CollectStats> {
  const now = o.now ?? Date.now;
  const log = o.log ?? nullLogger;
  const stats: CollectStats = {
    batches_open: 0,
    batches_ended: 0,
    batches_owned: 0,
    results: 0,
    unconsumed: 0,
    applied: 0,
    rejected: 0,
    refused: 0,
    rerun_sync: 0,
    requeued: 0,
    split: 0,
    failed: 0,
    dead_letter: 0,
    poll_errors: 0,
    apply_errors: 0,
    submitted: 0,
  };
  for (const b of ledger.openBatches(o.db)) {
    if (o.signal?.aborted) return stats;
    const consumer = consumers.get(b.purpose);
    if (!consumer) {
      if (b.results_fetched_at) {
        o.db.prepare('UPDATE llm_batches SET collected_at = ? WHERE id = ?').run(now(), b.id);
        continue;
      }
      if ((b.submitted_at ?? 0) > now() - ORPHAN_AFTER_MS) {
        stats.batches_owned++;
        continue;
      }
    }
    let ended: boolean;
    try {
      ended = (await o.llm.batchStatus(b.id)).processing === 'ended';
    } catch (e) {
      stats.poll_errors++;
      log.warn('llm_batch_poll_failed', { batch_id: b.id, ...errorFields(e) });
      continue;
    }
    if (!ended) {
      stats.batches_open++;
      continue;
    }
    const splits: LlmBatchItem[] = [];
    let n = 0;
    let aborted = false;
    for await (const r of o.llm.batchResults(b.id)) {
      stats.results++;
      if (!consumer) stats.unconsumed++;
      else {
        try {
          await handleResult(o, consumer, r, stats, splits, now);
        } catch (e) {
          stats.apply_errors++;
          ledger.markHandled(o.db, r.customId, 'dead_letter', now(), 'apply_error');
          log.error('llm_batch_apply_failed', { batch_id: b.id, ...errorFields(e) });
        }
      }
      if (++n % 25 === 0) await yieldLoop();
      if (o.signal?.aborted) {
        aborted = true;
        break;
      }
    }
    if (aborted) return stats;
    if (splits.length) await submitItems(o, b.purpose, b.run_id, splits, stats, log);
    o.db.prepare('UPDATE llm_batches SET collected_at = ? WHERE id = ?').run(now(), b.id);
    stats.batches_ended++;
  }
  if (!o.signal?.aborted) await submitDueRequeues(o, stats, now, log);
  return stats;
}

async function handleResult(
  o: CollectOptions,
  consumer: BatchConsumer<unknown>,
  r: LlmBatchResult,
  stats: CollectStats,
  splits: LlmBatchItem[],
  now: () => number,
): Promise<void> {
  const db = o.db;
  const row = ledger.getRequest(db, r.customId);
  if (!row || row.applied_at !== null || ledger.HANDLED_STATUSES.includes(row.status)) return;
  const item = storedItem(row);
  const previous = row.retry_of ? (ledger.getRequest(db, row.retry_of)?.status ?? null) : null;
  const late = localParts(now(), settingTimeZone(db)).hhmm >= RETRY_IMMEDIATELY_BEFORE;
  const fail = (why: BatchFailure, status: ledger.LedgerStatus, errorType?: string | null) => {
    ledger.markHandled(db, row.custom_id, status, now(), errorType);
    if (status === 'dead_letter') stats.dead_letter++;
    stats.failed++;
    if (item) consumer.fail?.(db, item, why);
  };
  if (!item) return fail('dead_letter', 'dead_letter', 'params_purged');

  const apply = (value: unknown, meta: ApplyMeta) => {
    const result = consumer.apply(db, item, value, meta);
    ledger.markHandled(db, row.custom_id, result, now());
    stats[result === 'applied' ? 'applied' : 'rejected']++;
  };
  const validateText = (text: string | null): { ok: true; value: unknown } | { ok: false } => {
    if (!text) return { ok: false };
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false };
    }
    const parsed = consumer.schema(item).safeParse(json);
    if (!parsed.success) return { ok: false };
    return (consumer.validate?.(parsed.data, item) ?? []).length ? { ok: false } : { ok: true, value: parsed.data };
  };

  const rerunRefusal = r.type === 'succeeded' && r.stopReason === 'refusal' && refusalRerunnable(item.model, o.llm.params(item.route).model, r.refusalCategory);
  const action = batchAction(r, { attempt: row.attempt, maxTokens: item.maxTokens, previous, rerunRefusal }, late);
  switch (action.do) {
    case 'apply': {
      const v = validateText(r.type === 'succeeded' ? r.text : null);
      if (v.ok) return apply(v.value, { usage: r.type === 'succeeded' ? r.usage : null, viaSync: false, fallbackUsed: false });
      // Invalid output: retry once, then dead-letter.
      if (previous !== 'schema_invalid' && row.attempt < MAX_ATTEMPTS && requeue(db, row, { maxTokens: item.maxTokens, notBefore: null, now: now() })) {
        ledger.markHandled(db, row.custom_id, 'schema_invalid', now());
        stats.requeued++;
        return;
      }
      return fail('invalid', 'dead_letter', 'schema_invalid');
    }
    case 'refused':
      stats.refused++;
      return fail('refused', 'refused', 'refusal');
    case 'rerun_sync': {
      stats.rerun_sync++;
      const out = await o.llm.parse({
        kind: item.kind,
        route: item.route,
        subjectRef: item.subjectRef,
        promptVersion: item.promptVersion,
        system: item.system,
        messages: item.messages,
        maxTokens: item.maxTokens,
        ...(item.effortOverride ? { effortOverride: item.effortOverride } : {}),
        pool: item.pool,
        runId: item.runId,
        schema: consumer.schema(item),
        validate: (v) => consumer.validate?.(v, item) ?? [],
      });
      if (out.status === 'ok') return apply(out.value, { usage: out.usage, viaSync: true, fallbackUsed: out.usage.fallbackUsed });
      if (out.status === 'invalid') return fail('invalid', 'dead_letter', 'schema_invalid');
      if (out.status === 'max_tokens') return fail('max_tokens', 'dead_letter', 'max_tokens');
      return fail('refused', 'refused', out.status === 'unavailable' ? out.reason : null);
    }
    case 'requeue': {
      const notBefore = action.nextNight ? now() + msUntil(now(), AGENT_TIMES.extractSubmit, settingTimeZone(db)) : null;
      if (requeue(db, row, { maxTokens: action.maxTokens, notBefore, now: now() })) {
        ledger.markHandled(db, row.custom_id, row.status, now());
        stats.requeued++;
        return;
      }
      return fail('dead_letter', 'dead_letter', 'requeue_failed');
    }
    case 'split': {
      const parts = consumer.split?.(item) ?? [];
      if (!parts.length) return fail('max_tokens', 'dead_letter', 'max_tokens');
      splits.push(...parts);
      ledger.markHandled(db, row.custom_id, 'max_tokens', now(), 'split');
      stats.split++;
      return;
    }
    case 'dead_letter': {
      if (action.alert) ledger.openLlmAlert(db, DEAD_LETTER_ALERT, now());
      return fail('dead_letter', 'dead_letter', r.type === 'errored' ? r.errorType : r.type);
    }
  }
}

async function submitItems(o: CollectOptions, purpose: string, runId: string, items: LlmBatchItem[], stats: CollectStats, log: Logger): Promise<void> {
  for (let i = 0; i < items.length; i += 5000) {
    const chunk = items.slice(i, i + 5000);
    const res = await o.llm.submitBatch(chunk, { purpose, runId });
    if (res.status === 'submitted') stats.submitted += res.count;
    else log.warn('llm_requeue_submit_skipped', { counts: { items: chunk.length }, error_class: res.reason });
  }
}

/** Pending re-queues whose time has come, per purpose and pool (only purposes with a consumer). */
async function submitDueRequeues(o: CollectOptions, stats: CollectStats, now: () => number, log: Logger): Promise<void> {
  const rows = o.db
    .prepare(
      `SELECT * FROM llm_requests WHERE status = 'pending' AND mode = 'batch' AND batch_id IS NULL AND params IS NOT NULL
         AND (not_before IS NULL OR not_before <= ?) ORDER BY created_at LIMIT 20000`,
    )
    .all(now()) as ledger.RequestRow[];
  const groups = new Map<string, { purpose: string; runId: string; items: LlmBatchItem[] }>();
  for (const row of rows) {
    const consumer = row.purpose ? consumers.get(row.purpose) : undefined;
    const item = consumer ? storedItem(row) : null;
    if (!consumer || !item) continue;
    const key = `${row.purpose}|${row.pool}`;
    const g = groups.get(key) ?? { purpose: row.purpose!, runId: row.run_id ?? 'requeue', items: [] };
    g.items.push({
      customId: item.customId,
      kind: item.kind,
      route: item.route,
      subjectRef: item.subjectRef,
      promptVersion: item.promptVersion,
      system: item.system,
      messages: item.messages,
      ...(item.effortOverride ? { effortOverride: item.effortOverride } : {}),
      maxTokens: item.maxTokens,
      pool: item.pool,
      estimateUsd: item.estimateUsd ?? undefined,
      runId: item.runId,
      schema: consumer.schema(item),
    });
    groups.set(key, g);
  }
  for (const g of groups.values()) await submitItems(o, g.purpose, g.runId, g.items, stats, log);
}
