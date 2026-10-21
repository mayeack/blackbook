/**
 * Scheduler job for the Mac's call log: `calls`, every 5 minutes from the collector's GET /v1/calls. A collector
 * that isn't installed or reachable yet is retried on the next tick; one built before the calls route existed
 * answers 404 not_found and is reported as needing an update (skipped, not failed); a missing Full Disk Access
 * marks the source auth_required; no call log on this Mac marks it disabled. Contract breaks and other HTTP errors
 * fail the job.
 */
import { CollectorClient, CollectorContractError, CollectorHttpError, CollectorUnavailableError } from '../imessage/collectorClient';
import { interval, type JobDef, type JobOutcome } from '../../scheduler/scheduler';
import { recordSourceHealth } from '../common/cursors';
import { nonZeroStats } from '../common/episodes';
import { ingestCalls, SOURCE, type CallsSource } from './ingest';

export interface CallsJobDeps {
  collectorUrl: string;
  collectorTokenFile: string;
  /** Tests inject a client bound to a MockAgent. */
  client?: CallsSource;
}

export const CALLS_EVERY_MS = 5 * 60_000;

export function callsJobs(deps: CallsJobDeps): JobDef[] {
  const client = deps.client ?? new CollectorClient({ baseUrl: deps.collectorUrl, tokenFile: deps.collectorTokenFile });
  return [
    {
      name: 'calls',
      schedule: interval(CALLS_EVERY_MS),
      leaseMs: 10 * 60_000,
      async run(ctx): Promise<JobOutcome> {
        try {
          const stats = await ingestCalls(ctx.db, client, { now: ctx.now() });
          return { stats: nonZeroStats(stats) };
        } catch (e) {
          const at = ctx.now();
          const health = (status: Parameters<typeof recordSourceHealth>[3], error: string) =>
            recordSourceHealth(ctx.db, SOURCE, at, status, { error, newestDataAt: null });
          if (e instanceof CollectorUnavailableError) {
            health(e.reason === 'token_missing' ? 'auth_required' : 'error', e.message);
            return { status: 'skipped', stats: { collector_unavailable: 1 } };
          }
          if (e instanceof CollectorHttpError) {
            if (e.code === 'not_found') {
              health('error', 'The Mac helper needs an update to read calls.');
              return { status: 'skipped', stats: { collector_outdated: 1 } };
            }
            if (e.code === 'fda_missing' || e.status === 401 || e.status === 403) {
              health('auth_required', e.code);
              return { status: 'skipped', stats: { access_denied: 1 } };
            }
            if (e.code === 'callhistory_unavailable' && e.status === 404) {
              health('disabled', 'No call history on this Mac.');
              return { status: 'skipped', stats: { no_call_history: 1 } };
            }
            health('error', e.code);
          } else if (e instanceof CollectorContractError) {
            health('contract_broken', e.message);
          }
          throw e;
        }
      },
    },
  ];
}
