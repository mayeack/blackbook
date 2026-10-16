/**
 * Extraction jobs (registered only with an API key; scheduler/jobs/index.ts):
 *   extract-submit    daily AGENT_TIMES.extractSubmit (after the 02:30 overlap re-read, identity match and
 *                     occasions): tonight's steady windows → one Message Batch (wave 1).
 *   extract-collect   every AGENT_TIMES.llmCollectEveryMs: poll → validate → apply; overflow waves 2–4 until
 *                     06:30; requeues; backfill progress. Applied results land before compose (07:30); batches
 *                     still running keep going and apply when they finish (nothing is cancelled).
 *   extract-backfill  MANUAL ONLY (`yb backfill-extract` / `yb run-job extract-backfill`): starts or advances the
 *                     one-time historical backfill from its own budget pool. Scheduled ticks are no-ops, so it
 *                     never starts by itself.
 * Every pass yields the event loop between chunks and stops early on ctx.signal.
 */
import { AGENT_TIMES, jobServices, type AgentJobDeps } from '../scheduler/timetable';
import { daily, interval, type JobContext, type JobDef } from '../scheduler/scheduler';
import { resolveServices } from '../services';
import { collect, startBackfill, submitSteady, type Counts, type ExtractionDeps } from './run';

export type ExtractionJobDeps = AgentJobDeps;

const statsOf = (c: Counts): Record<string, number> => Object.fromEntries(Object.entries(c).filter(([, v]) => typeof v === 'number' && v !== 0));

function depsFor(deps: ExtractionJobDeps, ctx: JobContext): ExtractionDeps {
  const { llm, egress } = resolveServices(jobServices(deps, ctx.db));
  return { db: ctx.db, llm, egress, now: () => ctx.now(), log: ctx.log, signal: ctx.signal, jobRunId: ctx.jobRunId };
}

export function extractionJobs(deps: ExtractionJobDeps): JobDef[] {
  return [
    {
      name: 'extract-submit',
      schedule: daily(AGENT_TIMES.extractSubmit),
      exclusive: true,
      leaseMs: 30 * 60_000,
      async run(ctx) {
        const r = await submitSteady(depsFor(deps, ctx));
        return { status: r.status === 'skipped' ? 'skipped' : r.status, stats: statsOf(r.counts) };
      },
    },
    {
      name: 'extract-collect',
      schedule: interval(AGENT_TIMES.llmCollectEveryMs),
      leaseMs: 30 * 60_000,
      async run(ctx) {
        const r = await collect(depsFor(deps, ctx));
        return { status: r.status, stats: statsOf(r.counts) };
      },
    },
    {
      name: 'extract-backfill',
      schedule: interval(24 * 60 * 60_000),
      leaseMs: 60 * 60_000,
      async run(ctx) {
        if (ctx.trigger !== 'manual') return { status: 'skipped' };
        const r = await startBackfill(depsFor(deps, ctx));
        const stats: Record<string, number> = { ...statsOf(r.counts), spend_cents: Math.round(r.spendUsd * 100), budget_cents: Math.round(r.budgetUsd * 100) };
        for (const [k, v] of Object.entries(r.windows)) stats[`windows_${k}`] = v;
        for (const [k, v] of Object.entries(r.consolidations)) stats[`consolidations_${k}`] = v;
        stats[`state_${r.status}`] = 1;
        return { status: r.status === 'unavailable' ? 'skipped' : 'ok', stats };
      },
    },
  ];
}
