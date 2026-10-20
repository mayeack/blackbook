/**
 * Scheduler jobs for Partiful (PLAN "Ingestion → Partiful", read-only function allowlist only):
 *   partiful           daily 02:00; a run missed while the Mac slept or the server was down runs on the next tick
 *   partiful-contacts  weekly, Sunday 03:30 (getContacts / getMutuals)
 *   partiful-hosted-guests  every 30 min: guest lists of events I host in the next 15 days (no hosted event → no
 *                      calls), so invite suggestions and the brief check against who is invited right now
 * The session comes from the sandbox browser over CDP and is kept encrypted in the secrets table (session.ts).
 * One auth manager and one rate gate (≤1 call/s) are shared by both jobs; each run gets its own 300-call budget.
 * A failed pass records source_health (auth_required → "Sign in to Partiful in the sandbox browser") and
 * rethrows, so the scheduler retries with backoff (15 min doubling to 1 h) until the owner signs in.
 */
import type { Dispatcher } from 'undici';
import type { DB } from '../../db/connection';
import { daily, interval, weekly, type JobContext, type JobDef, type JobOutcome } from '../../scheduler/scheduler';
import { DEFAULT_MAX_CALLS, DEFAULT_MIN_INTERVAL_MS, PartifulClient, RateGate } from './client';
import { recordPartifulFailure, refreshHostedGuests, syncPartiful, syncPartifulContacts, type SyncLimits, type SyncResult } from './ingest';
import { PartifulAuth, type CdpConnect } from './session';

export interface PartifulJobDeps {
  /** Chrome DevTools endpoint of the sandbox browser (loopback). */
  browserCdpUrl: string;
  secretsKey: Buffer | null;
  /** Tests: a MockAgent for api.partiful.com + securetoken, a fake CDP connector, no 1 s spacing. */
  dispatcher?: Dispatcher;
  connect?: CdpConnect;
  minIntervalMs?: number;
  maxCallsPerRun?: number;
  limits?: Partial<SyncLimits>;
}

export function partifulJobs(deps: PartifulJobDeps): JobDef[] {
  const gate = new RateGate(deps.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS);
  const auths = new WeakMap<DB, PartifulAuth>();
  const authFor = (db: DB) => {
    let a = auths.get(db);
    if (!a) {
      a = new PartifulAuth({ db, secretsKey: deps.secretsKey, cdpUrl: deps.browserCdpUrl, connect: deps.connect, dispatcher: deps.dispatcher });
      auths.set(db, a);
    }
    return a;
  };
  const clientFor = (ctx: JobContext) =>
    new PartifulClient({ auth: authFor(ctx.db), dispatcher: deps.dispatcher, gate, maxCalls: deps.maxCallsPerRun ?? DEFAULT_MAX_CALLS, signal: ctx.signal });

  const guarded = async (ctx: JobContext, pass: (client: PartifulClient) => Promise<SyncResult>): Promise<JobOutcome> => {
    try {
      const r = await pass(clientFor(ctx));
      return { status: r.partial ? 'partial' : 'ok', stats: r.stats };
    } catch (e) {
      if (!ctx.signal.aborted) recordPartifulFailure(ctx.db, ctx.now(), e);
      throw e;
    }
  };
  const opts = (ctx: JobContext) => ({ now: ctx.now(), jobRunId: ctx.jobRunId, signal: ctx.signal, log: ctx.log, limits: deps.limits });

  return [
    {
      name: 'partiful',
      schedule: daily('02:00'),
      leaseMs: 60 * 60_000,
      backoffBaseMs: 15 * 60_000,
      run: (ctx) => guarded(ctx, (client) => syncPartiful(ctx.db, client, opts(ctx))),
    },
    {
      name: 'partiful-contacts',
      schedule: weekly(0, '03:30'),
      leaseMs: 30 * 60_000,
      backoffBaseMs: 30 * 60_000,
      run: (ctx) => guarded(ctx, (client) => syncPartifulContacts(ctx.db, client, opts(ctx))),
    },
    {
      name: 'partiful-hosted-guests',
      schedule: interval(30 * 60_000),
      leaseMs: 10 * 60_000,
      backoffBaseMs: 15 * 60_000,
      run: (ctx) => guarded(ctx, (client) => refreshHostedGuests(ctx.db, client, opts(ctx))),
    },
  ];
}
