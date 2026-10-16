/**
 * Jobs of the suggestions module (registered by scheduler/jobs/index.ts; times in scheduler/timetable.ts):
 *   suggestions  daily AGENT_TIMES.suggestions (after ties, obligations and intel; before compose): a last reply-debt
 *                + commitment pass (late extraction verdicts), then generators → cooldowns/mutes → Thompson-scored
 *                ranking → today's digest row + items (stage.ts). Exclusive, like obligations and intel, so the
 *                ranking never reads loops or trips half-refreshed.
 *   rewards      hourly: implicit "acted" attribution with the counterfactual guard, and "ignored" at the end of
 *                each item's window (rewards.ts)
 * Both are database-only, hand the event loop back between chunks and stop early on ctx.signal. Neither sends
 * anything.
 */
import { daily, interval, type JobDef } from '../../scheduler/scheduler';
import { AGENT_TIMES, type AgentJobDeps } from '../../scheduler/timetable';
import { runCommitmentsAsync, runReplyDebtsAsync } from '../obligations';
import { attributeRewards } from './rewards';
import { runSuggestionsStage } from './stage';

export type SuggestionsJobDeps = AgentJobDeps;

const HOUR = 3_600_000;

export function suggestionsJobs(deps: SuggestionsJobDeps): JobDef[] {
  return [
    {
      name: 'suggestions',
      schedule: daily(AGENT_TIMES.suggestions),
      exclusive: true,
      leaseMs: 20 * 60_000,
      async run(ctx) {
        // Fresh loops first: needs_reply verdicts and promises the extraction applied after the 07:00 obligations pass
        // (overflow waves apply until 07:15) become reply debts / due promises before today's ranking reads them.
        const pass = { now: ctx.now(), jobRunId: ctx.jobRunId, signal: ctx.signal, runKind: 'nightly' as const };
        await runReplyDebtsAsync(ctx.db, pass);
        if (!ctx.signal.aborted) await runCommitmentsAsync(ctx.db, { ...pass, now: ctx.now() });
        const r = await runSuggestionsStage(ctx.db, { now: ctx.now(), jobRunId: ctx.jobRunId, log: deps.log ?? ctx.log, signal: ctx.signal });
        // Stopped before the digest was written: fail so today's slot is retried (a 'partial' would count as done).
        if (r.reason === 'aborted') throw new Error('suggestions stage aborted before ranking finished');
        const stats = Object.fromEntries(Object.entries(r.stats).filter(([, v]) => Number.isFinite(v) && v !== 0));
        return { status: r.status, stats };
      },
    },
    {
      name: 'rewards',
      schedule: interval(HOUR),
      async run(ctx) {
        const r = await attributeRewards(ctx.db, { now: ctx.now(), log: deps.log ?? ctx.log, signal: ctx.signal });
        const stats = Object.fromEntries(Object.entries(r.stats).filter(([, v]) => v !== 0));
        return { status: ctx.signal.aborted ? 'partial' : 'ok', stats };
      },
    },
  ];
}
