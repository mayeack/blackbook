/**
 * Scheduler jobs for the Gmail ticket source (review amendment "Jobs"; registered by scheduler/jobs/index.ts):
 *   gmail          every 30 min, read-only: list, triage, fetch, clean, refs, counterparties → gmail_messages
 *                  'pending' with clean_text (sync.ts). No LLM. A pass before the owner connected Gmail (no
 *                  gmail.refresh_token) is 'skipped' and the Sources card reads disabled. A revoked or expired grant,
 *                  or a token without the Gmail scope (403 insufficientPermissions), also skips — no failure
 *                  backoff, only a reconnect helps — and flags the card auth_required. The Gmail API not being
 *                  enabled in the GCP project (403 accessNotConfigured) skips with an error card.
 *   ticket-parse   every 30 min (agent LLM group): pending candidates → one ticket_parse Message Batch (parse.ts).
 *                  Skipped without an API key or budget. Building the job list registers the 'ticket_parse' batch
 *                  consumer the llm-collect job hands results to (like intel's adjudication consumer).
 */
import type { DB } from '../../db/connection';
import { interval, type JobContext, type JobDef, type JobOutcome } from '../../scheduler/scheduler';
import { jobServices, type AgentJobDeps } from '../../scheduler/timetable';
import { resolveServices } from '../../services';
import { GoogleApiError, GoogleAuthError, GoogleContractError, connectedClient, isConnected, type FetchLike, type GoogleOAuthConfig, type OAuth2Client } from '../calendar/google';
import { recordSourceHealth } from '../common/cursors';
import { gmailApi, type GmailApi } from './api';
import { registerTicketConsumer, submitTicketParses } from './parse';
import { GMAIL_SOURCE, gmailCounts, isBackfilling, syncGmail } from './sync';

export interface GmailJobDeps {
  secretsKey: Buffer;
  google: GoogleOAuthConfig;
  /** Tests pass a fetch bound to an undici MockAgent. */
  fetch?: FetchLike;
  /** Tests may replace the API wrapper. */
  api?: (client: OAuth2Client) => GmailApi;
}

const MIN = 60_000;
export const GMAIL_INTERVAL_MS = 30 * MIN;
export const TICKET_PARSE_INTERVAL_MS = 30 * MIN;

const nonZero = (s: object): Record<string, number> =>
  Object.fromEntries(Object.entries(s).filter(([, v]) => typeof v === 'number' && v !== 0)) as Record<string, number>;

const newestData = (db: DB) => (db.prepare(`SELECT max(internal_at) FROM gmail_messages WHERE triage = 'candidate'`).pluck().get() as number | null) ?? null;

/** 403s that only a reconnect (a grant with the Gmail scope) fixes. */
const SCOPE_REASONS = new Set(['insufficientPermissions', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT']);
const NOT_ENABLED = new Set(['accessNotConfigured', 'SERVICE_DISABLED']);

export async function runGmailSync(ctx: JobContext, deps: GmailJobDeps): Promise<JobOutcome> {
  const { db } = ctx;
  const now = ctx.now();
  try {
    // Throws if the stored token can't be decrypted (wrong SECRETS_KEY): recorded as an error below.
    const client = connectedClient(db, deps.secretsKey, deps.google, deps.fetch, 'gmail');
    if (!client) {
      recordSourceHealth(db, GMAIL_SOURCE, now, 'disabled', { error: 'Gmail is not connected.', newestDataAt: null, details: { connected: false } });
      return { status: 'skipped', stats: { not_connected: 1 } };
    }
    const stats = await syncGmail(db, (deps.api ?? gmailApi)(client), { now, signal: ctx.signal, log: ctx.log });
    recordSourceHealth(db, GMAIL_SOURCE, now, 'ok', {
      error: null,
      newestDataAt: newestData(db),
      details: { connected: true, backfilling: isBackfilling(db, now), ...gmailCounts(db) },
    });
    return { status: stats.fetch_failed || stats.budget_cut ? 'partial' : 'ok', stats: nonZero(stats) };
  } catch (e) {
    if (e instanceof GoogleAuthError || (e instanceof GoogleApiError && e.status === 403 && SCOPE_REASONS.has(e.reason))) {
      recordSourceHealth(db, GMAIL_SOURCE, now, 'auth_required', {
        error: 'Gmail access expired, was revoked or lacks read permission: reconnect Gmail in Settings.',
        newestDataAt: null,
        details: { connected: true },
      });
      return { status: 'skipped', stats: { auth_required: 1 } };
    }
    if (e instanceof GoogleApiError && e.status === 403 && NOT_ENABLED.has(e.reason)) {
      recordSourceHealth(db, GMAIL_SOURCE, now, 'error', { error: 'The Gmail API is not enabled in the Google Cloud project.', newestDataAt: null, details: { connected: true } });
      return { status: 'skipped', stats: { api_disabled: 1 } };
    }
    const status = e instanceof GoogleContractError ? 'contract_broken' : 'error';
    recordSourceHealth(db, GMAIL_SOURCE, now, status, { error: (e as Error).message ?? 'sync failed', newestDataAt: null });
    throw e;
  }
}

/** The source job `gmail` (see the header). */
export function gmailJobs(deps: GmailJobDeps): JobDef[] {
  return [
    {
      name: 'gmail',
      schedule: interval(GMAIL_INTERVAL_MS),
      leaseMs: 20 * MIN,
      run: (ctx) => runGmailSync(ctx, deps),
    },
  ];
}

/** The LLM job `ticket-parse` (see the header); registers the 'ticket_parse' batch consumer. */
export function ticketParseJobs(deps: AgentJobDeps): JobDef[] {
  // The llm-collect job (same process) hands ticket-parse results to this consumer.
  registerTicketConsumer();
  return [
    {
      name: 'ticket-parse',
      schedule: interval(TICKET_PARSE_INTERVAL_MS),
      leaseMs: 20 * MIN,
      async run(ctx) {
        // Disconnected (without deleting the data): the masked excerpts wait for a reconnect and never go out.
        if (!isConnected(ctx.db, 'gmail')) return { status: 'skipped', stats: { not_connected: 1 } };
        const { llm, egress } = resolveServices(jobServices(deps, ctx.db));
        if (!llm.configured) return { status: 'skipped' };
        const r = await submitTicketParses(ctx.db, { llm, egress }, { now: ctx.now(), jobRunId: ctx.jobRunId, log: ctx.log, signal: ctx.signal });
        return { status: r.status, stats: nonZero(r.stats) };
      },
    },
  ];
}
