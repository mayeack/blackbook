/**
 * One adapter pass = one journal run, created on the first journaled write (so idle passes leave no runs behind)
 * and closed by finish(). The ResolveContext it hands out is what identity/resolver.ts and identity/external.ts
 * take.
 */
import type { DB } from '../../db/connection';
import type { Actor } from '../../journal/batch';
import { finishRun, startRun, type RunKind } from '../../journal/runs';
import type { ResolveContext } from '../../identity/resolver';

export interface SourceRun {
  readonly ctx: ResolveContext;
  /** The run id if any write happened, else null. */
  readonly runId: string | null;
  /** Closes the run ('ok' / 'partial' / 'error'); a run that journaled nothing is deleted. Idempotent. */
  finish(status?: 'ok' | 'partial' | 'error', summary?: Record<string, unknown>): void;
}

export function sourceRun(
  db: DB,
  source: string,
  o: { now?: number; jobRunId?: number | null; kind?: RunKind; actor?: Actor } = {},
): SourceRun {
  const now = o.now ?? Date.now();
  let runId: string | null = null;
  let finished = false;
  const exists = db.prepare('SELECT 1 FROM runs WHERE id = ?').pluck();
  const ctx: ResolveContext = {
    db,
    now,
    source,
    actor: o.actor,
    runId() {
      if (finished) throw new Error(`${source}: the run is already finished`);
      // A run started inside a transaction that later rolled back is gone: start another.
      if (runId && exists.get(runId) === undefined) runId = null;
      runId ??= startRun(db, o.kind ?? 'ingest', { jobRunId: o.jobRunId ?? null, now });
      return runId;
    },
  };
  return {
    ctx,
    get runId() {
      return runId;
    },
    finish(status = 'ok', summary) {
      if (finished) return;
      finished = true;
      if (!runId) return;
      const batches = db.prepare('SELECT count(*) FROM change_batches WHERE run_id = ?').pluck().get(runId) as number;
      if (batches === 0) db.prepare('DELETE FROM runs WHERE id = ?').run(runId);
      else finishRun(db, runId, status, { now, summary: { batches, ...summary } });
    },
  };
}
