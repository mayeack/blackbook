/**
 * Job `commands` (every AGENT_TIMES.commandsTickMs = 10 s, right behind the 10 s imessage-tail that stages
 * self-thread rows): runs the two-way texting executor when there is work (pending rows, an expiring
 * clarification, an unrecorded tapback, an unsent reply), else answers 'skipped' at once. The executor yields the
 * event loop between commands and stops early on ctx.signal. `runCommandsNow` is the same pass for callers that
 * want it straight after an ingest (the hook the iMessage job runner may call).
 */
import { interval, type JobDef } from '../scheduler/scheduler';
import { AGENT_TIMES, type AgentJobDeps } from '../scheduler/timetable';
import type { DB } from '../db/connection';
import { commandsWork, processCommands, type CommandsStats } from './executor';

export type CommandsJobDeps = AgentJobDeps;

const toStats = (s: CommandsStats): Record<string, number> => Object.fromEntries(Object.entries(s).filter(([, v]) => v !== 0));

export function runCommandsNow(db: DB, deps: CommandsJobDeps, o: { now?: () => number; signal?: AbortSignal; jobRunId?: number | null } = {}): Promise<CommandsStats> {
  return processCommands(db, { services: deps.services, config: deps.config, log: deps.log, now: o.now, signal: o.signal, jobRunId: o.jobRunId ?? null });
}

export function commandsJobs(deps: CommandsJobDeps): JobDef[] {
  return [
    {
      name: 'commands',
      schedule: interval(AGENT_TIMES.commandsTickMs),
      leaseMs: 5 * 60_000,
      async run(ctx) {
        if (!commandsWork(ctx.db, ctx.now())) return { status: 'skipped' };
        const stats = await runCommandsNow(ctx.db, deps, { now: () => ctx.now(), signal: ctx.signal, jobRunId: ctx.jobRunId });
        return { stats: toStats(stats) };
      },
    },
  ];
}
