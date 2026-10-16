/**
 * THE job registration list. Add new jobs here (one entry per job; cadences per PLAN.md "Schedule").
 */
import path from 'node:path';
import { COLLECTOR_DEFAULT_URL } from '@yb/shared/collector/v1';
import { imessageJobs } from '../../adapters/imessage/jobs';
import type { AppConfig } from '../../config';
import { dailyBackup } from '../../db/backup';
import { pruneLogs } from '../../ops/logger';
import { daily, type JobDef } from '../scheduler';

export interface JobDeps {
  config: Pick<AppConfig, 'backupDir' | 'logDir'> & Partial<Pick<AppConfig, 'dataDir' | 'collectorUrl' | 'collectorTokenFile'>>;
  timeZone?: string;
}

export function buildJobs(deps: JobDeps): JobDef[] {
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
    ...imessageIngestJobs(deps),
  ];
}

/** imessage-tail (10 s) + imessage-overlap (02:30). They need the collector token path, so callers that only pass
 * backup/log paths (tests) get no iMessage jobs. */
function imessageIngestJobs(deps: JobDeps): JobDef[] {
  const c = deps.config;
  const tokenFile = c.collectorTokenFile ?? (c.dataDir ? path.join(c.dataDir, 'collector.token') : undefined);
  if (!tokenFile) return [];
  return imessageJobs({ collectorUrl: c.collectorUrl ?? COLLECTOR_DEFAULT_URL, collectorTokenFile: tokenFile });
}
