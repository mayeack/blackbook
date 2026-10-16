/**
 * Scheduler job for WhatsApp: `whatsapp`, every 30 min (PLAN "Ingestion → WhatsApp"). Asks the collector for a
 * snapshot of WhatsApp for Mac's stores, ingests it (skipped when the collector reports it unchanged and it was
 * ingested to the end) and records source_health:
 *   disabled         the app or its container is absent, or it was never linked ("Link WhatsApp for Mac"); no error;
 *   contract_broken  the collector's response or the store's schema changed (the job fails, nothing is written);
 *   stale            WhatsApp for Mac isn't running, or its newest message is more than 72 h old while it runs
 *                    (the phone hasn't been opened: linked devices are logged out after ~14 days);
 *   error / auth_required  the collector is unreachable, has no token or no Full Disk Access.
 */
import { recordSourceHealth, type HealthUpdate, type SourceHealthStatus } from '../common/cursors';
import type { DB } from '../../db/connection';
import { interval, type JobDef, type JobOutcome } from '../../scheduler/scheduler';
import { ingestSnapshot, snapshotIngested, SOURCE } from './ingest';
import { SnapshotReaderError } from './reader';
import {
  CollectorContractError,
  CollectorHttpError,
  CollectorUnavailableError,
  WhatsAppCollector,
  type WhatsAppCollectorApi,
} from './snapshot';

export interface WhatsappJobDeps {
  collectorUrl: string;
  collectorTokenFile: string;
  /** Tests inject a fake collector. */
  client?: WhatsAppCollectorApi;
}

const HOUR = 3_600_000;
export const STALE_AFTER_MS = 72 * HOUR;
export const EVERY_MS = 30 * 60_000;

export const HEALTH_MESSAGES = {
  notLinked: 'Link WhatsApp for Mac',
  notRunning: 'Open WhatsApp for Mac (it has to keep running to receive messages)',
  stale: 'Open WhatsApp on your phone (linked devices log out after ~14 days)',
} as const;

/** The store's schema no longer has a column the reader uses; names only (schema, never data). */
export class WhatsAppSchemaError extends Error {
  constructor(readonly missing: string[]) {
    super(`WhatsApp store schema changed: missing ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ', …' : ''}`);
    this.name = 'WhatsAppSchemaError';
  }
}

const health = (db: DB, now: number, status: SourceHealthStatus, o: HealthUpdate = {}) => recordSourceHealth(db, SOURCE, now, status, o);

export interface WhatsappPassOptions {
  now: number;
  jobRunId?: number | null;
  signal?: AbortSignal;
}

/** One `whatsapp` job pass. */
export async function runWhatsapp(db: DB, client: WhatsAppCollectorApi, o: WhatsappPassOptions): Promise<JobOutcome> {
  let snap;
  try {
    snap = await client.snapshot({});
  } catch (e) {
    if (e instanceof CollectorHttpError && e.code === 'whatsapp_not_installed') {
      health(db, o.now, 'disabled', { error: HEALTH_MESSAGES.notLinked });
      return { status: 'skipped', stats: { not_installed: 1 } };
    }
    if (e instanceof CollectorUnavailableError) {
      health(db, o.now, e.reason === 'token_missing' ? 'auth_required' : 'error', { error: e.message });
      return { status: 'skipped', stats: { collector_unavailable: 1 } };
    }
    // WhatsApp wrote during every copy attempt: transient, the next pass retries.
    if (e instanceof CollectorHttpError && e.code === 'snapshot_inconsistent') {
      health(db, o.now, 'error', { error: e.message });
      return { status: 'skipped', stats: { snapshot_inconsistent: 1 } };
    }
    if (e instanceof CollectorContractError) health(db, o.now, 'contract_broken', { error: e.message });
    else if (e instanceof CollectorHttpError) health(db, o.now, e.status === 401 ? 'auth_required' : 'error', { error: e.message });
    throw e;
  }
  // Running state only refines the freshness verdict: a failed health call leaves it unknown.
  const running = await client.health().then(
    (h) => h.whatsapp.running,
    () => null,
  );

  let stats: Record<string, number> = { unchanged: 1 };
  let details: Record<string, number> | null = null;
  let partial = false;
  if (!(snap.unchanged && snapshotIngested(db, snap.source_mtime))) {
    let out;
    try {
      out = await ingestSnapshot(db, snap.files, { now: o.now, jobRunId: o.jobRunId, signal: o.signal, sourceMtime: snap.source_mtime });
    } catch (e) {
      health(db, o.now, 'error', { error: e instanceof SnapshotReaderError ? e.message : `ingest failed (${(e as Error).name})` });
      throw e;
    }
    if (out.status === 'not_linked') {
      health(db, o.now, 'disabled', { error: HEALTH_MESSAGES.notLinked });
      return { status: 'skipped', stats: { not_linked: 1 } };
    }
    if (out.status === 'contract_broken') {
      const err = new WhatsAppSchemaError(out.missing);
      health(db, o.now, 'contract_broken', { error: err.message });
      throw err;
    }
    ({ stats, details } = out);
    partial = out.status === 'partial';
  }

  const newest = (db.prepare('SELECT max(sent_at) FROM messages WHERE source = ?').pluck().get(SOURCE) as number | null) ?? null;
  // An unchanged snapshot keeps the counts of the pass that read it.
  const card: HealthUpdate = { newestDataAt: newest, details: details ? { ...details, app_running: running } : null };
  if (running === false) health(db, o.now, 'stale', { ...card, error: HEALTH_MESSAGES.notRunning });
  else if (newest !== null && o.now - newest > STALE_AFTER_MS) health(db, o.now, 'stale', { ...card, error: HEALTH_MESSAGES.stale });
  else health(db, o.now, 'ok', card);
  return { status: partial ? 'partial' : 'ok', stats };
}

export function whatsappJobs(deps: WhatsappJobDeps): JobDef[] {
  const client = deps.client ?? new WhatsAppCollector({ baseUrl: deps.collectorUrl, tokenFile: deps.collectorTokenFile });
  return [
    {
      name: 'whatsapp',
      schedule: interval(EVERY_MS),
      // A first backfill of a large store can take a while; the scheduler heartbeat keeps the lease fresh.
      leaseMs: 30 * 60_000,
      run: (ctx) => runWhatsapp(ctx.db, client, { now: ctx.now(), jobRunId: ctx.jobRunId, signal: ctx.signal }),
    },
  ];
}
