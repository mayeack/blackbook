/**
 * Scheduler job for Beeper Desktop, Instagram network only: `beeper-instagram`, every 30 min (PLAN "Ingestion →
 * Instagram"). GET-only toward Beeper (client.ts). The token: BEEPER_TOKEN from the environment bootstraps it and
 * is kept AES-GCM encrypted in the secrets table ('beeper.token') when SECRETS_KEY is set, so a later run without
 * the env line still works. Beeper Desktop not running → 'skipped' (retried next interval); a rejected token →
 * auth_required on the Sources screen. Never logs the token.
 */
import type { DB } from '../../db/connection';
import { getSecret, setSecret } from '../../security/secrets';
import { interval, type JobDef, type JobOutcome } from '../../scheduler/scheduler';
import { recordSourceHealth } from '../common/cursors';
import { BeeperClient, BeeperContractError, BeeperHttpError, BeeperUnavailableError } from './client';
import { ingestBeeperInstagram, type BeeperIngestOptions } from './ingest';
import { SOURCE } from './mapping';

export const BEEPER_TOKEN_SECRET = 'beeper.token';

export interface BeeperJobDeps {
  /** Beeper Desktop API base URL (loopback). */
  url: string;
  /** Bootstrap token from the environment; the adapter keeps its token in the secrets table. Never log it. */
  token: string | null;
  secretsKey: Buffer | null;
  /** Tests inject a client (bound to a MockAgent); it then supplies its own token. */
  client?: BeeperClient;
  /** Pass bounds (tests). */
  options?: Pick<BeeperIngestOptions, 'maxRequests' | 'maxPagesPerChat' | 'maxChats'>;
}

/** The token to use: the env token (saved to secrets when it is new), else the stored one. */
export function resolveBeeperToken(db: DB, deps: Pick<BeeperJobDeps, 'token' | 'secretsKey'>, now = Date.now()): string | null {
  let stored: string | null = null;
  if (deps.secretsKey) {
    try {
      stored = getSecret(db, deps.secretsKey, BEEPER_TOKEN_SECRET);
    } catch {
      stored = null; // undecryptable (SECRETS_KEY changed): the env token, if any, replaces it below
    }
  }
  if (deps.token) {
    if (deps.secretsKey && stored !== deps.token) setSecret(db, deps.secretsKey, BEEPER_TOKEN_SECRET, deps.token, now);
    return deps.token;
  }
  return stored;
}

export function beeperJobs(deps: BeeperJobDeps): JobDef[] {
  return [
    {
      name: 'beeper-instagram',
      schedule: interval(30 * 60_000),
      leaseMs: 25 * 60_000,
      async run(ctx): Promise<JobOutcome> {
        const now = ctx.now();
        let client = deps.client;
        if (!client) {
          const token = resolveBeeperToken(ctx.db, deps, now);
          if (!token) {
            recordSourceHealth(ctx.db, SOURCE, now, 'auth_required', {
              error: 'No Beeper token: create one in Beeper Desktop (Settings → Developers) and set BEEPER_TOKEN.',
            });
            return { status: 'skipped', stats: { no_token: 1 } };
          }
          client = new BeeperClient({ baseUrl: deps.url, token });
        }
        try {
          const stats = await ingestBeeperInstagram(ctx.db, client, { now, jobRunId: ctx.jobRunId, signal: ctx.signal, ...deps.options });
          return { stats: Object.fromEntries(Object.entries(stats).filter(([, v]) => v !== 0)) };
        } catch (e) {
          if (e instanceof BeeperUnavailableError) {
            recordSourceHealth(ctx.db, SOURCE, now, 'error', { error: 'Beeper Desktop is not running, or its API is turned off (Settings → Developers).' });
            return { status: 'skipped', stats: { beeper_unavailable: 1 } };
          }
          if (e instanceof BeeperHttpError && (e.status === 401 || e.status === 403)) {
            recordSourceHealth(ctx.db, SOURCE, now, 'auth_required', { error: 'Beeper Desktop rejected the API token: create a new one and update BEEPER_TOKEN.' });
            return { status: 'skipped', stats: { beeper_unauthorized: 1 } };
          }
          if (e instanceof BeeperContractError) recordSourceHealth(ctx.db, SOURCE, now, 'contract_broken', { error: e.message });
          else if (e instanceof BeeperHttpError) recordSourceHealth(ctx.db, SOURCE, now, 'error', { error: e.message });
          throw e;
        } finally {
          if (!deps.client) await client.close();
        }
      },
    },
  ];
}
