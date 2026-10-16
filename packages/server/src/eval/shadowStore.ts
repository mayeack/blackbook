/** eval_shadow_runs / eval_shadow_items access (prompt_version comparison replays). */
import type { DB } from '../db/connection';
import type { KeyedPrediction } from './types';

export interface ShadowRunRow {
  id: string;
  kind: 'extraction';
  prompt_version: string;
  effort: string;
  system_source: 'code' | 'file';
  since_at: number;
  through_at: number;
  status: 'running' | 'done' | 'partial' | 'stopped';
  stop_reason: string | null;
  counts: string | null;
  cost_usd: number;
  started_at: number;
  finished_at: number | null;
}

export type ShadowItemStatus = 'ok' | 'refused' | 'invalid' | 'max_tokens' | 'unavailable' | 'no_input' | 'excluded';

export interface ShadowItem {
  windowId: string;
  goldenItemId: string | null;
  status: ShadowItemStatus;
  baselineSource: 'output' | 'applied' | 'none';
  baselineVersion: string | null;
  baseline: KeyedPrediction[];
  shadow: KeyedPrediction[];
  costUsd: number | null;
}

export function getShadowRun(db: DB, id: string): ShadowRunRow | null {
  return (db.prepare('SELECT * FROM eval_shadow_runs WHERE id = ?').get(id) as ShadowRunRow | undefined) ?? null;
}

export function latestShadowRun(db: DB, o: { finishedOnly?: boolean } = {}): ShadowRunRow | null {
  return (
    (db
      .prepare(`SELECT * FROM eval_shadow_runs ${o.finishedOnly ? `WHERE status IN ('done','partial')` : ''} ORDER BY started_at DESC, id DESC LIMIT 1`)
      .get() as ShadowRunRow | undefined) ?? null
  );
}

export function insertShadowRun(db: DB, r: Omit<ShadowRunRow, 'status' | 'stop_reason' | 'counts' | 'cost_usd' | 'finished_at'>): void {
  db.prepare(
    `INSERT INTO eval_shadow_runs (id, kind, prompt_version, effort, system_source, since_at, through_at, status, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?)`,
  ).run(r.id, r.kind, r.prompt_version, r.effort, r.system_source, r.since_at, r.through_at, r.started_at);
}

export function finishShadowRun(db: DB, id: string, o: { status: ShadowRunRow['status']; stopReason: string | null; counts: Record<string, number>; costUsd: number; now: number }): void {
  db.prepare(`UPDATE eval_shadow_runs SET status = ?, stop_reason = ?, counts = ?, cost_usd = ?, finished_at = ? WHERE id = ?`).run(
    o.status,
    o.stopReason,
    JSON.stringify(o.counts),
    o.costUsd,
    o.now,
    id,
  );
}

export function insertShadowItem(db: DB, runId: string, it: ShadowItem & { llmRequest: string | null }, now: number): void {
  db.prepare(
    `INSERT OR REPLACE INTO eval_shadow_items (run_id, window_id, golden_item_id, status, baseline_source, baseline_version, baseline, shadow, llm_request, cost_usd, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    runId,
    it.windowId,
    it.goldenItemId,
    it.status,
    it.baselineSource,
    it.baselineVersion,
    JSON.stringify(it.baseline),
    JSON.stringify(it.shadow),
    it.llmRequest,
    it.costUsd,
    now,
  );
}

export function shadowItems(db: DB, runId: string): ShadowItem[] {
  const rows = db.prepare('SELECT * FROM eval_shadow_items WHERE run_id = ? ORDER BY window_id').all(runId) as {
    window_id: string;
    golden_item_id: string | null;
    status: ShadowItemStatus;
    baseline_source: 'output' | 'applied' | 'none';
    baseline_version: string | null;
    baseline: string;
    shadow: string;
    cost_usd: number | null;
  }[];
  return rows.map((r) => ({
    windowId: r.window_id,
    goldenItemId: r.golden_item_id,
    status: r.status,
    baselineSource: r.baseline_source,
    baselineVersion: r.baseline_version,
    baseline: JSON.parse(r.baseline) as KeyedPrediction[],
    shadow: JSON.parse(r.shadow) as KeyedPrediction[],
    costUsd: r.cost_usd,
  }));
}
