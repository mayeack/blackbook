/**
 * Event-picks jobs (registered by scheduler/jobs/index.ts next to the intel jobs; design docs/design/event-picks.md):
 *   event-picks            every 10 min: on the picks day (settings events.weekday, default Sunday) from events.time
 *                          (default 18:00) until SEND_UNTIL, finds the week's picks (two web_search calls, one
 *                          newsletter read, his Recurring Events calendar) and emails them (or texts them); a 'ready'
 *                          run that couldn't be sent yet (quiet hours, collector down, Gmail busy) is sent on a later
 *                          tick the same day. Most ticks return after reading three settings. Manual
 *                          `yb run-job event-picks` forces a run.
 *   event-picks-outcomes   daily AGENT_TIMES.eventPickOutcomes: which sent picks he went to (a ticket, calendar entry
 *                          or Partiful RSVP that night) and which nights passed (outcomes.ts). No LLM.
 */
import { settingTimeZone } from '../../settings/registry';
import { daily, interval, type JobDef, type JobOutcome } from '../../scheduler/scheduler';
import { AGENT_TIMES, jobServices, type AgentJobDeps } from '../../scheduler/timetable';
import { resolveServices } from '../../services';
import { updatePickOutcomes } from './outcomes';
import { picksDue, runEventPicks } from './run';

const MIN = 60_000;

export function eventPicksJobs(deps: AgentJobDeps = {}): JobDef[] {
  return [
    {
      name: 'event-picks',
      schedule: interval(AGENT_TIMES.eventPicksTickMs),
      exclusive: true,
      leaseMs: 15 * MIN,
      async run(ctx): Promise<JobOutcome> {
        const now = ctx.now();
        const force = ctx.trigger === 'manual';
        if (!force && !picksDue(ctx.db, now)) return { status: 'skipped', stats: {} };
        const services = resolveServices(jobServices(deps, ctx.db));
        const r = await runEventPicks(
          ctx.db,
          { llm: services.llm, egress: services.egress, outbound: services.outbound, email: services.email, gmail: services.gmail, log: ctx.log, signal: ctx.signal },
          { now, send: true, force },
        );
        if (r.status === 'skipped') return { status: 'skipped', stats: {} };
        // A failed discovery is retried by the run itself (RETRY_AFTER_MS, MAX_ATTEMPTS), not by the scheduler.
        if (r.status === 'failed') return { status: 'partial', stats: { failed: 1, searches: r.searches } };
        if (r.status === 'empty') return { stats: { picks: 0, searches: r.searches } };
        return {
          stats: {
            picks: r.picks,
            found: r.found,
            searches: r.searches,
            newsletters: r.newsletters ?? 0,
            listings: r.listings ?? 0,
            sent: r.status === 'sent' ? 1 : 0,
            emailed: r.channel === 'email' ? 1 : 0,
          },
        };
      },
    },
    {
      name: 'event-picks-outcomes',
      schedule: daily(AGENT_TIMES.eventPickOutcomes),
      async run(ctx) {
        const r = updatePickOutcomes(ctx.db, ctx.now(), settingTimeZone(ctx.db));
        return { stats: { checked: r.checked, going: r.going, passed: r.passed } };
      },
    },
  ];
}
