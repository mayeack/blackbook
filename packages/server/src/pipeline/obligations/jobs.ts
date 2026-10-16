/**
 * Obligations jobs (scheduler/timetable.ts AGENT_TIMES), database-only (no LLM, nothing sent):
 *   reply-debt   hourly  — closers (outbound on any channel, time together, verdicts, 30-day expiry, snooze
 *                          wake-ups), then reply-debt candidates over conversations active in the last 30 days;
 *   commitments  hourly  — wake, auto-close (meet/plan/call/send/reply_later signals), due, lapse;
 *   obligations  07:00   — both passes once more, after the night's extraction apply and before the 07:16
 *                          suggestions stage, so the digest sees fresh loops.
 * Each pass yields the event loop between steps and stops early on ctx.signal ('partial').
 */
import { daily, interval, type JobDef, type JobOutcome } from '../../scheduler/scheduler';
import { AGENT_TIMES, type AgentJobDeps } from '../../scheduler/timetable';
import { runCommitmentsAsync, runReplyDebtsAsync, type PassResult } from './run';

export type ObligationsJobDeps = AgentJobDeps;

const nonZero = (stats: object): Record<string, number> =>
  Object.fromEntries(Object.entries(stats).filter(([, v]) => typeof v === 'number' && v !== 0)) as Record<string, number>;

const outcome = (results: PassResult<object>[], prefix = false): JobOutcome => {
  const stats: Record<string, number> = {};
  results.forEach((r, i) => {
    for (const [k, v] of Object.entries(nonZero(r.stats))) stats[prefix ? `${i === 0 ? 'debt' : 'commit'}_${k}` : k] = v;
  });
  return { status: results.every((r) => r.complete) ? 'ok' : 'partial', stats };
};

export function obligationsJobs(_deps: ObligationsJobDeps): JobDef[] {
  const every = AGENT_TIMES.obligationsEveryMs;
  return [
    {
      name: 'reply-debt',
      schedule: interval(every),
      leaseMs: 15 * 60_000,
      async run(ctx) {
        return outcome([await runReplyDebtsAsync(ctx.db, { now: ctx.now(), jobRunId: ctx.jobRunId, signal: ctx.signal })]);
      },
    },
    {
      name: 'commitments',
      schedule: interval(every),
      leaseMs: 15 * 60_000,
      async run(ctx) {
        return outcome([await runCommitmentsAsync(ctx.db, { now: ctx.now(), jobRunId: ctx.jobRunId, signal: ctx.signal })]);
      },
    },
    {
      name: 'obligations',
      schedule: daily(AGENT_TIMES.obligations),
      // Exclusive: never overlaps the 07:16 ranking (which reads what this pass writes).
      exclusive: true,
      leaseMs: 30 * 60_000,
      async run(ctx) {
        const o = { now: ctx.now(), jobRunId: ctx.jobRunId, signal: ctx.signal, runKind: 'nightly' as const };
        const debts = await runReplyDebtsAsync(ctx.db, o);
        const commits = ctx.signal.aborted ? { stats: {}, complete: false, runId: null } : await runCommitmentsAsync(ctx.db, { ...o, now: ctx.now() });
        return outcome([debts, commits], true);
      },
    },
  ];
}
