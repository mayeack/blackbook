/**
 * THE job registration list. Add new jobs here (one entry per job; cadences per PLAN.md "Schedule").
 * Source jobs are registered only when their configuration is present (sourceJobDeps), so callers that pass only
 * backup/log paths (tests) get none of them.
 */
import path from 'node:path';
import { COLLECTOR_DEFAULT_URL } from '@yb/shared/collector/v1';
import { addressbookJobs, type AddressbookJobDeps } from '../../adapters/addressbook/jobs';
import { beeperJobs, type BeeperJobDeps } from '../../adapters/beeper/jobs';
import { calendarJobs, type CalendarJobDeps } from '../../adapters/calendar/jobs';
import { imessageJobs, type ImessageJobDeps } from '../../adapters/imessage/jobs';
import { instagramDyiJobs, type InstagramDyiJobDeps } from '../../adapters/instagram/jobs';
import { partifulJobs, type PartifulJobDeps } from '../../adapters/partiful/jobs';
import { whatsappJobs, type WhatsappJobDeps } from '../../adapters/whatsapp/jobs';
import type { AppConfig } from '../../config';
import { dailyBackup } from '../../db/backup';
import { matcherJobs, type MatcherJobDeps } from '../../identity/matcherJobs';
import { pruneLogs } from '../../ops/logger';
import { occasionJobs, type OccasionJobDeps } from '../../pipeline/occasions/jobs';
import { daily, type JobDef } from '../scheduler';

type SourceConfigKeys = 'dataDir' | 'collectorUrl' | 'collectorTokenFile' | 'beeper' | 'browserCdpUrl' | 'google' | 'importsDir' | 'secretsKey';

export interface JobDeps {
  config: Pick<AppConfig, 'backupDir' | 'logDir'> & Partial<Pick<AppConfig, SourceConfigKeys>>;
  timeZone?: string;
}

/** Per-source job dependencies; null = that source isn't configured here, so its jobs aren't registered. */
export interface SourceJobDeps {
  imessage: ImessageJobDeps | null;
  whatsapp: WhatsappJobDeps | null;
  addressbook: AddressbookJobDeps | null;
  beeper: BeeperJobDeps | null;
  instagramDyi: InstagramDyiJobDeps | null;
  partiful: PartifulJobDeps | null;
  calendar: CalendarJobDeps | null;
  /** Database-only pipeline jobs (identity matcher, occasions): any server with a data dir. */
  matcher: MatcherJobDeps | null;
  occasions: OccasionJobDeps | null;
}

export function sourceJobDeps(deps: JobDeps): SourceJobDeps {
  const c = deps.config;
  // The collector token path: explicit, or <data dir>/collector.token.
  const tokenFile = c.collectorTokenFile ?? (c.dataDir ? path.join(c.dataDir, 'collector.token') : undefined);
  const collector = tokenFile ? { collectorUrl: c.collectorUrl ?? COLLECTOR_DEFAULT_URL, collectorTokenFile: tokenFile } : null;
  const secretsKey = c.secretsKey ?? null;
  const pipeline = c.dataDir ? { timeZone: deps.timeZone } : null;
  return {
    imessage: collector,
    whatsapp: collector,
    addressbook: collector,
    // The token comes from the environment or the secrets table (which needs SECRETS_KEY).
    beeper: c.beeper && (c.beeper.token || secretsKey) ? { url: c.beeper.url, token: c.beeper.token, secretsKey } : null,
    instagramDyi: c.importsDir ? { importsDir: c.importsDir } : null,
    partiful: c.browserCdpUrl ? { browserCdpUrl: c.browserCdpUrl, secretsKey } : null,
    calendar: c.google && secretsKey ? { google: c.google, secretsKey } : null,
    matcher: pipeline,
    occasions: pipeline,
  };
}

export function buildJobs(deps: JobDeps): JobDef[] {
  const s = sourceJobDeps(deps);
  return [
    {
      name: 'backup',
      schedule: daily('02:15'),
      exclusive: true,
      async run(ctx) {
        const { pruned } = await dailyBackup(ctx.db, deps.config.backupDir, ctx.now(), deps.timeZone);
        return { stats: { pruned: pruned.length } };
      },
    },
    {
      name: 'logs-prune',
      schedule: daily('04:45'),
      run(ctx) {
        return { stats: { removed: pruneLogs(deps.config.logDir, 14, ctx.now()).length } };
      },
    },
    // imessage-tail (10 s) + imessage-overlap (02:30)
    ...(s.imessage ? imessageJobs(s.imessage) : []),
    ...(s.addressbook ? addressbookJobs(s.addressbook) : []),
    ...(s.whatsapp ? whatsappJobs(s.whatsapp) : []),
    ...(s.beeper ? beeperJobs(s.beeper) : []),
    ...(s.instagramDyi ? instagramDyiJobs(s.instagramDyi) : []),
    ...(s.partiful ? partifulJobs(s.partiful) : []),
    ...(s.calendar ? calendarJobs(s.calendar) : []),
    ...(s.matcher ? matcherJobs(s.matcher) : []),
    ...(s.occasions ? occasionJobs(s.occasions) : []),
  ];
}
