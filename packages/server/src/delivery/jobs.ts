/**
 * Delivery jobs (times in scheduler/timetable.ts AGENT_TIMES):
 *   compose      daily AGENT_TIMES.compose (07:30): digest copy for today's ranked items (LLM composer with
 *                grounding, template fallback). Nothing is sent.
 *   digest-send  every AGENT_TIMES.deliveryTickMs: at settings digest.time (DISABLED by default: digest.enabled)
 *                sends the brief to the owner's own handle, pings subscribed devices, emails it to his own Gmail
 *                (digest.email), heartbeats / failure notices, and one generic push per new critical-source alert. Most ticks return after two small queries.
 * Both are short (≤5 items, one LLM call at most) and await network I/O, so the 10 s iMessage tail stays responsive.
 */
import { localDate } from '@yb/shared';
import { daily, interval, type JobDef, type JobOutcome } from '../scheduler/scheduler';
import { AGENT_TIMES, jobServices, type AgentJobDeps } from '../scheduler/timetable';
import { resolveServices } from '../services';
import { settingTimeZone } from '../settings/registry';
import { composeDigest } from './compose';
import { pushSenderFor } from './pushResolve';
import type { SelectDigestItems } from './selection';
import { deliveryTick } from './send';

export type DeliveryJobDeps = AgentJobDeps & {
  /** The ranker's selector (default: the digests / digest_items rows it wrote). */
  select?: SelectDigestItems;
};

export function deliveryJobs(deps: DeliveryJobDeps): JobDef[] {
  return [
    {
      name: 'compose',
      schedule: daily(AGENT_TIMES.compose),
      async run(ctx): Promise<JobOutcome> {
        const services = resolveServices(jobServices(deps, ctx.db));
        const now = ctx.now();
        const composed = await composeDigest(ctx.db, services, {
          localDate: localDate(now, settingTimeZone(ctx.db)),
          now,
          select: deps.select,
          log: ctx.log,
          signal: ctx.signal,
        });
        if (!composed) return { status: 'skipped', stats: { items: 0 } };
        return { stats: { items: composed.items.length, llm_items: composed.items.filter((i) => i.copy === 'llm').length } };
      },
    },
    {
      name: 'digest-send',
      schedule: interval(AGENT_TIMES.deliveryTickMs),
      async run(ctx): Promise<JobOutcome> {
        const base = jobServices(deps, ctx.db);
        const services = resolveServices(base);
        const r = await deliveryTick({
          db: ctx.db,
          services,
          push: pushSenderFor(base),
          now: ctx.now,
          log: ctx.log,
          select: deps.select,
          signal: ctx.signal,
        });
        if ((r.action === 'before_time' || r.action === 'final' || r.action === 'no_digest_yet') && !r.emailed) {
          return { status: 'skipped', stats: { health_pushes: r.healthPushes ?? 0 } };
        }
        return {
          stats: {
            imessage_sent: r.imessage === 'sent' ? 1 : 0,
            push_sent: r.pushed?.sent ?? 0,
            push_removed: r.pushed?.removed ?? 0,
            email_sent: r.emailed ? 1 : 0,
            health_pushes: r.healthPushes ?? 0,
          },
        };
      },
    },
  ];
}
