/**
 * Scheduler job for Google Calendar: `gcal`, every 30 min (PLAN "Schedule"), read-only. Registered once the OAuth
 * client is configured and SECRETS_KEY exists; a pass before the owner has connected (no refresh token in the
 * secrets table) is 'skipped'. A revoked or expired grant also skips (no failure backoff: only a reconnect helps)
 * and flags the Sources card auth_required.
 */
import type { DB } from '../../db/connection';
import { interval, type JobContext, type JobDef, type JobOutcome } from '../../scheduler/scheduler';
import { recordSourceHealth } from '../common/cursors';
import { calendarApi, connectedClient, GoogleAuthError, GoogleContractError, type CalendarApi, type FetchLike, type OAuth2Client } from './google';
import { GCAL_SOURCE, syncCalendars } from './sync';

export interface CalendarJobDeps {
  google: { clientId: string; clientSecret: string; redirectUri: string };
  secretsKey: Buffer;
  /** Tests pass a fetch bound to an undici MockAgent. */
  fetch?: FetchLike;
  /** Tests may replace the API wrapper. */
  api?: (client: OAuth2Client) => CalendarApi;
}

export const GCAL_INTERVAL_MS = 30 * 60_000;

const nonZero = (s: object): Record<string, number> =>
  Object.fromEntries(Object.entries(s).filter(([, v]) => typeof v === 'number' && v !== 0)) as Record<string, number>;

const newestData = (db: DB) => (db.prepare('SELECT max(remote_updated_at) FROM calendar_events').pluck().get() as number | null) ?? null;

export async function runCalendarSync(ctx: JobContext, deps: CalendarJobDeps): Promise<JobOutcome> {
  const { db } = ctx;
  const now = ctx.now();
  try {
    // Throws if the stored token can't be decrypted (wrong SECRETS_KEY): recorded as an error below.
    const client = connectedClient(db, deps.secretsKey, deps.google, deps.fetch);
    if (!client) {
      recordSourceHealth(db, GCAL_SOURCE, now, 'disabled', {
        error: 'Google Calendar is not connected.',
        newestDataAt: null,
        details: { connected: false },
      });
      return { status: 'skipped', stats: { not_connected: 1 } };
    }
    const stats = await syncCalendars(db, (deps.api ?? calendarApi)(client), { now, signal: ctx.signal, log: ctx.log });
    const allFailed = stats.included > 0 && stats.synced === 0 && stats.failed > 0;
    const events = db.prepare('SELECT count(*) FROM calendar_events').pluck().get() as number;
    recordSourceHealth(db, GCAL_SOURCE, now, allFailed ? 'error' : 'ok', {
      error: allFailed ? 'No calendar could be synced.' : null,
      newestDataAt: newestData(db),
      details: { connected: true, calendars: stats.calendars, included: stats.included, failed: stats.failed, events },
    });
    return { status: stats.failed ? 'partial' : 'ok', stats: nonZero(stats) };
  } catch (e) {
    if (e instanceof GoogleAuthError) {
      recordSourceHealth(db, GCAL_SOURCE, now, 'auth_required', {
        error: 'Google sign-in expired or was revoked: reconnect Google Calendar in Settings.',
        newestDataAt: null,
        details: { connected: true },
      });
      return { status: 'skipped', stats: { auth_required: 1 } };
    }
    const status = e instanceof GoogleContractError ? 'contract_broken' : 'error';
    recordSourceHealth(db, GCAL_SOURCE, now, status, { error: (e as Error).message ?? 'sync failed', newestDataAt: null });
    throw e;
  }
}

export function calendarJobs(deps: CalendarJobDeps): JobDef[] {
  return [
    {
      name: 'gcal',
      schedule: interval(GCAL_INTERVAL_MS),
      leaseMs: 20 * 60_000,
      run: (ctx) => runCalendarSync(ctx, deps),
    },
  ];
}
