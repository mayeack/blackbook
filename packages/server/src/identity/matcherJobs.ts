/**
 * Scheduler job for the probabilistic identity matcher (intelligence §1.5–1.6): `identity-match`, nightly at
 * 02:45 (after the 02:30 overlap re-read, before the rest of the nightly pipeline). Database-only; registered for
 * a server with a data dir. Exclusive, so it never overlaps the backup or other nightly stages.
 */
import { nonZeroStats } from '../adapters/common/episodes';
import { daily, type JobDef } from '../scheduler/scheduler';
import { runMatcher } from './matcher';

export interface MatcherJobDeps {
  /** IANA zone for daily times (default: the system zone). */
  timeZone?: string;
}

export const IDENTITY_MATCH_AT = '02:45';

export function matcherJobs(_deps: MatcherJobDeps): JobDef[] {
  return [
    {
      name: 'identity-match',
      schedule: daily(IDENTITY_MATCH_AT),
      exclusive: true,
      leaseMs: 30 * 60_000,
      run(ctx) {
        const stats = runMatcher(ctx.db, { now: ctx.now(), jobRunId: ctx.jobRunId, signal: ctx.signal });
        return { status: ctx.signal.aborted ? 'partial' : 'ok', stats: nonZeroStats(stats) };
      },
    },
  ];
}
