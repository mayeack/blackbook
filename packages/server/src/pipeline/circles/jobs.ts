/**
 * Job 'circles' (weekly AGENT_TIMES.circles): seeded Louvain over the co_group / co_attend / close-label graph,
 * Jaccard-stable circle ids, soft membership, naming (LLM through the egress choke point when a key and budget
 * exist, else group-chat / event titles). Journaled through run.ts; the graph aggregation yields the event loop
 * between steps and the pass stops early on ctx.signal.
 */
import { weekly, type JobDef } from '../../scheduler/scheduler';
import { AGENT_TIMES, jobServices, type AgentJobDeps } from '../../scheduler/timetable';
import { resolveServices } from '../../services';
import { runCircles } from './run';

export type CirclesJobDeps = AgentJobDeps;

export function circlesJobs(deps: CirclesJobDeps): JobDef[] {
  return [
    {
      name: 'circles',
      schedule: weekly(AGENT_TIMES.circles.dow, AGENT_TIMES.circles.at),
      exclusive: true,
      leaseMs: 30 * 60_000,
      async run(ctx) {
        const { llm, egress } = resolveServices(jobServices(deps, ctx.db));
        const r = await runCircles(ctx.db, { now: ctx.now(), signal: ctx.signal, jobRunId: ctx.jobRunId, llm, egress, log: ctx.log });
        const stats = Object.fromEntries(Object.entries(r.stats).filter(([, v]) => v !== 0));
        return { status: r.complete ? 'ok' : 'partial', stats };
      },
    },
  ];
}
