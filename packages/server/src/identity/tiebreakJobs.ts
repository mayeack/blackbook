/**
 * Scheduler job for the LLM identity tie-break (identity/tiebreak.ts): `identity-tiebreak`, nightly at 02:50,
 * right after the 02:45 `identity-match` scored tonight's pairs and before the 03:00 occasions pass. Registered only
 * with an API key (agent `llm` deps); still a no-op when Claude is turned off or the budget is spent. Exclusive, so
 * it never overlaps the matcher, the backup or another nightly stage.
 */
import { daily, type JobDef } from '../scheduler/scheduler';
import { jobServices, type AgentJobDeps } from '../scheduler/timetable';
import { resolveServices } from '../services';
import { runTiebreaks } from './tiebreak';

export const IDENTITY_TIEBREAK_AT = '02:50';

const nonZero = (o: object): Record<string, number> =>
  Object.fromEntries(Object.entries(o).filter((e): e is [string, number] => typeof e[1] === 'number' && e[1] !== 0));

export function tiebreakJobs(deps: AgentJobDeps): JobDef[] {
  return [
    {
      name: 'identity-tiebreak',
      schedule: daily(IDENTITY_TIEBREAK_AT),
      exclusive: true,
      leaseMs: 20 * 60_000,
      async run(ctx) {
        const { llm, egress } = resolveServices(jobServices(deps, ctx.db));
        if (!llm.configured) return { status: 'skipped' };
        const r = await runTiebreaks(ctx.db, { llm, egress }, { now: ctx.now(), jobRunId: ctx.jobRunId, log: ctx.log, signal: ctx.signal });
        return { status: r.status, stats: nonZero(r.stats) };
      },
    },
  ];
}
