/**
 * Met-at job (registered by scheduler/jobs/index.ts next to the intel jobs):
 *   met-at   daily AGENT_TIMES.metAt (06:40: after identity-match 02:45 and occasions 03:00, before graph 06:50 and
 *            intel 07:05), exclusive: infers where the owner met new people and writes person_met_at in one nightly
 *            run (intel/metAt/run.ts). No LLM. Stops early on ctx.signal ('partial'); the next night finishes.
 */
import { daily, type JobDef } from '../../scheduler/scheduler';
import { AGENT_TIMES, type AgentJobDeps } from '../../scheduler/timetable';
import { runMetAt } from './run';

const MIN = 60_000;

const nonZero = (o: Record<string, number>): Record<string, number> => Object.fromEntries(Object.entries(o).filter(([, v]) => Number.isFinite(v) && v !== 0));

// deps: the shared agent-job shape (nothing here needs services: no LLM, no push).
export function metAtJobs(deps: AgentJobDeps = {}): JobDef[] {
  void deps;
  return [
    {
      name: 'met-at',
      schedule: daily(AGENT_TIMES.metAt),
      exclusive: true,
      leaseMs: 30 * MIN,
      async run(ctx) {
        const r = await runMetAt(ctx.db, { now: ctx.now(), signal: ctx.signal, log: ctx.log, jobRunId: ctx.jobRunId });
        return { status: r.complete ? 'ok' : 'partial', stats: nonZero(r.counts) };
      },
    },
  ];
}
