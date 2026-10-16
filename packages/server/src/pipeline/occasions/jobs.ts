/**
 * Scheduler job for calendar occasions (PLAN "Calendar attendee inference": occasion merge, rule classification,
 * deterministic attendee candidates and scoring, co_attend edges). Database-only: `occasions` runs daily at 03:00,
 * after the Partiful (02:00) and Google Calendar pulls and the 02:30 nightly ingest, and on demand through the
 * admin socket (`run-job occasions`). The pass hands the event loop back between occasions, so the iMessage tail and
 * the API keep running; a scheduler stop ends it early as 'partial'. The LLM adjudication of the candidates is a
 * later stage (packet.ts).
 */
import { daily, type JobDef } from '../../scheduler/scheduler';
import { runOccasionsAsync } from './run';

export interface OccasionJobDeps {
  /** IANA zone for daily times (default: the system zone). */
  timeZone?: string;
}

export function occasionJobs(deps: OccasionJobDeps): JobDef[] {
  return [
    {
      name: 'occasions',
      schedule: daily('03:00'),
      exclusive: true,
      leaseMs: 30 * 60_000,
      async run(ctx) {
        const r = await runOccasionsAsync(ctx.db, { now: ctx.now(), jobRunId: ctx.jobRunId, timeZone: deps.timeZone, signal: ctx.signal });
        const stats = Object.fromEntries(Object.entries(r.stats).filter(([, v]) => v !== 0));
        return { status: r.complete ? 'ok' : 'partial', stats };
      },
    },
  ];
}
