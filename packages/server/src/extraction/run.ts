/**
 * Batch orchestration (intelligence §4.6–4.7): the nightly steady submit, the every-5-minute collect, overflow
 * waves, retries/splits/refusal re-runs, and the one-time historical backfill with its consolidation pass.
 *
 *   submitSteady   tonight's windows (wave 1: retries + new windows) → one Message Batch per ≤5,000 items,
 *                  pool 'steady'. Without a key or budget nothing is built and nothing changes (graceful no-op).
 *   collect        polls this module's in-flight batches; streams results (any order, keyed by custom_id) →
 *                  validate → apply. Then: overflow waves 2–4 for conversations that still have NEW messages
 *                  (until 06:30 local), requeues (max_tokens ×2, one schema retry, errored/canceled before
 *                  06:00), splits, backfill progress, held-mention expiry, packet purge.
 *   stop_reason    end_turn → parse/validate/apply; max_tokens → requeue once at ×2, then split at the largest
 *                  gap; refusal → window 'refused' (its messages stay covered: the watermark advances; deterministic
 *                  signals still apply). Haiku 5.5 has no server-side fallback, so a refusal is final; only a route
 *                  overridden to a model with sync fallbacks re-runs it once synchronously (llm.parse).
 *   result types   errored/invalid_request → dead-letter + alert; errored/other, canceled → retry now before 06:00
 *                  else next night; expired → next night; attempts > 3 → dead-letter.
 *   backfill       startBackfill: conversation-month windows over everything before each conversation's steady
 *                  start, submitted in one or two batches from the separate 'backfill' pool (as much as its
 *                  allowance covers; the rest waits); when all are done: chronological reconcile, then one
 *                  consolidation request per person with ≥8 facts. planBackfill (yb backfill-extract --estimate) prices
 *                  it beforehand without sending anything.
 *   cost           routes extract_steady / extract_historical / extract_consolidate (llm/models.ts: Haiku 5.5,
 *                  effort low, thinking off, 1 h cache on the shared system prompt; batches 50% off). Every request
 *                  stays under PROMPT_TOKEN_LIMIT: a window whose prompt would not is split before it is sent. At most
 *                  STEADY_MAX_WINDOWS_PER_RUN new steady windows a run (the rest stay uncovered for the next wave).
 *   egress         fail closed PER REQUEST: a window whose packet the egress scanner refuses (at render, or its user
 *                  turn right before submit) is never sent: its window is dead-lettered with its messages still
 *                  covered (so it isn't rebuilt and refused again every run), it is recorded as a skipped item
 *                  (outcome egress_blocked), counted, and one 'extraction:egress_blocked' alert is opened. The rest of
 *                  the run goes on; the same holds for a consolidation request.
 * Nothing here sends anything except through LlmClient (whose egress choke point scans every user turn).
 */
import { localParts, uuidv7 } from '@yb/shared';
import type { DB } from '../db/connection';
import { tx } from '../db/tx';
import { finishRun, startRun } from '../journal/runs';
import { scanText } from '../llm/egress';
import { getRequest } from '../llm/ledger';
import { estimatePromptTokens, estimateRouteUsd, PROMPT_TOKEN_LIMIT, refusalRerunnable, resolveRoute, type LlmRoute, type RouteParams } from '../llm/models';
import {
  customId,
  EgressBlocked,
  type BudgetPool,
  type Egress,
  type LlmBatchItem,
  type LlmBatchResult,
  type LlmClient,
  type LlmKind,
  type LlmUnavailableReason,
} from '../llm/types';
import { readSetting } from '../settings/registry';
import { errorFields, nullLogger, type Logger } from '../ops/logger';
import { applyWindow, expirePendingMentions, reconcileChronology, type ApplyStats } from './apply';
import { applyConsolidation, buildConsolidation, consolidationCandidates, estimateConsolidationUsd, type ConsolidationRequest } from './consolidate';
import { buildEnv, DAY_MS, yieldToLoop, type Env } from './env';
import { loadPacket, NameIndex, renderWindow, storePacket, type Packet, type RenderedWindow } from './packet';
import {
  CONSOLIDATION_MAX_TOKENS,
  CONSOLIDATION_PROMPT_VERSION,
  CONSOLIDATION_SYSTEM,
  EXTRACTION_PROMPT_VERSION,
  EXTRACTION_SYSTEM,
  HISTORICAL_MAX_TOKENS,
  MAX_TOKENS_CEILING,
  STEADY_MAX_TOKENS,
  SYSTEM_TOKENS,
} from './prompt';
import { Consolidation, Extraction } from './schema';
import { validateExtraction } from './validate';
import {
  backfillThroughAt,
  carryOver,
  conversationsWithUncovered,
  createWindow,
  eligibility,
  getConversation,
  getWindow,
  MAX_WAVES,
  planWindows,
  setWindowStatus,
  splitAtLargestGap,
  steadySince,
  STEADY_INITIAL_LOOKBACK_MS,
  STEADY_MAX_LOOKBACK_MS,
  triage,
  uncoveredMessages,
  windowMessages,
  type MsgRow,
  type WindowMode,
} from './windows';

export const BATCH_MAX_ITEMS = 5000;
export const MAX_ATTEMPTS = 3;
export const WAVE_CUTOFF = '06:30';
export const RETRY_NOW_BEFORE = '06:00';
export const PACKET_RETENTION_MS = 30 * DAY_MS;
/** New steady windows built per run (wave); conversations beyond it keep their messages uncovered for the next. */
export const STEADY_MAX_WINDOWS_PER_RUN = 600;
/** The prompt budget a window may use: the limit minus the system prompt, schema and headroom. */
export const WINDOW_PROMPT_BUDGET = PROMPT_TOKEN_LIMIT - SYSTEM_TOKENS - 2_000;

export interface ExtractionDeps {
  db: DB;
  llm: LlmClient;
  egress: Egress;
  now: () => number;
  log?: Logger;
  signal?: AbortSignal;
  jobRunId?: number | null;
}

type ItemKind = 'extract' | 'historical' | 'consolidate';

interface ItemRow {
  custom_id: string;
  batch_id: string | null;
  kind: ItemKind;
  window_id: string | null;
  person_id: string | null;
  backfill_id: string | null;
  attempt: number;
  max_tokens: number;
  prompt_version: string;
  status: string;
  outcome: string | null;
  payload: string | null;
}

/** One request to (re)submit. */
interface Spec {
  kind: ItemKind;
  windowId: string | null;
  personId: string | null;
  backfillId: string | null;
  attempt: number;
  maxTokens: number;
  userText: string;
  tokens: number;
  payload: unknown;
}

export interface Counts {
  [k: string]: number;
}

const bump = (c: Counts, k: string, n = 1) => void (c[k] = (c[k] ?? 0) + n);
const kindOfMode = (m: WindowMode): ItemKind => (m === 'historical' ? 'historical' : 'extract');
const poolOf = (k: ItemKind, backfillId: string | null): BudgetPool => (k === 'historical' || (k === 'consolidate' && backfillId) ? 'backfill' : 'steady');
const baseMaxTokens = (k: ItemKind) => (k === 'historical' ? HISTORICAL_MAX_TOKENS : k === 'consolidate' ? CONSOLIDATION_MAX_TOKENS : STEADY_MAX_TOKENS);
/** The LLM route of an item kind. */
export const routeOf = (k: ItemKind): LlmRoute => (k === 'historical' ? 'extract_historical' : k === 'consolidate' ? 'extract_consolidate' : 'extract_steady');

/**
 * Batch estimate for one extraction request on `params` (default: the steady route's defaults): the user turn
 * uncached (`tokens` from the 4-chars packing count, rescaled to the conservative 3 chars/token), the shared system
 * prompt read from the cache, the route's expected output.
 */
export function estimateWindowUsd(tokens: number, params: RouteParams = resolveRoute('extract_steady')): number {
  return estimateRouteUsd(params, { userTokens: Math.ceil((tokens * 4) / 3), systemTokens: SYSTEM_TOKENS, mode: 'batch' });
}

/**
 * Whether a refused batch item gets one synchronous re-run with server-side fallbacks (never on Haiku 5.5): the
 * model it went out on and the route's current model support them, and the decline category is one they retry.
 */
function refusalRerun(deps: ExtractionDeps, customIdValue: string, route: LlmRoute, category: string | null): boolean {
  const routeModel = deps.llm.params(route).model;
  return refusalRerunnable(getRequest(deps.db, customIdValue)?.model ?? routeModel, routeModel, category);
}

function hhmm(now: number, tz: string): string {
  return localParts(now, tz).hhmm;
}

function night(now: number, tz: string): string {
  return localParts(now, tz).date;
}

// ---------------------------------------------------------------------------------------------- items & batches

function specToItem(s: Spec, runId: string, params: RouteParams): LlmBatchItem {
  const isConsolidate = s.kind === 'consolidate';
  const promptVersion = isConsolidate ? CONSOLIDATION_PROMPT_VERSION : EXTRACTION_PROMPT_VERSION;
  const subject = (s.windowId ?? s.personId)!;
  return {
    kind: s.kind as LlmKind,
    route: routeOf(s.kind),
    subjectRef: subject,
    promptVersion,
    system: isConsolidate ? CONSOLIDATION_SYSTEM : EXTRACTION_SYSTEM,
    messages: [{ role: 'user', content: s.userText }],
    maxTokens: s.maxTokens,
    pool: poolOf(s.kind, s.backfillId),
    estimateUsd: isConsolidate ? estimateConsolidationUsd(s.tokens, 'batch', params) : estimateWindowUsd(s.tokens, params),
    runId,
    customId: customId(s.kind as LlmKind, promptVersion, subject, s.attempt),
    schema: isConsolidate ? Consolidation : Extraction,
  };
}

/**
 * Submits specs (one kind) in chunks of ≤5,000. Records batches/items; windows → submitted. Each user turn is
 * scanned first: the client refuses a whole batch for one raw identifier, so a blocked spec is left out here
 * (recordBlocked) and the rest go out.
 */
async function submitSpecs(
  deps: ExtractionDeps,
  all: Spec[],
  o: { kind: ItemKind; wave: number; runId: string; tz: string },
): Promise<{ submitted: number; batches: number; blocked: number; unavailable: LlmUnavailableReason | null; failed: Spec[] }> {
  const db = deps.db;
  let submitted = 0;
  let batches = 0;
  const failed: Spec[] = [];
  let unavailable: LlmUnavailableReason | null = null;
  const specs: Spec[] = [];
  for (const [i, s] of all.entries()) {
    try {
      scanText(s.userText);
      deps.egress.scan(s.userText);
      specs.push(s);
    } catch (e) {
      if (!(e instanceof EgressBlocked)) throw e;
      recordBlocked(db, s, deps.now());
    }
    if (i % 50 === 49) await yieldToLoop();
  }
  const blocked = all.length - specs.length;
  for (let i = 0; i < specs.length; i += BATCH_MAX_ITEMS) {
    let chunk = specs.slice(i, i + BATCH_MAX_ITEMS);
    if (unavailable) {
      failed.push(...chunk);
      continue;
    }
    const params = deps.llm.params(routeOf(o.kind));
    let items = chunk.map((s) => specToItem(s, o.runId, params));
    // Send as much as the remaining budget allows (largest prefix that fits, by halving); the rest waits.
    const pool = items[0]!.pool ?? 'steady';
    const prefixUsd = (k: number) => items.slice(0, k).reduce((n, it) => n + (it.estimateUsd ?? 0), 0);
    let take = items.length;
    let spend = deps.llm.canSpend(pool, prefixUsd(take));
    while (!spend.ok && take > 1 && spend.reason.startsWith('budget_')) {
      take = Math.floor(take / 2);
      spend = deps.llm.canSpend(pool, prefixUsd(take));
    }
    if (spend.ok && take < chunk.length) {
      failed.push(...chunk.slice(take));
      unavailable = deps.llm.canSpend(pool, prefixUsd(chunk.length)).ok ? null : pool === 'backfill' ? 'budget_backfill' : 'budget_daily';
      chunk = chunk.slice(0, take);
      items = items.slice(0, take);
    }
    const res = spend.ok ? await deps.llm.submitBatch(items, { purpose: o.kind, runId: o.runId }) : ({ status: 'unavailable', reason: spend.reason } as const);
    if (res.status !== 'submitted') {
      unavailable = res.reason;
      failed.push(...chunk);
      continue;
    }
    const now = deps.now();
    tx(db, () => {
      db.prepare(
        `INSERT INTO extraction_batches (batch_id, kind, wave, night, run_id, status, item_count, submitted_at) VALUES (?, ?, ?, ?, ?, 'submitted', ?, ?)`,
      ).run(res.batchId, o.kind, o.wave, night(now, o.tz), o.runId, chunk.length, now);
      const ins = db.prepare(
        `INSERT INTO extraction_items (custom_id, batch_id, kind, window_id, person_id, backfill_id, attempt, max_tokens, prompt_version, status, payload, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted', ?, ?, ?)
         ON CONFLICT (custom_id) DO UPDATE SET batch_id = excluded.batch_id, status = 'submitted', max_tokens = excluded.max_tokens,
           payload = excluded.payload, outcome = NULL, updated_at = excluded.updated_at`,
      );
      const win = db.prepare(`UPDATE windows SET status = 'submitted', attempts = attempts + 1, last_custom_id = ?, prompt_version = ?, updated_at = ? WHERE id = ?`);
      chunk.forEach((s, j) => {
        const it = items[j]!;
        ins.run(it.customId, res.batchId, s.kind, s.windowId, s.personId, s.backfillId, s.attempt, s.maxTokens, it.promptVersion, s.payload === undefined ? null : JSON.stringify(s.payload), now, now);
        if (s.windowId) win.run(it.customId, it.promptVersion, now, s.windowId);
      });
    });
    submitted += chunk.length;
    batches++;
  }
  return { submitted, batches, blocked, unavailable, failed };
}

function setItem(db: DB, customIdValue: string, status: string, outcome: string | null, now: number): void {
  db.prepare('UPDATE extraction_items SET status = ?, outcome = coalesce(?, outcome), updated_at = ? WHERE custom_id = ?').run(status, outcome, now, customIdValue);
}

/** Bookkeeping on the LLM ledger row (written by the client; absent with fakes). */
function markLedger(db: DB, customIdValue: string, status: 'applied' | 'rejected' | 'dead_letter', now: number): void {
  db.prepare(`UPDATE llm_requests SET status = ?, applied_at = CASE WHEN ? IN ('applied','rejected') THEN ? ELSE applied_at END WHERE custom_id = ?`).run(
    status,
    status,
    now,
    customIdValue,
  );
}

function raiseAlert(db: DB, source: string, message: string, now: number): void {
  db.prepare(`INSERT OR IGNORE INTO alerts (id, source, severity, message, opened_at) VALUES (?, ?, 'warning', ?, ?)`).run(uuidv7(now), source, message, now);
}

/**
 * A request the egress scanner refused before anything was sent: a skipped item (outcome egress_blocked) at the
 * attempt it would have gone out as, its window dead-lettered (messages stay covered: it isn't rebuilt and refused
 * again every run), one open alert.
 */
function recordBlocked(db: DB, s: Pick<Spec, 'kind' | 'windowId' | 'personId' | 'backfillId' | 'attempt' | 'maxTokens'>, now: number): void {
  const promptVersion = s.kind === 'consolidate' ? CONSOLIDATION_PROMPT_VERSION : EXTRACTION_PROMPT_VERSION;
  tx(db, () => {
    db.prepare(
      `INSERT INTO extraction_items (custom_id, batch_id, kind, window_id, person_id, backfill_id, attempt, max_tokens, prompt_version, status, outcome, created_at, updated_at)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, 'skipped', 'egress_blocked', ?, ?)
       ON CONFLICT (custom_id) DO UPDATE SET status = 'skipped', outcome = 'egress_blocked', updated_at = excluded.updated_at`,
    ).run(customId(s.kind as LlmKind, promptVersion, (s.windowId ?? s.personId)!, s.attempt), s.kind, s.windowId, s.personId, s.backfillId, s.attempt, s.maxTokens, promptVersion, now, now);
    if (s.windowId) setWindowStatus(db, s.windowId, 'dead_letter', now);
  });
  raiseAlert(
    db,
    'extraction:egress_blocked',
    'Some conversations were skipped by the privacy filter (a phone number, email or handle it could not pseudonymize); nothing from them was sent.',
    now,
  );
}

// ---------------------------------------------------------------------------------------------- building windows

interface BuildResult {
  specs: Spec[];
  created: string[];
  counts: Counts;
}

/** Why a window has nothing to send: no usable lines, or the egress scanner refused its packet. */
type NoSpec = 'empty' | 'egress_blocked';

/** Renders + stores a pending window's packet; returns its spec, or why there is none (settleNoSpec). */
function renderSpec(env: Env, egress: Egress, names: NameIndex, windowId: string, mode: WindowMode, attempt = 0, backfillId: string | null = null): Spec | NoSpec {
  const w = getWindow(env.db, windowId);
  const conv = w ? getConversation(env.db, w.conversation_id) : null;
  if (!w || !conv) return 'empty';
  const elig = eligibility(env, conv);
  if (!elig.ok) return 'empty';
  const msgs = windowMessages(env.db, windowId);
  if (!msgs.length) return 'empty';
  let r: RenderedWindow;
  try {
    r = renderWindow({ env, egress, names, windowId, conv, elig, mode, messages: msgs });
  } catch (e) {
    // pseudonymize() re-scans its own output and throws: this window only (nothing of it was sent).
    if (e instanceof EgressBlocked) return 'egress_blocked';
    throw e;
  }
  if (!r.newLines) return 'empty';
  storePacket(env.db, r, env.now);
  const kind = kindOfMode(mode);
  return { kind, windowId, personId: null, backfillId, attempt, maxTokens: baseMaxTokens(kind), userText: r.userText, tokens: r.tokens, payload: undefined };
}

/** A window without a spec: 'empty' → triaged out; 'egress_blocked' → recordBlocked (counted as egress_blocked). */
function settleNoSpec(env: Env, w: { windowId: string; mode: WindowMode; attempt: number; backfillId: string | null }, why: NoSpec, counts?: Counts): void {
  if (why === 'empty') return setWindowStatus(env.db, w.windowId, 'triaged_out', env.now);
  const kind = kindOfMode(w.mode);
  recordBlocked(env.db, { kind, windowId: w.windowId, personId: null, backfillId: w.backfillId, attempt: w.attempt, maxTokens: baseMaxTokens(kind) }, env.now);
  if (counts) bump(counts, 'egress_blocked');
}

/** Replaces a window by child windows over `halves` (coverage moves to the children); returns their ids. */
function splitInto(db: DB, w: { id: string; conversation_id: string; mode: WindowMode; wave: number }, halves: MsgRow[][], now: number): string[] {
  return tx(db, () => {
    db.prepare('DELETE FROM extraction_coverage WHERE window_id = ?').run(w.id);
    setWindowStatus(db, w.id, 'split', now);
    return halves.map((msgs) => createWindow(db, { conversationId: w.conversation_id, mode: w.mode, messages: msgs, wave: w.wave, status: 'pending', tokens: 0, now }));
  });
}

/**
 * The prompt-size guard: a rendered window whose prompt would pass PROMPT_TOKEN_LIMIT (conservative 3 chars/token,
 * with the system prompt) is split at its largest gap and the halves rendered again, recursively. Never sent whole.
 */
function fitSpec(env: Env, egress: Egress, names: NameIndex, spec: Spec, o: { depth?: number; budget?: number; counts?: Counts } = {}): Spec[] {
  const depth = o.depth ?? 0;
  if (!spec.windowId || estimatePromptTokens(spec.userText) <= (o.budget ?? WINDOW_PROMPT_BUDGET)) return [spec];
  const w = getWindow(env.db, spec.windowId);
  const halves = w && depth < 8 ? splitAtLargestGap(windowMessages(env.db, w.id)) : null;
  if (!w || !halves) {
    setWindowStatus(env.db, spec.windowId, 'dead_letter', env.now);
    return [];
  }
  return splitInto(env.db, w, halves, env.now).flatMap((id) => {
    const child = renderSpec(env, egress, names, id, w.mode, 0, spec.backfillId);
    if (typeof child === 'string') {
      settleNoSpec(env, { windowId: id, mode: w.mode, attempt: 0, backfillId: spec.backfillId }, child, o.counts);
      return [];
    }
    return fitSpec(env, egress, names, child, { ...o, depth: depth + 1 });
  });
}

/**
 * Renders a window and applies the prompt-size guard (exported for tests, which pass a small `budget`): the specs
 * that would be sent, each within the budget.
 */
export function renderWindowSpecs(env: Env, egress: Egress, windowId: string, mode: WindowMode, budget = WINDOW_PROMPT_BUDGET): { windowId: string; tokens: number }[] {
  const names = new NameIndex(env);
  const spec = renderSpec(env, egress, names, windowId, mode);
  return typeof spec === 'string' ? [] : fitSpec(env, egress, names, spec, { budget }).map((x) => ({ windowId: x.windowId!, tokens: estimatePromptTokens(x.userText) }));
}

/** Creates (and renders) windows for one conversation. Steady: the first kept window only (a wave). */
function buildConversation(
  env: Env,
  egress: Egress,
  names: NameIndex,
  conversationId: string,
  o: { mode: WindowMode; wave: number; from: number; before: number; backfillId: string | null },
  out: BuildResult,
): void {
  const conv = getConversation(env.db, conversationId);
  if (!conv) return;
  const elig = eligibility(env, conv);
  if (!elig.ok) {
    bump(out.counts, `skipped_${elig.reason}`);
    return;
  }
  const msgs = uncoveredMessages(env.db, conversationId, { from: o.from, before: o.before });
  if (!msgs.length) return;
  const planned = planWindows(msgs, { mode: o.mode, chat: elig.chat, tz: env.tz });
  for (const p of planned) {
    const verdict = triage(env, p.messages, { chat: elig.chat, memberCount: elig.memberCount });
    if (!verdict.keep) {
      createWindow(env.db, { conversationId, mode: o.mode, messages: p.messages, wave: o.wave, status: 'triaged_out', tokens: p.tokens, now: env.now });
      bump(out.counts, `triaged_${verdict.reason}`);
      continue;
    }
    const id = createWindow(env.db, { conversationId, mode: o.mode, messages: p.messages, wave: o.wave, status: 'pending', tokens: p.tokens, now: env.now });
    const spec = renderSpec(env, egress, names, id, o.mode, 0, o.backfillId);
    if (typeof spec === 'string') {
      settleNoSpec(env, { windowId: id, mode: o.mode, attempt: 0, backfillId: o.backfillId }, spec, out.counts);
      if (spec === 'empty') bump(out.counts, 'triaged_no_usable_lines');
      continue;
    }
    const fitted = fitSpec(env, egress, names, spec, { counts: out.counts });
    if (fitted.length !== 1 || fitted[0] !== spec) bump(out.counts, 'split_prompt_size');
    for (const f of fitted) {
      out.created.push(f.windowId!);
      out.specs.push(f);
      bump(out.counts, 'windows');
    }
    if (o.mode === 'steady') break; // overflow waits for the next wave
  }
}

/**
 * Pending windows of a mode (retries, split children, backfill windows not sent yet) → specs at their next
 * attempt. Steady retries are re-rendered (cards and the rolling summary may have moved on); historical windows
 * are independent, so their stored user turn is reused. Yields between chunks.
 */
async function pendingSpecs(env: Env, egress: Egress, names: NameIndex, mode: WindowMode, backfillId: string | null, counts: Counts, signal?: AbortSignal): Promise<Spec[]> {
  const rows = env.db.prepare(`SELECT id FROM windows WHERE mode = ? AND status = 'pending' ORDER BY created_at`).pluck().all(mode) as string[];
  const lastItem = env.db.prepare('SELECT attempt, max_tokens FROM extraction_items WHERE window_id = ? ORDER BY attempt DESC LIMIT 1');
  const out: Spec[] = [];
  let i = 0;
  for (const id of rows) {
    if (signal?.aborted) break;
    if (++i % 25 === 0) await yieldToLoop();
    const last = lastItem.get(id) as { attempt: number; max_tokens: number } | undefined;
    const attempt = last ? last.attempt + 1 : 0;
    if (attempt > MAX_ATTEMPTS) {
      setWindowStatus(env.db, id, 'dead_letter', env.now);
      continue;
    }
    const kind = kindOfMode(mode);
    const stored = mode === 'historical' ? loadPacket(env.db, id) : null;
    const spec: Spec | NoSpec = stored?.userText
      ? { kind, windowId: id, personId: null, backfillId, attempt, maxTokens: baseMaxTokens(kind), userText: stored.userText, tokens: stored.tokens, payload: undefined }
      : renderSpec(env, egress, names, id, mode, attempt, backfillId);
    if (typeof spec === 'string') {
      settleNoSpec(env, { windowId: id, mode, attempt, backfillId }, spec, counts);
      continue;
    }
    if (last && last.max_tokens > spec.maxTokens) spec.maxTokens = last.max_tokens;
    out.push(...fitSpec(env, egress, names, spec, { counts }));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- steady submit

export interface SubmitReport {
  status: 'ok' | 'skipped' | 'partial';
  reason?: LlmUnavailableReason | 'nothing_to_do';
  counts: Counts;
}

/**
 * Builds and submits steady windows. Wave 1 (nightly) also resubmits pending retries. Waves > 1 take only
 * `conversations` (the ones a collected wave touched) and messages sent before `newBefore`.
 */
export async function submitSteady(deps: ExtractionDeps, o: { wave?: number; conversations?: readonly string[]; newBefore?: number; runId?: string } = {}): Promise<SubmitReport> {
  const wave = o.wave ?? 1;
  const counts: Counts = {};
  const check = deps.llm.canSpend('steady');
  if (!check.ok) return { status: 'skipped', reason: check.reason, counts };
  const now = deps.now();
  const env = buildEnv(deps.db, now);
  const names = new NameIndex(env);
  const runId = o.runId ?? startRun(deps.db, 'nightly', { jobRunId: deps.jobRunId ?? null, now });
  const out: BuildResult = { specs: [], created: [], counts };
  try {
    if (wave === 1) out.specs.push(...(await pendingSpecs(env, deps.egress, names, 'steady', null, counts, deps.signal)));
    const before = o.newBefore ?? now;
    const through = backfillThroughAt(deps.db);
    const convs = o.conversations ?? conversationsWithUncovered(deps.db, now - STEADY_MAX_LOOKBACK_MS, before);
    // One in-flight steady window per conversation (checked per conversation: a concurrent wave may add one).
    const inflight = deps.db.prepare(`SELECT 1 FROM windows WHERE conversation_id = ? AND mode = 'steady' AND status IN ('pending','submitted') LIMIT 1`).pluck();
    let i = 0;
    for (const conversationId of convs) {
      if (deps.signal?.aborted) break;
      if (out.specs.length >= STEADY_MAX_WINDOWS_PER_RUN) {
        bump(counts, 'capped_conversations');
        continue;
      }
      if (inflight.get(conversationId) !== undefined) continue;
      const from = steadySince(env, conversationId, { backfillThroughAt: through });
      buildConversation(env, deps.egress, names, conversationId, { mode: 'steady', wave, from, before, backfillId: null }, out);
      if (++i % 20 === 0) await yieldToLoop();
    }
    if (!out.specs.length) {
      if (!o.runId) finishRun(deps.db, runId, 'ok', { now: deps.now(), summary: counts });
      return { status: 'ok', reason: 'nothing_to_do', counts };
    }
    const res = await submitSpecs(deps, out.specs, { kind: 'extract', wave, runId, tz: env.tz });
    bump(counts, 'submitted', res.submitted);
    bump(counts, 'batches', res.batches);
    if (res.blocked) bump(counts, 'egress_blocked', res.blocked);
    // Not submitted tonight: new windows give their messages back; retries stay pending for the next night.
    const createdSet = new Set(out.created);
    for (const s of res.failed) if (s.windowId && createdSet.has(s.windowId)) carryOver(deps.db, s.windowId, deps.now());
    if (res.failed.length) bump(counts, 'carried_over', res.failed.length);
    if (!o.runId) finishRun(deps.db, runId, res.unavailable ? 'partial' : 'ok', { now: deps.now(), summary: counts });
    (deps.log ?? nullLogger).info('extract.submit', { run_id: runId, counts });
    return { status: res.unavailable ? (res.submitted ? 'partial' : 'skipped') : 'ok', ...(res.unavailable ? { reason: res.unavailable } : {}), counts };
  } catch (e) {
    if (!o.runId) finishRun(deps.db, runId, 'error', { now: deps.now() });
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------- collect

interface CollectCtx {
  deps: ExtractionDeps;
  env: Env;
  names: NameIndex;
  runId: string;
  counts: Counts;
  requeue: Spec[];
  /** conversations whose steady window was applied in this collect, per batch wave */
  appliedConversations: Map<number, Set<string>>;
}

function parseJson(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function applyParsed(c: CollectCtx, item: ItemRow, packet: Packet, value: Extraction, customIdValue: string | null): ApplyStats {
  const v = validateExtraction(value, packet, { now: c.env.now });
  const stats = applyWindow({ env: c.env, egress: c.deps.egress, runId: c.runId, now: c.env.now, customId: customIdValue, promptVersion: item.prompt_version }, packet, v);
  for (const [k, n] of Object.entries(stats)) if (typeof n === 'number' && n) bump(c.counts, k, n);
  for (const [k, n] of Object.entries(v.dropped)) bump(c.counts, `dropped_${k}`, n);
  return stats;
}

/** Re-queues an item at attempt + 1 (or dead-letters past MAX_ATTEMPTS). */
function requeue(c: CollectCtx, item: ItemRow, userText: string | null, o: { maxTokens?: number; outcome: string }): void {
  const db = c.deps.db;
  const next = item.attempt + 1;
  if (next > MAX_ATTEMPTS || !userText) {
    deadLetter(c, item, o.outcome);
    return;
  }
  setItem(db, item.custom_id, 'requeued', o.outcome, c.env.now);
  c.requeue.push({
    kind: item.kind,
    windowId: item.window_id,
    personId: item.person_id,
    backfillId: item.backfill_id,
    attempt: next,
    maxTokens: o.maxTokens ?? item.max_tokens,
    userText,
    tokens: Math.ceil(userText.length / 4),
    payload: item.payload ? JSON.parse(item.payload) : undefined,
  });
  bump(c.counts, `requeued_${o.outcome}`);
}

/** Next night: the window goes back to pending (its next attempt is built by the nightly submit / backfill). */
function retryLater(c: CollectCtx, item: ItemRow, outcome: string): void {
  if (item.attempt + 1 > MAX_ATTEMPTS) return deadLetter(c, item, outcome);
  setItem(c.deps.db, item.custom_id, 'retry_later', outcome, c.env.now);
  if (item.window_id) setWindowStatus(c.deps.db, item.window_id, 'pending', c.env.now);
  bump(c.counts, `retry_later_${outcome}`);
}

function deadLetter(c: CollectCtx, item: ItemRow, outcome: string): void {
  setItem(c.deps.db, item.custom_id, 'dead_letter', outcome, c.env.now);
  markLedger(c.deps.db, item.custom_id, 'dead_letter', c.env.now);
  if (item.window_id) setWindowStatus(c.deps.db, item.window_id, 'dead_letter', c.env.now);
  bump(c.counts, `dead_letter_${outcome}`);
}

/** max_tokens twice → split the window at its largest internal gap into two pending children. */
function splitWindow(c: CollectCtx, item: ItemRow): void {
  const db = c.deps.db;
  const w = item.window_id ? getWindow(db, item.window_id) : null;
  if (!w) return deadLetter(c, item, 'max_tokens');
  const halves = splitAtLargestGap(windowMessages(db, w.id));
  if (!halves) return deadLetter(c, item, 'max_tokens');
  const mode = w.mode;
  const children = splitInto(db, w, halves, c.env.now);
  setItem(db, item.custom_id, 'requeued', 'split', c.env.now);
  for (const id of children) {
    const spec = renderSpec(c.env, c.deps.egress, c.names, id, mode, 0, item.backfill_id);
    if (typeof spec === 'string') settleNoSpec(c.env, { windowId: id, mode, attempt: 0, backfillId: item.backfill_id }, spec, c.counts);
    else c.requeue.push(...fitSpec(c.env, c.deps.egress, c.names, spec, { counts: c.counts }));
  }
  bump(c.counts, 'split');
}

async function handleWindowResult(c: CollectCtx, item: ItemRow, r: LlmBatchResult): Promise<void> {
  const db = c.deps.db;
  const stored = item.window_id ? loadPacket(db, item.window_id) : null;
  if (!stored) return deadLetter(c, item, 'no_packet');
  const { packet, userText } = stored;
  if (r.type === 'errored') {
    if (r.errorType === 'invalid_request') {
      deadLetter(c, item, 'invalid_request');
      raiseAlert(db, 'extraction:invalid_request', 'Some extraction requests were rejected as invalid (a prompt or schema bug); those windows were dead-lettered.', c.env.now);
      return;
    }
    return hhmm(c.env.now, c.env.tz) < RETRY_NOW_BEFORE ? requeue(c, item, userText, { outcome: 'errored' }) : retryLater(c, item, 'errored');
  }
  if (r.type === 'canceled') return hhmm(c.env.now, c.env.tz) < RETRY_NOW_BEFORE ? requeue(c, item, userText, { outcome: 'canceled' }) : retryLater(c, item, 'canceled');
  if (r.type === 'expired') return retryLater(c, item, 'expired');

  // succeeded: check stop_reason before reading anything
  if (r.stopReason === 'max_tokens') {
    const hadCutoff = db.prepare(`SELECT 1 FROM extraction_items WHERE window_id = ? AND outcome = 'max_tokens' AND custom_id <> ?`).pluck().get(item.window_id, item.custom_id);
    if (!hadCutoff && item.max_tokens < MAX_TOKENS_CEILING) return requeue(c, item, userText, { maxTokens: Math.min(item.max_tokens * 2, MAX_TOKENS_CEILING), outcome: 'max_tokens' });
    setItem(db, item.custom_id, 'requeued', 'max_tokens', c.env.now);
    return splitWindow(c, item);
  }
  if (r.stopReason === 'refusal') {
    bump(c.counts, 'batch_refusals');
    const route = routeOf(item.kind);
    // Haiku 5.5 has no server-side fallback: the refusal is final (no paid re-run of the same request, no escalation).
    if (!userText || !refusalRerun(c.deps, item.custom_id, route, r.refusalCategory)) return refuseWindow(c, item);
    // A route overridden to a model with sync fallbacks: re-run this one window synchronously (the client sends them).
    const out = await c.deps.llm.parse({
      kind: item.kind as LlmKind,
      route,
      subjectRef: item.window_id!,
      promptVersion: item.prompt_version,
      system: EXTRACTION_SYSTEM,
      messages: [{ role: 'user', content: userText }],
      maxTokens: item.max_tokens,
      pool: poolOf(item.kind, item.backfill_id),
      estimateUsd: estimateRouteUsd(c.deps.llm.params(route), { userTokens: estimatePromptTokens(userText), systemTokens: SYSTEM_TOKENS, mode: 'sync' }),
      schema: Extraction,
      runId: c.runId,
    });
    if (out.status === 'ok') {
      applyParsed(c, item, packet, out.value, item.custom_id);
      setItem(db, item.custom_id, 'applied', 'refusal_rerun', c.env.now);
      bump(c.counts, 'refusal_rerun_ok');
      return;
    }
    if (out.status === 'refused') return refuseWindow(c, item);
    if (out.status === 'max_tokens') return requeue(c, item, userText, { maxTokens: Math.min(item.max_tokens * 2, MAX_TOKENS_CEILING), outcome: 'max_tokens' });
    if (out.status === 'invalid') return schemaFailure(c, item, userText);
    return retryLater(c, item, 'refusal_unavailable');
  }

  const parsed = Extraction.safeParse(parseJson(r.text));
  if (!parsed.success) return schemaFailure(c, item, userText);
  try {
    applyParsed(c, item, packet, parsed.data, item.custom_id);
  } catch (e) {
    (c.deps.log ?? nullLogger).error('extract.apply_failed', { ids: [item.window_id!], ...errorFields(e) });
    return deadLetter(c, item, 'apply_failed');
  }
  setItem(db, item.custom_id, 'applied', 'ok', c.env.now);
  markLedger(db, item.custom_id, 'applied', c.env.now);
  bump(c.counts, 'applied');
  if (packet.mode === 'steady') {
    const w = getWindow(db, item.window_id!);
    let set = c.appliedConversations.get(w?.wave ?? 1);
    if (!set) c.appliedConversations.set(w?.wave ?? 1, (set = new Set()));
    set.add(packet.conversationId);
  }
}

/** A refused window is done (its messages stay covered); deterministic signals still apply. */
function refuseWindow(c: CollectCtx, item: ItemRow): void {
  const db = c.deps.db;
  setItem(db, item.custom_id, 'refused', 'refusal', c.env.now);
  markLedger(db, item.custom_id, 'rejected', c.env.now);
  if (item.window_id) setWindowStatus(db, item.window_id, 'refused', c.env.now);
  bump(c.counts, 'refused');
}

/** Schema-invalid output: retry once, then dead-letter. */
function schemaFailure(c: CollectCtx, item: ItemRow, userText: string | null): void {
  const prior = c.deps.db
    .prepare(`SELECT count(*) FROM extraction_items WHERE ${item.window_id ? 'window_id' : 'person_id'} = ? AND outcome = 'schema_invalid' AND custom_id <> ?`)
    .pluck()
    .get(item.window_id ?? item.person_id, item.custom_id) as number;
  if (prior >= 1) return deadLetter(c, item, 'schema_invalid');
  requeue(c, item, userText, { outcome: 'schema_invalid' });
}

async function handleConsolidationResult(c: CollectCtx, item: ItemRow, r: LlmBatchResult): Promise<void> {
  const db = c.deps.db;
  const payload = item.payload ? (JSON.parse(item.payload) as ConsolidationRequest) : null;
  if (!payload) return deadLetter(c, item, 'no_payload');
  if (r.type === 'errored' && r.errorType === 'invalid_request') return deadLetter(c, item, 'invalid_request');
  if (r.type === 'errored' || r.type === 'canceled' || r.type === 'expired') return requeue(c, item, payload.userText, { outcome: r.type });
  if (r.stopReason === 'max_tokens') {
    if (item.max_tokens < MAX_TOKENS_CEILING) return requeue(c, item, payload.userText, { maxTokens: Math.min(item.max_tokens * 2, MAX_TOKENS_CEILING), outcome: 'max_tokens' });
    return deadLetter(c, item, 'max_tokens');
  }
  let value: Consolidation | null = null;
  if (r.stopReason === 'refusal') {
    if (!refusalRerun(c.deps, item.custom_id, 'extract_consolidate', r.refusalCategory)) {
      // Final on Haiku 5.5 (no server-side fallback): recorded and skipped; the person keeps their facts as they are.
      setItem(db, item.custom_id, 'refused', 'refusal', c.env.now);
      markLedger(db, item.custom_id, 'rejected', c.env.now);
      bump(c.counts, 'consolidation_refused');
      return;
    }
    const out = await c.deps.llm.parse<Consolidation>({
      kind: 'consolidate',
      route: 'extract_consolidate',
      subjectRef: item.person_id!,
      promptVersion: item.prompt_version,
      system: CONSOLIDATION_SYSTEM,
      messages: [{ role: 'user', content: payload.userText }],
      maxTokens: item.max_tokens,
      pool: poolOf('consolidate', item.backfill_id),
      estimateUsd: estimateConsolidationUsd(payload.tokens, 'sync', c.deps.llm.params('extract_consolidate')),
      schema: Consolidation,
      runId: c.runId,
    });
    if (out.status !== 'ok') {
      setItem(db, item.custom_id, out.status === 'refused' ? 'refused' : 'skipped', `refusal_${out.status}`, c.env.now);
      bump(c.counts, 'consolidation_refused');
      return;
    }
    value = out.value;
  } else {
    const parsed = Consolidation.safeParse(parseJson(r.text));
    if (!parsed.success) return schemaFailure(c, item, payload.userText);
    value = parsed.data;
  }
  const stats = applyConsolidation({ env: c.env, egress: c.deps.egress, runId: c.runId, now: c.env.now, promptVersion: item.prompt_version }, payload, value);
  setItem(db, item.custom_id, 'applied', 'ok', c.env.now);
  markLedger(db, item.custom_id, 'applied', c.env.now);
  bump(c.counts, 'consolidated');
  for (const [k, n] of Object.entries(stats)) if (typeof n === 'number' && n) bump(c.counts, `consolidation_${k}`, n);
}

export interface CollectReport {
  status: 'ok' | 'skipped' | 'partial';
  counts: Counts;
}

/** Polls in-flight batches, applies their results, then submits waves / requeues and advances the backfill. */
export async function collect(deps: ExtractionDeps): Promise<CollectReport> {
  const db = deps.db;
  const counts: Counts = {};
  const open = db.prepare(`SELECT * FROM extraction_batches WHERE status = 'submitted' ORDER BY submitted_at`).all() as {
    batch_id: string;
    kind: ItemKind;
    wave: number;
    submitted_at: number;
    run_id: string | null;
  }[];
  const active = activeBackfill(db);
  const housekeeping = () => {
    const now = deps.now();
    bump(counts, 'pending_expired', expirePendingMentions(db, now));
    bump(counts, 'packets_purged', purgePackets(db, now));
  };
  if (!open.length && !active) {
    housekeeping();
    return { status: 'skipped', counts };
  }
  const now = deps.now();
  const env = buildEnv(db, now);
  const runId = startRun(db, 'nightly', { jobRunId: deps.jobRunId ?? null, now });
  const c: CollectCtx = { deps, env, names: new NameIndex(env), runId, counts, requeue: [], appliedConversations: new Map() };
  let partial = false;
  try {
    const waveFollowups: { wave: number; newBefore: number }[] = [];
    for (const b of open) {
      if (deps.signal?.aborted) {
        partial = true;
        break;
      }
      const st = await deps.llm.batchStatus(b.batch_id);
      if (st.processing !== 'ended') {
        bump(counts, 'batches_in_progress');
        continue;
      }
      let n = 0;
      for await (const r of deps.llm.batchResults(b.batch_id)) {
        const item = db.prepare('SELECT * FROM extraction_items WHERE custom_id = ?').get(r.customId) as ItemRow | undefined;
        if (!item || item.status !== 'submitted') {
          bump(counts, 'results_ignored');
          continue;
        }
        if (item.kind === 'consolidate') await handleConsolidationResult(c, item, r);
        else await handleWindowResult(c, item, r);
        if (++n % 20 === 0) await yieldToLoop();
      }
      // Anything the batch never answered goes back for another try.
      const missing = db.prepare(`SELECT * FROM extraction_items WHERE batch_id = ? AND status = 'submitted'`).all(b.batch_id) as ItemRow[];
      for (const item of missing) retryLater(c, item, 'missing');
      db.prepare(`UPDATE extraction_batches SET status = 'collected', ended_at = ?, collected_at = ?, stats = ? WHERE batch_id = ?`).run(
        st.endedAt,
        deps.now(),
        JSON.stringify({ results: n }),
        b.batch_id,
      );
      bump(counts, 'batches_collected');
      if (b.kind === 'extract') waveFollowups.push({ wave: b.wave, newBefore: b.submitted_at });
    }

    // Requeues (one batch per kind).
    for (const kind of ['extract', 'historical', 'consolidate'] as const) {
      const specs = c.requeue.filter((s) => s.kind === kind);
      if (!specs.length) continue;
      // Keep the wave of the windows they retry (so overflow never exceeds MAX_WAVES a night).
      const wave = Math.max(1, ...specs.map((s) => (s.windowId ? (getWindow(db, s.windowId)?.wave ?? 1) : 1)));
      const res = await submitSpecs(deps, specs, { kind, wave, runId, tz: env.tz });
      bump(counts, 'resubmitted', res.submitted);
      if (res.blocked) bump(counts, 'egress_blocked', res.blocked);
      for (const s of res.failed) if (s.windowId) setWindowStatus(db, s.windowId, 'pending', deps.now());
    }

    // Overflow waves 2–4 for conversations whose window was just applied (before the cutoff).
    const clock = hhmm(deps.now(), env.tz);
    for (const f of waveFollowups) {
      const convs = c.appliedConversations.get(f.wave);
      if (!convs?.size || f.wave >= MAX_WAVES || clock >= WAVE_CUTOFF) continue;
      const rep = await submitSteady(deps, { wave: f.wave + 1, conversations: [...convs], newBefore: f.newBefore, runId });
      for (const [k, v] of Object.entries(rep.counts)) bump(counts, `wave_${k}`, v);
    }

    if (active) {
      const rep = await advanceBackfill(deps, { runId });
      bump(counts, `backfill_${rep.status}`);
    }
    housekeeping();
    finishRun(db, runId, partial ? 'partial' : 'ok', { now: deps.now(), summary: counts });
    (deps.log ?? nullLogger).info('extract.collect', { run_id: runId, counts });
    return { status: partial ? 'partial' : 'ok', counts };
  } catch (e) {
    finishRun(db, runId, 'error', { now: deps.now() });
    throw e;
  }
}

/** Drops stored user turns 30 days after a window was applied/finished (the packet's ref maps stay). */
export function purgePackets(db: DB, now: number): number {
  return db
    .prepare(
      `UPDATE extraction_packets SET user_text = NULL, purged_at = ? WHERE purged_at IS NULL AND user_text IS NOT NULL AND updated_at < ?
         AND window_id IN (SELECT id FROM windows WHERE status IN ('applied','refused','dead_letter','split','triaged_out'))`,
    )
    .run(now, now - PACKET_RETENTION_MS).changes;
}

// ---------------------------------------------------------------------------------------------- backfill

interface BackfillRow {
  id: string;
  status: 'running' | 'consolidating' | 'done' | 'budget_exhausted' | 'cancelled';
  through_at: number;
  /** JSON: { built_at } once every conversation's windows were built */
  stats: string | null;
  started_at: number;
  finished_at: number | null;
}

export function activeBackfill(db: DB): BackfillRow | null {
  return (
    (db
      .prepare(`SELECT * FROM extraction_backfill WHERE status IN ('running','consolidating','budget_exhausted') ORDER BY started_at DESC LIMIT 1`)
      .get() as BackfillRow | undefined) ?? null
  );
}

export interface BackfillReport {
  status: 'none' | 'unavailable' | 'running' | 'consolidating' | 'done' | 'budget_exhausted';
  reason?: LlmUnavailableReason;
  windows: Counts;
  consolidations: Counts;
  spendUsd: number;
  budgetUsd: number;
  counts: Counts;
}

function backfillReport(deps: ExtractionDeps, status: BackfillReport['status'], counts: Counts, reason?: LlmUnavailableReason): BackfillReport {
  const db = deps.db;
  const windows = Object.fromEntries(
    (db.prepare(`SELECT status, count(*) AS n FROM windows WHERE mode = 'historical' GROUP BY status`).all() as { status: string; n: number }[]).map((r) => [r.status, r.n]),
  );
  const consolidations = Object.fromEntries(
    (db.prepare(`SELECT status, count(*) AS n FROM extraction_items WHERE kind = 'consolidate' AND backfill_id IS NOT NULL GROUP BY status`).all() as {
      status: string;
      n: number;
    }[]).map((r) => [r.status, r.n]),
  );
  const spend = deps.llm.spend();
  return { status, ...(reason ? { reason } : {}), windows, consolidations, spendUsd: spend.backfillUsd, budgetUsd: spend.backfillBudgetUsd, counts };
}

/**
 * Starts the one-time backfill (or continues the active one). Without a key/budget nothing is created.
 * Windows: every eligible conversation's uncovered messages sent before its steady start, conversation-month
 * chunks; ADD-only; submitted from the 'backfill' pool.
 */
export async function startBackfill(deps: ExtractionDeps): Promise<BackfillReport> {
  const db = deps.db;
  const active = activeBackfill(db);
  if (active) return advanceBackfill(deps);
  const done = db.prepare(`SELECT 1 FROM extraction_backfill WHERE status = 'done' LIMIT 1`).pluck().get();
  if (done) return backfillReport(deps, 'done', {});
  const check = deps.llm.canSpend('backfill');
  if (!check.ok) return backfillReport(deps, 'unavailable', {}, check.reason);
  const now = deps.now();
  const env = buildEnv(db, now);
  const id = uuidv7(now);
  // History ends where steady extraction starts: the last couple of days stay steady (full ops, rolling summary).
  const throughAt = now - STEADY_INITIAL_LOOKBACK_MS;
  const runId = startRun(db, 'import', { jobRunId: deps.jobRunId ?? null, now });
  db.prepare(`INSERT INTO extraction_backfill (id, status, through_at, run_id, started_at, updated_at) VALUES (?, 'running', ?, ?, ?, ?)`).run(id, throughAt, runId, now, now);
  const counts: Counts = {};
  try {
    await buildBackfillWindows(deps, env, { id, through_at: throughAt }, counts);
  } catch (e) {
    finishRun(db, runId, 'error', { now: deps.now() });
    throw e;
  }
  finishRun(db, runId, 'ok', { now: deps.now(), summary: counts });
  const rep = await advanceBackfill(deps, { runId });
  return { ...rep, counts: { ...counts, ...rep.counts } };
}

/** Whether the backfill's windows were all built (stats.built_at; a backfill started before it existed: no). */
function backfillBuilt(row: BackfillRow): boolean {
  try {
    return typeof (JSON.parse(row.stats ?? '{}') as { built_at?: unknown }).built_at === 'number';
  } catch {
    return false;
  }
}

/**
 * Creates the backfill's windows: every eligible conversation's uncovered messages sent before its steady start,
 * most recently active conversations first. Covered messages are skipped, so a build that stopped part-way (an
 * abort, a crash) is simply run again by the next advance; once it has gone through every conversation,
 * stats.built_at is set and nothing is rebuilt.
 */
async function buildBackfillWindows(deps: ExtractionDeps, env: Env, row: { id: string; through_at: number }, counts: Counts): Promise<void> {
  const db = deps.db;
  const names = new NameIndex(env);
  const out: BuildResult = { specs: [], created: [], counts };
  const convs = db.prepare(`SELECT id FROM conversations WHERE kind IN ('direct','group') ORDER BY last_message_at DESC`).pluck().all() as string[];
  let i = 0;
  for (const conversationId of convs) {
    if (deps.signal?.aborted) return;
    const since = steadySince(env, conversationId, { backfillThroughAt: row.through_at });
    buildConversation(env, deps.egress, names, conversationId, { mode: 'historical', wave: 1, from: 0, before: since, backfillId: row.id }, out);
    if (++i % 10 === 0) await yieldToLoop();
  }
  db.prepare(`UPDATE extraction_backfill SET stats = json_set(coalesce(stats, '{}'), '$.built_at', ?), updated_at = ? WHERE id = ?`).run(env.now, env.now, row.id);
}

/** One step of the backfill state machine (called by collect and by the manual job). */
export async function advanceBackfill(deps: ExtractionDeps, o: { runId?: string } = {}): Promise<BackfillReport> {
  const db = deps.db;
  const row = activeBackfill(db);
  if (!row) {
    const done = db.prepare(`SELECT 1 FROM extraction_backfill WHERE status = 'done' LIMIT 1`).pluck().get();
    return backfillReport(deps, done ? 'done' : 'none', {});
  }
  const counts: Counts = {};
  const now = deps.now();
  const env = buildEnv(db, now);
  const runId = o.runId ?? startRun(db, 'import', { jobRunId: deps.jobRunId ?? null, now });
  const setStatus = (s: BackfillRow['status']) =>
    db.prepare(`UPDATE extraction_backfill SET status = ?, updated_at = ?, finished_at = CASE WHEN ? = 'done' THEN ? ELSE finished_at END WHERE id = ?`).run(s, now, s, now, row.id);
  try {
    if (row.status === 'running' || row.status === 'budget_exhausted') {
      // Cheap check first: at the allowance nothing is rebuilt or sent (collect calls this every 5 minutes).
      const spend = deps.llm.canSpend('backfill');
      if (!spend.ok) {
        if (spend.reason === 'budget_backfill' && row.status !== 'budget_exhausted') setStatus('budget_exhausted');
        return backfillReport(deps, spend.reason === 'budget_backfill' ? 'budget_exhausted' : row.status === 'budget_exhausted' ? 'budget_exhausted' : 'running', counts, spend.reason);
      }
      // A build that never finished (stopped part-way) completes first, so no conversation is left out.
      if (!backfillBuilt(row)) {
        await buildBackfillWindows(deps, env, row, counts);
        if (deps.signal?.aborted) return backfillReport(deps, row.status === 'budget_exhausted' ? 'budget_exhausted' : 'running', counts);
        bump(counts, 'build_resumed');
      }
      const pending = await pendingSpecs(env, deps.egress, new NameIndex(env), 'historical', row.id, counts, deps.signal);
      if (pending.length) {
        const res = await submitSpecs(deps, pending, { kind: 'historical', wave: 1, runId, tz: env.tz });
        bump(counts, 'submitted', res.submitted);
        if (res.blocked) bump(counts, 'egress_blocked', res.blocked);
        if (res.unavailable) {
          setStatus(res.unavailable === 'budget_backfill' ? 'budget_exhausted' : row.status);
          return backfillReport(deps, res.unavailable === 'budget_backfill' ? 'budget_exhausted' : 'running', counts, res.unavailable);
        }
        if (row.status === 'budget_exhausted') setStatus('running');
        return backfillReport(deps, 'running', counts);
      }
      const inflight = db.prepare(`SELECT count(*) FROM windows WHERE mode = 'historical' AND status = 'submitted'`).pluck().get() as number;
      if (inflight) return backfillReport(deps, row.status === 'budget_exhausted' ? 'budget_exhausted' : 'running', counts);
      // All historical windows are done: put places/jobs in order, then consolidate people with ≥8 facts.
      bump(counts, 'reconciled', reconcileChronology({ env, egress: deps.egress, runId, now, promptVersion: EXTRACTION_PROMPT_VERSION }));
      const specs: Spec[] = [];
      for (const personId of consolidationCandidates(db)) {
        let req: ConsolidationRequest | null;
        try {
          req = buildConsolidation(env, deps.egress, personId);
        } catch (e) {
          // This person only: their facts stay as they are.
          if (!(e instanceof EgressBlocked)) throw e;
          recordBlocked(db, { kind: 'consolidate', windowId: null, personId, backfillId: row.id, attempt: 0, maxTokens: CONSOLIDATION_MAX_TOKENS }, now);
          bump(counts, 'consolidation_egress_blocked');
          continue;
        }
        if (!req) continue;
        specs.push({ kind: 'consolidate', windowId: null, personId: req.personId, backfillId: row.id, attempt: 0, maxTokens: CONSOLIDATION_MAX_TOKENS, userText: req.userText, tokens: req.tokens, payload: req });
      }
      if (specs.length) {
        const res = await submitSpecs(deps, specs, { kind: 'consolidate', wave: 1, runId, tz: env.tz });
        bump(counts, 'consolidations_submitted', res.submitted);
        if (res.blocked) bump(counts, 'consolidation_egress_blocked', res.blocked);
        if (res.unavailable && !res.submitted) {
          setStatus('budget_exhausted');
          return backfillReport(deps, 'budget_exhausted', counts, res.unavailable);
        }
      }
      setStatus(specs.length ? 'consolidating' : 'done');
      if (!specs.length) markBackfillDone(db, now);
      return backfillReport(deps, specs.length ? 'consolidating' : 'done', counts);
    }
    // consolidating
    const queued = db.prepare(`SELECT count(*) FROM extraction_items WHERE kind = 'consolidate' AND backfill_id = ? AND status = 'submitted'`).pluck().get(row.id) as number;
    if (queued) return backfillReport(deps, 'consolidating', counts);
    setStatus('done');
    markBackfillDone(db, now);
    return backfillReport(deps, 'done', counts);
  } finally {
    if (!o.runId) finishRun(db, runId, 'ok', { now: deps.now(), summary: counts });
  }
}

function markBackfillDone(db: DB, now: number): void {
  db.prepare('UPDATE extraction_conv_state SET backfill_done_at = coalesce(backfill_done_at, ?), updated_at = ?').run(now, now);
}

export interface BackfillPlan {
  conversations: number;
  conversationsSkipped: number;
  messages: number;
  windows: number;
  windowsTriaged: number;
  /** Prompt tokens of all windows (user turns, conservative 3 chars/token; the cached system prompt not included). */
  tokens: number;
  /** All windows at batch prices on the route's model (consolidation not included). */
  estimateUsd: number;
  /** The model the historical route would use (default Haiku 5.5). */
  model: string;
  /** The backfill allowance and what was already spent from it. */
  budgetUsd: number;
  spentUsd: number;
  /** Windows the remaining allowance covers, in submit order (the rest would wait for a bigger allowance). */
  windowsWithinBudget: number;
  alreadyStarted: boolean;
}

/** Read-only: what the backfill would do (counts and a cost estimate). Never writes, never sends. */
export function planBackfill(db: DB, now: number): BackfillPlan {
  const env = buildEnv(db, now);
  const params = resolveRoute('extract_historical', readSetting(db, 'llm.route_overrides'));
  const budgetUsd = readSetting(db, 'llm.backfill_budget_usd');
  const spentUsd = (db.prepare(`SELECT coalesce(sum(cost_usd), 0) FROM llm_requests WHERE pool = 'backfill'`).pluck().get() as number) ?? 0;
  const plan: BackfillPlan = {
    conversations: 0,
    conversationsSkipped: 0,
    messages: 0,
    windows: 0,
    windowsTriaged: 0,
    tokens: 0,
    estimateUsd: 0,
    model: params.model,
    budgetUsd,
    spentUsd: Math.round(spentUsd * 100) / 100,
    windowsWithinBudget: 0,
    alreadyStarted: false,
  };
  plan.alreadyStarted = db.prepare(`SELECT 1 FROM extraction_backfill LIMIT 1`).pluck().get() !== undefined;
  const state = db.prepare('SELECT steady_since_at FROM extraction_conv_state WHERE conversation_id = ?').pluck();
  // The submit order (most recently active conversations first), so "within budget" matches what would go out.
  const convs = db.prepare(`SELECT id FROM conversations WHERE kind IN ('direct','group') ORDER BY last_message_at DESC`).pluck().all() as string[];
  const remaining = Math.max(0, budgetUsd - spentUsd);
  for (const id of convs) {
    const conv = getConversation(db, id)!;
    const elig = eligibility(env, conv);
    if (!elig.ok) {
      plan.conversationsSkipped++;
      continue;
    }
    const since = (state.get(id) as number | undefined) ?? now - STEADY_INITIAL_LOOKBACK_MS;
    const msgs = uncoveredMessages(db, id, { from: 0, before: since });
    if (!msgs.length) continue;
    plan.conversations++;
    plan.messages += msgs.length;
    for (const p of planWindows(msgs, { mode: 'historical', chat: elig.chat, tz: env.tz })) {
      if (!triage(env, p.messages, { chat: elig.chat, memberCount: elig.memberCount }).keep) {
        plan.windowsTriaged++;
        continue;
      }
      plan.windows++;
      // NEW text + header/cards/mentionables (~600 packing tokens), rescaled to the conservative count.
      const tokens = p.tokens + 600;
      plan.tokens += Math.ceil((tokens * 4) / 3);
      const usd = estimateWindowUsd(tokens, params);
      plan.estimateUsd += usd;
      if (plan.estimateUsd <= remaining) plan.windowsWithinBudget++;
    }
  }
  plan.estimateUsd = Math.round(plan.estimateUsd * 10_000) / 10_000;
  return plan;
}


export interface BackfillStatus {
  state: BackfillRow['status'] | null;
  startedAt: number | null;
  finishedAt: number | null;
  windows: Counts;
  consolidations: Counts;
  spentUsd: number;
}

/** Read-only progress (counts only), for the CLI while a server owns the database. */
export function backfillStatus(db: DB): BackfillStatus {
  const row = db.prepare('SELECT status, started_at, finished_at FROM extraction_backfill ORDER BY started_at DESC LIMIT 1').get() as
    | { status: BackfillRow['status']; started_at: number; finished_at: number | null }
    | undefined;
  const group = (sql: string) => Object.fromEntries((db.prepare(sql).all() as { status: string; n: number }[]).map((r) => [r.status, r.n]));
  const spent = (db.prepare(`SELECT coalesce(sum(cost_usd), 0) FROM llm_requests WHERE kind IN ('historical','consolidate')`).pluck().get() as number) ?? 0;
  return {
    state: row?.status ?? null,
    startedAt: row?.started_at ?? null,
    finishedAt: row?.finished_at ?? null,
    windows: group(`SELECT status, count(*) AS n FROM windows WHERE mode = 'historical' GROUP BY status`),
    consolidations: group(`SELECT status, count(*) AS n FROM extraction_items WHERE kind = 'consolidate' AND backfill_id IS NOT NULL GROUP BY status`),
    spentUsd: Math.round(spent * 10_000) / 10_000,
  };
}
