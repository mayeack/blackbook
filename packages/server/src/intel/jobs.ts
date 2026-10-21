/**
 * Intel jobs (registered by scheduler/jobs/index.ts for any server with a data dir; times in
 * scheduler/timetable.ts AGENT_TIMES where Foundation reserved them):
 *   intel             daily AGENT_TIMES.intel (07:05, after graph 06:50 and ties 06:55, before suggestions 07:16):
 *                     trips + trip people, intro pairs, pending occasion effects (intel/run.ts).
 *   intel-adjudicate  daily 03:20 (after the 03:00 occasions pass and the 03:10 extraction submit): the nightly LLM
 *                     adjudication batch of calendar attendee candidates (intel/adjudicate.ts). Skipped without an
 *                     API key or budget — the deterministic attendees stand. Results come back through the
 *                     llm-collect job (every 5 min), which hands them to the consumer registered here.
 *   intel-effects     every 5 min: re-derives occasion interactions + co_attend edges after adjudicated attendees
 *                     changed (cheap no-op otherwise), so the 06:50/06:55 graph and ties passes see them.
 *   pre-event-push    every 15 min: the generic push 3 h before a same-day event with a brief (intel/events.ts).
 *   places-tidy       daily 03:05 (before the 03:10 extraction submit, so tonight's packets show place names): the
 *                     agent's place facts written as place names, non-places closed (intel/placeTidy.ts).
 *   places-tidy-owner MANUAL ONLY (`yb run-job places-tidy-owner`, once the owner agreed): the same for the facts
 *                     and Places collections the owner entered. Scheduled ticks are no-ops.
 * Long passes yield the event loop between chunks and stop early on ctx.signal.
 */
import { daily, interval, type JobDef } from '../scheduler/scheduler';
import { AGENT_TIMES, jobServices, type AgentJobDeps } from '../scheduler/timetable';
import { resolveServices } from '../services';
import { pushSenderFor } from '../delivery/pushResolve';
import { ADJUDICATE_AT, registerAdjudicationConsumer, submitAdjudications } from './adjudicate';
import { preEventPushTick } from './events';
import { tidyPlaces, type PlaceTidyStats } from './placeTidy';
import { deriveEffectsIfDirty, runIntel } from './run';

export type IntelJobDeps = AgentJobDeps;

const MIN = 60_000;
export const INTEL_TIMES = { intel: AGENT_TIMES.intel, adjudicate: ADJUDICATE_AT, effectsEveryMs: 5 * MIN, preEventPushEveryMs: 15 * MIN, placesTidy: '03:05' } as const;

const counts = (o: Record<string, unknown>): Record<string, number> =>
  Object.fromEntries(Object.entries(o).filter((e): e is [string, number] => typeof e[1] === 'number' && e[1] !== 0));
const tidyResult = (s: PlaceTidyStats) => (s.batchId ? { stats: counts({ ...s }) } : { status: 'skipped' as const, stats: counts({ ...s }) });

export function intelJobs(deps: IntelJobDeps): JobDef[] {
  // The llm-collect job (same process) hands adjudication results to this consumer.
  registerAdjudicationConsumer();
  return [
    {
      name: 'intel',
      schedule: daily(INTEL_TIMES.intel),
      // Exclusive: the 07:16 ranking never reads trips or intro pairs mid-rebuild.
      exclusive: true,
      leaseMs: 30 * MIN,
      async run(ctx) {
        const r = await runIntel(ctx.db, { now: ctx.now(), signal: ctx.signal, log: ctx.log });
        return { status: r.complete ? 'ok' : 'partial', stats: counts(r.stats) };
      },
    },
    {
      name: 'intel-adjudicate',
      schedule: daily(INTEL_TIMES.adjudicate),
      exclusive: true,
      leaseMs: 30 * MIN,
      async run(ctx) {
        const { llm, egress } = resolveServices(jobServices(deps, ctx.db));
        if (!llm.configured) return { status: 'skipped' };
        const r = await submitAdjudications(ctx.db, { llm, egress }, { now: ctx.now(), jobRunId: ctx.jobRunId, log: ctx.log, signal: ctx.signal });
        return { status: r.status, stats: counts(r.stats) };
      },
    },
    {
      name: 'intel-effects',
      schedule: interval(INTEL_TIMES.effectsEveryMs),
      run(ctx) {
        const s = deriveEffectsIfDirty(ctx.db, ctx.now());
        return s ? { stats: counts(s) } : { status: 'skipped' };
      },
    },
    {
      name: 'pre-event-push',
      schedule: interval(INTEL_TIMES.preEventPushEveryMs),
      async run(ctx) {
        const push = pushSenderFor(jobServices(deps, ctx.db));
        const r = await preEventPushTick(ctx.db, push, { now: ctx.now(), log: ctx.log });
        return r.status === 'skipped' ? { status: 'skipped' } : { stats: counts({ considered: r.considered, pushed: r.pushed, devices: r.devices }) };
      },
    },
    {
      name: 'places-tidy',
      schedule: daily(INTEL_TIMES.placesTidy),
      run(ctx) {
        return tidyResult(tidyPlaces(ctx.db, { now: ctx.now(), jobRunId: ctx.jobRunId }));
      },
    },
    {
      name: 'places-tidy-owner',
      schedule: interval(24 * 60 * MIN),
      run(ctx) {
        if (ctx.trigger !== 'manual') return { status: 'skipped' };
        return tidyResult(tidyPlaces(ctx.db, { now: ctx.now(), owner: true, jobRunId: ctx.jobRunId }));
      },
    },
  ];
}
