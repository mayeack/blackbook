/**
 * Scheduler job for the Instagram "Download your information" importer: `instagram-dyi`, hourly (PLAN "Ingestion →
 * Instagram → DYI importer"). A pass with nothing new (no folder, or only files already imported) is a directory
 * walk plus a few stats and reports 'skipped'. Imports are exclusive (they never overlap the nightly run).
 */
import { interval, type JobDef, type JobOutcome } from '../../scheduler/scheduler';
import { importInstagramDyi } from './dyi';

export interface InstagramDyiJobDeps {
  /** Folder the owner drops export zips into (default ~/Yeackbot Imports). Never written to. */
  importsDir: string;
}

export function instagramDyiJobs(deps: InstagramDyiJobDeps): JobDef[] {
  return [
    {
      name: 'instagram-dyi',
      schedule: interval(60 * 60_000),
      exclusive: true,
      leaseMs: 60 * 60_000,
      async run(ctx): Promise<JobOutcome> {
        const s = await importInstagramDyi(ctx.db, { importsDir: deps.importsDir, now: ctx.now(), jobRunId: ctx.jobRunId, signal: ctx.signal });
        const stats = Object.fromEntries(Object.entries(s).filter(([, v]) => v !== 0));
        const worked = s.files_imported + s.files_failed + s.files_ignored > 0;
        return { status: !worked ? 'skipped' : s.files_failed ? 'partial' : 'ok', stats };
      },
    },
  ];
}
