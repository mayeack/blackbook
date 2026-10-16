/**
 * Job 'graph' (daily AGENT_TIMES.graph, before ties): edge_evidence (co_group, group_reply, mentioned_together) →
 * edge_stats from every writer's evidence plus relation labels (run.ts). Database-only and LLM-free. The pass hands
 * the event loop back between steps (the 10 s iMessage tail stays responsive) and stops early on ctx.signal.
 */
import { daily, type JobDef } from '../../scheduler/scheduler';
import { AGENT_TIMES, type AgentJobDeps } from '../../scheduler/timetable';
import { runGraphAsync } from './run';

export type GraphJobDeps = AgentJobDeps;

export function graphJobs(_deps: GraphJobDeps): JobDef[] {
  return [
    {
      name: 'graph',
      schedule: daily(AGENT_TIMES.graph),
      exclusive: true,
      leaseMs: 30 * 60_000,
      async run(ctx) {
        const r = await runGraphAsync(ctx.db, { now: ctx.now(), signal: ctx.signal });
        if (!r.complete) return { status: 'partial' };
        return { status: 'ok', stats: Object.fromEntries(Object.entries(r.value).filter(([, v]) => v !== 0)) };
      },
    },
  ];
}
