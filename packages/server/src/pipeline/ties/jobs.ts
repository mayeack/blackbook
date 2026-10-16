/**
 * Job 'ties' (daily AGENT_TIMES.ties, after the graph and before obligations/intel/suggestions): person_touch_days,
 * person_stats, weekly tie_stats_snapshot rows, fading/cooling/dormant states (run.ts). Database-only and LLM-free.
 * The pass yields the event loop between chunks (the 10 s iMessage tail stays responsive) and stops early on
 * ctx.signal ('partial'; the next run recomputes everything anyway).
 */
import { daily, type JobDef } from '../../scheduler/scheduler';
import { AGENT_TIMES, type AgentJobDeps } from '../../scheduler/timetable';
import { runTiesAsync } from './run';

export type TiesJobDeps = AgentJobDeps;

export function tiesJobs(_deps: TiesJobDeps): JobDef[] {
  return [
    {
      name: 'ties',
      schedule: daily(AGENT_TIMES.ties),
      exclusive: true,
      leaseMs: 30 * 60_000,
      async run(ctx) {
        const r = await runTiesAsync(ctx.db, { now: ctx.now(), signal: ctx.signal });
        const stats = Object.fromEntries(Object.entries(r.stats).filter(([, v]) => v !== 0));
        return { status: r.complete ? 'ok' : 'partial', stats };
      },
    },
  ];
}
