import { uuidv7 } from '@yb/shared';
import type { DB } from '../db/connection';

export type RunKind = 'nightly' | 'ingest' | 'command' | 'user' | 'migration' | 'import' | 'undo' | 'weekly' | 'system';
export type RunStatus = 'running' | 'ok' | 'error' | 'partial';

export interface RunRow {
  id: string;
  kind: RunKind;
  job_run_id: number | null;
  started_at: number;
  finished_at: number | null;
  status: RunStatus;
  stage: string | null;
  summary: string | null;
  undone_at: number | null;
  undo_run_id: string | null;
}

/** A run groups the batches one agent pass (or one user action) wrote; the feed and per-run undo use it. */
export function startRun(db: DB, kind: RunKind, options: { jobRunId?: number | null; now?: number } = {}): string {
  const now = options.now ?? Date.now();
  const id = uuidv7(now);
  db.prepare('INSERT INTO runs (id, kind, job_run_id, started_at, status) VALUES (?, ?, ?, ?, ?)').run(
    id,
    kind,
    options.jobRunId ?? null,
    now,
    'running',
  );
  return id;
}

export function finishRun(
  db: DB,
  runId: string,
  status: Exclude<RunStatus, 'running'> = 'ok',
  options: { summary?: Record<string, unknown>; now?: number } = {},
): void {
  db.prepare('UPDATE runs SET status = ?, finished_at = ?, summary = coalesce(?, summary) WHERE id = ?').run(
    status,
    options.now ?? Date.now(),
    options.summary ? JSON.stringify(options.summary) : null,
    runId,
  );
}

export function getRun(db: DB, runId: string): RunRow | undefined {
  return db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as RunRow | undefined;
}

/** Runs fn inside a new run, finishing it ok/error. */
export function withRun<T>(db: DB, kind: RunKind, fn: (runId: string) => T, options: { now?: number } = {}): T {
  const runId = startRun(db, kind, options);
  try {
    const result = fn(runId);
    finishRun(db, runId, 'ok', options);
    return result;
  } catch (e) {
    finishRun(db, runId, 'error', options);
    throw e;
  }
}
