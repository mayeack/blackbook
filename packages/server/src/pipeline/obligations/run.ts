/**
 * Runs the obligations passes: reply debts (closers, then candidates) and commitments (wake, auto-close, due,
 * lapse). Each pass is a generator of small synchronous steps (one debt / conversation / commitment, its writes in
 * one transaction); the async runner hands the event loop back every SLICE_MS so the 10 s iMessage tail and the
 * API stay responsive, and stops between steps when the signal aborts (the run closes 'partial').
 * One journal run per pass, created on the first write (an idle pass leaves none behind).
 */
import { sourceRun } from '../../adapters/common/context';
import type { DB } from '../../db/connection';
import type { RunKind } from '../../journal/runs';
import { commitmentSteps, emptyCommitmentStats, type CommitmentPassStats } from './commitments';
import { SLICE_MS } from './constants';
import { emptyDebtStats, replyDebtSteps, type DebtPassStats } from './replyDebt';

export interface PassOptions {
  now?: number;
  jobRunId?: number | null;
  signal?: AbortSignal;
  /** 'system' (hourly, default) or 'nightly' (the 07:00 pass). */
  runKind?: RunKind;
  sliceMs?: number;
}

export interface PassResult<S> {
  stats: S;
  complete: boolean;
  runId: string | null;
}

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

async function drain<S>(
  db: DB,
  source: string,
  o: PassOptions,
  stats: S,
  steps: (c: { db: DB; now: number; runId: () => string }, stats: S) => Generator<void>,
): Promise<PassResult<S>> {
  const now = o.now ?? Date.now();
  const run = sourceRun(db, source, { now, jobRunId: o.jobRunId ?? null, kind: o.runKind ?? 'system', actor: 'agent' });
  const slice = o.sliceMs ?? SLICE_MS;
  let complete = true;
  try {
    let started = Date.now();
    for (const _ of steps({ db, now, runId: run.ctx.runId }, stats)) {
      if (o.signal?.aborted) {
        complete = false;
        break;
      }
      if (Date.now() - started >= slice) {
        await yieldToLoop();
        started = Date.now();
      }
    }
  } catch (e) {
    run.finish('error');
    throw e;
  }
  const runId = run.runId;
  run.finish(complete ? 'ok' : 'partial', stats as Record<string, unknown>);
  return { stats, complete, runId };
}

/** Synchronous drain (tests, the admin socket): every step at once. */
function drainSync<S>(db: DB, source: string, o: PassOptions, stats: S, steps: (c: { db: DB; now: number; runId: () => string }, stats: S) => Generator<void>): PassResult<S> {
  const now = o.now ?? Date.now();
  const run = sourceRun(db, source, { now, jobRunId: o.jobRunId ?? null, kind: o.runKind ?? 'system', actor: 'agent' });
  try {
    for (const _ of steps({ db, now, runId: run.ctx.runId }, stats)) void _;
  } catch (e) {
    run.finish('error');
    throw e;
  }
  const runId = run.runId;
  run.finish('ok', stats as Record<string, unknown>);
  return { stats, complete: true, runId };
}

export const runReplyDebtsAsync = (db: DB, o: PassOptions = {}): Promise<PassResult<DebtPassStats>> => drain(db, 'reply-debt', o, emptyDebtStats(), replyDebtSteps);
export const runReplyDebts = (db: DB, o: PassOptions = {}): PassResult<DebtPassStats> => drainSync(db, 'reply-debt', o, emptyDebtStats(), replyDebtSteps);

export const runCommitmentsAsync = (db: DB, o: PassOptions = {}): Promise<PassResult<CommitmentPassStats>> =>
  drain(db, 'commitments', o, emptyCommitmentStats(), commitmentSteps);
export const runCommitments = (db: DB, o: PassOptions = {}): PassResult<CommitmentPassStats> =>
  drainSync(db, 'commitments', o, emptyCommitmentStats(), commitmentSteps);
