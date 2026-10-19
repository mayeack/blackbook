/**
 * prompt_version comparison ("shadow mode", intelligence §8): replays recent extraction windows — the last 7 days
 * of applied steady windows, plus every golden (G1) window — through a CANDIDATE prompt (this build's extraction
 * prompt, a different effort, or a prompt read from a local file) into eval_shadow_items. Nothing is applied: the
 * replay is validated with the extraction validator and compared claim by claim with the baseline (the stored
 * model output re-validated, or what was applied when that output was purged).
 *
 * Safety: only the pseudonymized user turns stored with each window are sent (the LLM client scans them again and
 * fails closed); windows in conversations or with people the owner has since excluded from Claude, or with people
 * he has hidden, are skipped. Synchronous calls on the 'eval_shadow' route (llm/models.ts: Haiku 5.5, thinking off;
 * --effort replaces only its effort), from the steady budget, capped by --max-usd; without an API key nothing is
 * sent. The first request runs alone so the shared system prompt is cached before the others start (parallel
 * requests can't read a cache entry that is still being written). The report is counts and rates only.
 *
 * The gate (intelligence §8): no per-category precision drop > 2 points on labeled G1 windows, and a spot-check of
 * 20 diff windows — the run turns them into eval items (origin 'shadow') the owner labels on /settings/eval.
 */
import { uuidv7 } from '@yb/shared';
import type { DB } from '../db/connection';
import { GATES, loadPacket, validateExtraction, type Packet } from '../extraction';
import { mergedText, obligationsCustomId, parseWindowSync } from '../extraction/parts';
import { parseExtraction } from '../extraction/schema';
import {
  EXTRACTION_PROMPT_VERSION,
  extractionParts,
  extractionPromptText,
  HISTORICAL_MAX_TOKENS,
  KNOWLEDGE_SCHEMA_JSON,
  KNOWLEDGE_SYSTEM,
  OBLIGATIONS_SCHEMA_JSON,
  OBLIGATIONS_SYSTEM,
  STEADY_MAX_TOKENS,
  type ExtractionPart,
  type ExtractionPartName,
} from '../extraction/prompt';
import { needsObligations } from '../extraction/validate';
import { estimatePromptTokens, estimateRouteUsd, llmExclusions, promptVersion, resolveRoute, routeOverrides, type LlmClient, type LlmEffort, type RouteParams } from '../llm';
import { nullLogger, type Logger } from '../ops/logger';
import { settingTimeZone } from '../settings/registry';
import { bucketOf, matchClaims } from './match';
import { shadowSummary, type ShadowSummary } from './metrics';
import { appliedPredictions, INTEREST_CATS, keyedFromStored, keyedFromValidated } from './predictions';
import { finishShadowRun, getShadowRun, insertShadowItem, insertShadowRun, type ShadowItem, type ShadowItemStatus } from './shadowStore';
import { insertItems, itemsOf } from './store';
import type { ExtractionPayload, KeyedPrediction, NewItem, StoredPrediction } from './types';
import { canonFn, DAY, meId, shortDate, SOURCE_LABEL, sourceGroup, visibleFn, yieldToLoop } from './util';

export const SHADOW_DEFAULTS = { days: 7, limit: 600, maxUsd: 1, spotCheck: 20, concurrency: 3 } as const;

export interface ShadowOptions {
  db: DB;
  llm: LlmClient;
  now?: number;
  days?: number;
  limit?: number;
  maxUsd?: number;
  effort?: LlmEffort;
  /** The candidate knowledge prompt (default: this build's); a window's obligations request keeps this build's prompt. */
  system?: { text: string; source: 'code' | 'file' };
  /** Replay labeled/unlabeled G1 windows too (default true). */
  includeGolden?: boolean;
  spotCheck?: number;
  concurrency?: number;
  signal?: AbortSignal;
  log?: Logger;
}

export interface ShadowPlan {
  promptVersion: string;
  effort: LlmEffort;
  systemSource: 'code' | 'file';
  /** The candidate is the version in production (a stability re-run rather than a comparison). */
  sameAsCurrent: boolean;
  windows: number;
  golden: number;
  recent: number;
  excluded: number;
  noInput: number;
  estimateUsd: number;
}

export type ShadowOutcome =
  | { status: 'unavailable'; reason: string; plan: ShadowPlan }
  | { status: 'done' | 'partial' | 'stopped'; runId: string; stopReason: string | null; plan: ShadowPlan; summary: ShadowSummary };

interface Target {
  windowId: string;
  goldenItemId: string | null;
  packet: Packet | null;
  userText: string | null;
  skip: 'excluded' | 'no_input' | null;
}

type Systems = Record<ExtractionPartName, string>;
const SCHEMA_JSON: Systems = { knowledge: KNOWLEDGE_SCHEMA_JSON, obligations: OBLIGATIONS_SCHEMA_JSON };

/** One of a window's requests on the eval_shadow route (sync), with the candidate's system prompt. */
const estimatePartUsd = (userText: string, part: ExtractionPart, systems: Systems, p: RouteParams = resolveRoute('eval_shadow')) =>
  estimateRouteUsd(p, {
    userTokens: estimatePromptTokens(userText),
    systemTokens: estimatePromptTokens(systems[part.name].length + SCHEMA_JSON[part.name].length),
    mode: 'sync',
    ...(part.estOutputTokens !== null ? { outputTokens: part.estOutputTokens } : {}),
  });

/** A window's one or two requests. */
const estimateUsd = (t: Target, systems: Systems, p?: RouteParams) =>
  extractionParts(needsObligations(t.packet!)).reduce((n, part) => n + estimatePartUsd(t.userText!, part, systems, p), 0);

/**
 * The candidate: the prompts on the eval_shadow route as they will run (its model and effort, --effort replacing
 * the effort). With this build's prompts and the default route the version equals production extraction's.
 */
function candidate(o: Omit<ShadowOptions, 'llm'>): { systems: Systems; source: 'code' | 'file'; effort: LlmEffort; version: string; params: RouteParams } {
  const systems: Systems = { knowledge: o.system?.text ?? KNOWLEDGE_SYSTEM, obligations: OBLIGATIONS_SYSTEM };
  const params = shadowParams(o.db, o.effort);
  const text = extractionPromptText(systems.knowledge, systems.obligations);
  return { systems, source: o.system?.source ?? 'code', effort: params.effort, version: promptVersion(text.system, text.schemaJson, params.effort, params.model), params };
}

/** Which windows a run would replay (read-only). */
function targets(o: Omit<ShadowOptions, 'llm'>, now: number): Target[] {
  const db = o.db;
  const days = o.days ?? SHADOW_DEFAULTS.days;
  const limit = Math.max(1, o.limit ?? SHADOW_DEFAULTS.limit);
  const ex = llmExclusions(db);
  const canon = canonFn(db);
  const visible = visibleFn(db);
  const me = meId(db);
  const out: Target[] = [];
  const seen = new Set<string>();
  const add = (windowId: string, goldenItemId: string | null, userText: string | null) => {
    if (seen.has(windowId) || out.length >= limit) return;
    seen.add(windowId);
    const pk = loadPacket(db, windowId);
    const text = userText ?? pk?.userText ?? null;
    let skip: Target['skip'] = null;
    if (!pk || !text) skip = 'no_input';
    else if (ex.conversations.has(pk.packet.conversationId)) skip = 'excluded';
    else
      for (const r of Object.values(pk.packet.refs)) {
        const c = canon(r.personId);
        // excluded from Claude, or hidden since the window was built (participant or mentionable): not re-sent
        if (ex.people.has(c) || ex.people.has(r.personId) || (c !== me && !visible(c))) {
          skip = 'excluded';
          break;
        }
      }
    out.push({ windowId, goldenItemId, packet: pk?.packet ?? null, userText: text, skip });
  };
  if (o.includeGolden ?? true) {
    const golden = itemsOf(db, 'extraction', { origin: 'sample' })
      .filter((i) => (i.payload as ExtractionPayload).status === 'applied')
      .sort((a, b) => Number(!!b.label) - Number(!!a.label)); // labeled first
    for (const it of golden) add((it.payload as ExtractionPayload).windowId, it.id, (it.payload as ExtractionPayload).userText);
  }
  const recent = db
    .prepare(
      `SELECT w.id FROM windows w JOIN extraction_packets p ON p.window_id = w.id
       WHERE w.status = 'applied' AND w.mode = 'steady' AND w.updated_at >= ? AND p.user_text IS NOT NULL
       ORDER BY w.updated_at DESC, w.id LIMIT ?`,
    )
    .pluck()
    .all(now - days * DAY, limit) as string[];
  for (const id of recent) add(id, null, null);
  return out;
}

export function planShadow(o: Omit<ShadowOptions, 'llm'>): ShadowPlan {
  const now = o.now ?? Date.now();
  return planOf(candidate(o), targets(o, now));
}

/** The eval_shadow route as it will run (the owner's overrides, then --effort). */
function shadowParams(db: DB, effort?: LlmEffort): RouteParams {
  const p = resolveRoute('eval_shadow', routeOverrides(db));
  return effort ? { ...p, effort } : p;
}

function planOf(c: ReturnType<typeof candidate>, ts: readonly Target[]): ShadowPlan {
  const runnable = ts.filter((t) => !t.skip);
  const current = EXTRACTION_PROMPT_VERSION;
  return {
    promptVersion: c.version,
    effort: c.effort,
    systemSource: c.source,
    sameAsCurrent: c.version === current,
    windows: runnable.length,
    golden: runnable.filter((t) => t.goldenItemId).length,
    recent: runnable.filter((t) => !t.goldenItemId).length,
    excluded: ts.filter((t) => t.skip === 'excluded').length,
    noInput: ts.filter((t) => t.skip === 'no_input').length,
    estimateUsd: Math.round(runnable.reduce((s, t) => s + estimateUsd(t, c.systems, c.params), 0) * 10_000) / 10_000,
  };
}

/** Facts the apply gates would plausibly show (candidates below them aren't claims on either side). */
function gatedClaims(claims: KeyedPrediction[]): KeyedPrediction[] {
  return claims.filter((k) => {
    if (k.kind !== 'fact' || k.conf === null) return true;
    const gate = INTEREST_CATS.has(k.cat) ? GATES.interestTentative : k.cat === 'other' ? GATES.other : GATES.fact;
    return k.conf >= gate;
  });
}

function factNormOf(packet: Packet): (factId: string) => string | null {
  const m = new Map(Object.values(packet.facts).map((f) => [f.factId, f.valueNorm]));
  return (id) => m.get(id) ?? null;
}

function baselineOf(db: DB, t: Target, now: number, canon: (id: string) => string, goldenPreds: StoredPrediction[] | null, ctx: Parameters<typeof appliedPredictions>[0]): Pick<ShadowItem, 'baseline' | 'baselineSource' | 'baselineVersion'> {
  const packet = t.packet!;
  // The window's knowledge answer (or a whole one-request answer from before the split), then its obligations
  // answer by custom_id; a one-request answer carries both parts itself.
  const row = db
    .prepare(
      `SELECT custom_id, output, prompt_version FROM llm_requests
       WHERE subject_ref = ? AND kind IN ('extract','historical') AND status IN ('succeeded','applied') AND output IS NOT NULL
         AND json_valid(output) AND json_type(output, '$.facts') IS NOT NULL
         AND (run_id IS NULL OR run_id NOT IN (SELECT id FROM eval_shadow_runs))
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(t.windowId) as { custom_id: string; output: string; prompt_version: string } | undefined;
  if (row) {
    try {
      const obligations = db.prepare('SELECT output FROM llm_requests WHERE custom_id = ? AND output IS NOT NULL').pluck().get(obligationsCustomId(row.custom_id)) as string | undefined;
      const merged = mergedText(row.output, needsObligations(packet) ? (obligations ?? row.output) : undefined);
      const parsed = parseExtraction(merged === null ? null : JSON.parse(merged));
      if (parsed.success) {
        const v = validateExtraction(parsed.data, packet, { now });
        return { baseline: gatedClaims(keyedFromValidated(v, canon, factNormOf(packet))), baselineSource: 'output', baselineVersion: row.prompt_version };
      }
    } catch {
      // fall through to what was applied
    }
  }
  const version = (db.prepare('SELECT prompt_version FROM windows WHERE id = ?').pluck().get(t.windowId) as string | null | undefined) ?? null;
  const preds = goldenPreds ?? appliedPredictions(ctx, t.windowId, packet.lines.filter((l) => l.role === 'new').map((l) => l.msgId));
  return { baseline: keyedFromStored(preds), baselineSource: 'applied', baselineVersion: version };
}

export async function runShadow(o: ShadowOptions): Promise<ShadowOutcome> {
  const db = o.db;
  const now = o.now ?? Date.now();
  const log = o.log ?? nullLogger;
  const cand = candidate(o);
  const all = targets({ ...o, now }, now);
  const params = cand.params;
  const plan = planOf(cand, all);
  if (!plan.windows) return { status: 'unavailable', reason: 'no_windows', plan };
  const maxUsd = o.maxUsd ?? SHADOW_DEFAULTS.maxUsd;
  const gate = o.llm.canSpend('steady', Math.min(plan.estimateUsd, maxUsd));
  if (!gate.ok) return { status: 'unavailable', reason: gate.reason, plan };

  const runId = uuidv7(now);
  insertShadowRun(db, { id: runId, kind: 'extraction', prompt_version: cand.version, effort: cand.effort, system_source: cand.source, since_at: now - (o.days ?? SHADOW_DEFAULTS.days) * DAY, through_at: now, started_at: now });
  const canon = canonFn(db);
  const ctx = { db, tz: settingTimeZone(db), canon, visible: visibleFn(db), meId: meId(db) };
  const golden = new Map(itemsOf(db, 'extraction', { origin: 'sample' }).map((i) => [i.id, i]));
  const counts: Record<string, number> = {};
  const bump = (k: string, n = 1) => void (counts[k] = (counts[k] ?? 0) + n);
  const state: { spent: number; stop: string | null; next: number; sent: number } = { spent: 0, stop: null, next: 0, sent: 0 };

  const one = async (t: Target): Promise<void> => {
    if (t.skip) {
      insertShadowItem(db, runId, { windowId: t.windowId, goldenItemId: t.goldenItemId, status: t.skip, baselineSource: 'none', baselineVersion: null, baseline: [], shadow: [], costUsd: null, llmRequest: null }, Date.now());
      bump(t.skip);
      return;
    }
    const packet = t.packet!;
    const base = baselineOf(db, t, now, canon, t.goldenItemId ? (golden.get(t.goldenItemId)?.predictions ?? null) : null, ctx);
    state.sent++;
    const out = await parseWindowSync(
      o.llm,
      {
        kind: packet.mode === 'historical' ? 'historical' : 'extract',
        route: 'eval_shadow',
        subjectRef: t.windowId,
        promptVersion: cand.version,
        systems: cand.systems,
        messages: [{ role: 'user', content: t.userText! }],
        // The eval-only effort override: constant for the whole run, so the run's requests share one cache entry each.
        ...(o.effort ? { effortOverride: o.effort } : {}),
        maxTokens: Math.min(params.maxTokens, packet.mode === 'historical' ? HISTORICAL_MAX_TOKENS : STEADY_MAX_TOKENS),
        pool: 'steady',
        estimateUsd: (part) => estimatePartUsd(t.userText!, part, cand.systems, params),
        runId,
        ...(o.signal ? { signal: o.signal } : {}),
      },
      needsObligations(packet),
    );
    let status: ShadowItemStatus;
    let shadow: KeyedPrediction[] = [];
    let cost: number | null = null;
    let requestId: string | null = null;
    if (out.status === 'unavailable') {
      status = 'unavailable';
      if (/^(budget_|no_key$|disabled$|aborted$)/.test(out.reason)) state.stop ??= out.reason;
    } else {
      cost = out.usage.costUsd;
      state.spent += cost;
      requestId = out.requestId;
      if (out.status === 'ok') {
        status = 'ok';
        shadow = gatedClaims(keyedFromValidated(validateExtraction(out.value, packet, { now }), canon, factNormOf(packet)));
      } else status = out.status === 'refused' ? 'refused' : out.status === 'max_tokens' ? 'max_tokens' : 'invalid';
    }
    insertShadowItem(db, runId, { windowId: t.windowId, goldenItemId: t.goldenItemId, status, ...base, shadow, costUsd: cost, llmRequest: requestId }, Date.now());
    bump(status);
    if (state.spent >= maxUsd) state.stop ??= 'max_usd';
  };

  const step = async () => {
    const t = all[state.next++]!;
    try {
      await one(t);
    } catch (e) {
      bump('error');
      log.warn('eval.shadow_window_failed', { ids: [t.windowId], error_class: (e as Error).name });
    }
    await yieldToLoop();
  };
  const go = () => {
    if (o.signal?.aborted) state.stop ??= 'aborted';
    return !state.stop && state.next < all.length;
  };
  // Warm the cache: the first request runs alone (concurrent requests can't read an entry still being written),
  // then the workers all read the shared system prompt from it.
  while (go() && state.sent === 0) await step();
  const worker = async () => {
    while (go()) await step();
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(o.concurrency ?? SHADOW_DEFAULTS.concurrency, 8)) }, worker));

  const status: 'done' | 'partial' | 'stopped' = state.stop ? (counts.ok ? 'partial' : 'stopped') : 'done';
  bump('spot_check_items', createSpotChecks(db, runId, cand.version, o.spotCheck ?? SHADOW_DEFAULTS.spotCheck, ctx, now));
  finishShadowRun(db, runId, { status, stopReason: state.stop, counts, costUsd: state.spent, now: Date.now() });
  const summary = shadowSummary(db, getShadowRun(db, runId)!);
  log.info('eval.shadow', { ids: [runId], counts: { ...counts, agree: summary.agree, added: summary.added, removed: summary.removed } });
  return { status, runId, stopReason: state.stop, plan, summary };
}

/** Up to `n` diff windows → eval items the owner labels (the 20-diff spot check). */
function createSpotChecks(db: DB, runId: string, version: string, n: number, ctx: Parameters<typeof appliedPredictions>[0], now: number): number {
  if (n <= 0) return 0;
  const rows = db
    .prepare(`SELECT window_id, baseline, shadow FROM eval_shadow_items WHERE run_id = ? AND status = 'ok' ORDER BY window_id`)
    .all(runId) as { window_id: string; baseline: string; shadow: string }[];
  const diffs = rows
    .map((r) => {
      const m = matchClaims(JSON.parse(r.baseline) as KeyedPrediction[], JSON.parse(r.shadow) as KeyedPrediction[]);
      return { windowId: r.window_id, m, size: m.onlyA.length + m.onlyB.length };
    })
    .filter((d) => d.size > 0)
    .sort((a, b) => b.size - a.size || a.windowId.localeCompare(b.windowId))
    .slice(0, n);
  const items: NewItem[] = [];
  for (const d of diffs) {
    const pk = loadPacket(db, d.windowId);
    if (!pk) continue;
    const conv = db.prepare('SELECT source, kind FROM conversations WHERE id = ?').get(pk.packet.conversationId) as { source: string; kind: string } | undefined;
    if (!conv) continue;
    const toStored = (k: KeyedPrediction, i: number, shadow: 'added' | 'kept' | 'removed'): StoredPrediction => ({
      id: `s${i}`,
      kind: k.kind,
      label: k.label,
      detail: shadow === 'added' ? `new in ${version}` : shadow === 'removed' ? `dropped by ${version}` : 'unchanged',
      refs: k.refs,
      m: { cat: k.cat, applied: true, personId: k.personId, key: k.key, value: k.value, conf: k.conf, shadow },
    });
    let i = 0;
    const predictions = [
      ...d.m.onlyB.map((k) => toStored(k, i++, 'added')),
      ...d.m.onlyA.map((k) => toStored(k, i++, 'removed')),
      ...d.m.pairs.map(({ b }) => toStored(b, i++, 'kept')),
    ].filter((p) => !p.m.personId || p.m.personId === ctx.meId || ctx.visible(p.m.personId));
    const lines = pk.packet.lines.map((l) => ({ msgId: l.msgId, n: l.n, role: l.role, at: l.at, authorPersonId: l.authorPersonId ? ctx.canon(l.authorPersonId) : null, body: l.body }));
    const firstAt = Math.min(...lines.filter((l) => l.role === 'new').map((l) => l.at));
    const payload: ExtractionPayload = {
      kind: 'extraction',
      windowId: d.windowId,
      conversationId: pk.packet.conversationId,
      source: conv.source,
      chat: conv.kind === 'direct' ? 'dm' : 'group',
      mode: pk.packet.mode,
      status: 'applied',
      lines,
      userText: null,
    };
    const first = d.m.onlyB[0] ?? d.m.onlyA[0]!;
    items.push({
      set: 'extraction',
      subjectRef: `shadow:${runId}:${d.windowId}`,
      stratum: `shadow|${bucketOf(first)}`,
      title: `Prompt ${version} · ${SOURCE_LABEL[sourceGroup(conv.source)]} · ${shortDate(firstAt, ctx.tz, now)}`,
      frozenAt: now,
      payload,
      predictions,
      promptVersion: version,
      origin: 'shadow',
      shadowRunId: runId,
    });
  }
  return insertItems(db, items, now);
}
