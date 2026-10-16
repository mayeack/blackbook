/**
 * Scheduler jobs for iMessage: `imessage-tail` (10 s) and `imessage-overlap` (daily 02:30, the first stage of the
 * nightly run, registered on its own for now). A collector that isn't installed or reachable yet makes a tail pass
 * 'skipped' (retried on the next tick, no failure backoff); contract breaks and HTTP errors fail the job.
 */
import { daily, interval, type JobContext, type JobDef, type JobOutcome } from '../../scheduler/scheduler';
import { CollectorClient, CollectorContractError, CollectorHttpError, CollectorUnavailableError } from './collectorClient';
import { ingestOverlap, ingestTail, recordSourceHealth, type IngestStats } from './ingest';

export interface ImessageJobDeps {
  collectorUrl: string;
  collectorTokenFile: string;
  /** Tests inject a client bound to a MockAgent. */
  client?: CollectorClient;
}

const toStats = (s: IngestStats): Record<string, number> => Object.fromEntries(Object.entries(s).filter(([, v]) => v !== 0));

/** skipWhenUnavailable: the 10 s tail just tries again; the daily overlap fails so it retries (with backoff) today. */
async function guarded(ctx: JobContext, skipWhenUnavailable: boolean, pass: () => Promise<IngestStats>): Promise<JobOutcome> {
  try {
    const stats = await pass();
    recordSourceHealth(ctx.db, ctx.now(), 'ok');
    return { stats: toStats(stats) };
  } catch (e) {
    if (e instanceof CollectorUnavailableError) {
      recordSourceHealth(ctx.db, ctx.now(), e.reason === 'token_missing' ? 'auth_required' : 'error', e.message);
      if (skipWhenUnavailable) return { status: 'skipped', stats: { collector_unavailable: 1 } };
      throw e;
    }
    if (e instanceof CollectorContractError) recordSourceHealth(ctx.db, ctx.now(), 'contract_broken', e.message);
    else if (e instanceof CollectorHttpError) recordSourceHealth(ctx.db, ctx.now(), e.status === 401 ? 'auth_required' : 'error', e.message);
    throw e;
  }
}

export function imessageJobs(deps: ImessageJobDeps): JobDef[] {
  const client = deps.client ?? new CollectorClient({ baseUrl: deps.collectorUrl, tokenFile: deps.collectorTokenFile });
  return [
    {
      name: 'imessage-tail',
      schedule: interval(10_000),
      leaseMs: 10 * 60_000,
      run: (ctx) => guarded(ctx, true, () => ingestTail(ctx.db, client, { now: ctx.now(), jobRunId: ctx.jobRunId, signal: ctx.signal })),
    },
    {
      name: 'imessage-overlap',
      schedule: daily('02:30'),
      exclusive: true,
      leaseMs: 30 * 60_000,
      run: (ctx) => guarded(ctx, false, () => ingestOverlap(ctx.db, client, { now: ctx.now(), jobRunId: ctx.jobRunId, signal: ctx.signal })),
    },
  ];
}
