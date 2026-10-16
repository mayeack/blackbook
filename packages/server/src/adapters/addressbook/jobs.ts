/**
 * Scheduler job for the address book: `addressbook`, from the collector's CNContactStore export (PLAN "Ingestion →
 * Address book"); never writes to Contacts. It fetches once after each server start and then hourly: the job is
 * checked every 5 minutes, and a check within the hour of the last attempt is 'skipped'. A collector that isn't
 * installed or reachable yet is retried on the next check; a denied Contacts permission marks the source
 * auth_required and waits for the next hourly attempt; contract breaks and other HTTP errors fail the job.
 */
import { CollectorContractError, CollectorHttpError, CollectorUnavailableError } from '../imessage/collectorClient';
import { interval, type JobDef, type JobOutcome } from '../../scheduler/scheduler';
import { recordSourceHealth } from '../common/cursors';
import { nonZeroStats } from '../common/episodes';
import { ContactsClient, type ContactsSource } from './client';
import { ingestAddressBook, SOURCE } from './ingest';

export interface AddressbookJobDeps {
  collectorUrl: string;
  collectorTokenFile: string;
  /** Tests inject a client bound to a MockAgent. */
  client?: ContactsSource;
}

export const ADDRESSBOOK_CHECK_MS = 5 * 60_000;
export const ADDRESSBOOK_EVERY_MS = 60 * 60_000;

export function addressbookJobs(deps: AddressbookJobDeps): JobDef[] {
  const client = deps.client ?? new ContactsClient({ baseUrl: deps.collectorUrl, tokenFile: deps.collectorTokenFile });
  // In-process on purpose: the first check after a (re)start always fetches.
  let lastAttemptAt: number | null = null;
  return [
    {
      name: 'addressbook',
      schedule: interval(ADDRESSBOOK_CHECK_MS),
      leaseMs: 10 * 60_000,
      async run(ctx): Promise<JobOutcome> {
        const now = ctx.now();
        if (lastAttemptAt !== null && now - lastAttemptAt < ADDRESSBOOK_EVERY_MS) return { status: 'skipped' };
        lastAttemptAt = now;
        try {
          const stats = await ingestAddressBook(ctx.db, client, { now, jobRunId: ctx.jobRunId });
          return { stats: nonZeroStats(stats) };
        } catch (e) {
          const at = ctx.now();
          if (e instanceof CollectorUnavailableError) {
            lastAttemptAt = null;
            recordSourceHealth(ctx.db, SOURCE, at, e.reason === 'token_missing' ? 'auth_required' : 'error', { error: e.message, newestDataAt: null });
            return { status: 'skipped', stats: { collector_unavailable: 1 } };
          }
          if (e instanceof CollectorHttpError && (e.code === 'contacts_denied' || e.status === 401 || e.status === 403)) {
            recordSourceHealth(ctx.db, SOURCE, at, 'auth_required', { error: e.code, newestDataAt: null });
            return { status: 'skipped', stats: { contacts_denied: 1 } };
          }
          if (e instanceof CollectorContractError) recordSourceHealth(ctx.db, SOURCE, at, 'contract_broken', { error: e.message, newestDataAt: null });
          else if (e instanceof CollectorHttpError) recordSourceHealth(ctx.db, SOURCE, at, 'error', { error: e.code, newestDataAt: null });
          throw e;
        }
      },
    },
  ];
}
