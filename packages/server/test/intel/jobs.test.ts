import { describe, expect, it } from 'vitest';
import { uuidv7 } from '@yb/shared';
import { createEgress } from '../../src/llm/egress';
import { intelJobs, INTEL_TIMES } from '../../src/intel/jobs';
import { EFFECTS_DIRTY, setFlag } from '../../src/intel/common';
import { allGenerators, allWildcardSources } from '../../src/pipeline/suggestions/registry';
import { AGENT_TIMES } from '../../src/scheduler/timetable';
import { nullLogger } from '../../src/ops/logger';
import type { JobContext, JobDef } from '../../src/scheduler/scheduler';
import type { AgentServices } from '../../src/services';
import { FakeOutboundSender, FakePushSender } from '../fakes/delivery';
import { FakeLlmClient } from '../fakes/llm';
import { at, intelWorld, NOW, occasion, setSetting } from './world';

const ctxFor = (db: JobContext['db'], now = NOW): JobContext => ({ db, jobRunId: 1, trigger: 'manual', now: () => now, log: nullLogger, signal: new AbortController().signal });
const byName = (jobs: JobDef[], name: string) => jobs.find((j) => j.name === name)!;

describe('intel jobs', () => {
  it('registers intel (07:05), intel-adjudicate (03:20), intel-effects (5 min), pre-event-push (15 min) and the place tidies', () => {
    const jobs = intelJobs({});
    expect(jobs.map((j) => j.name)).toEqual(['intel', 'intel-adjudicate', 'intel-effects', 'pre-event-push', 'places-tidy', 'places-tidy-owner']);
    expect(byName(jobs, 'places-tidy').schedule).toEqual({ kind: 'daily', at: '03:05' });
    expect(INTEL_TIMES.placesTidy < AGENT_TIMES.extractSubmit).toBe(true); // tonight's packets already show place names
    expect(byName(jobs, 'intel').schedule).toEqual({ kind: 'daily', at: AGENT_TIMES.intel });
    expect(byName(jobs, 'intel-adjudicate').schedule).toEqual({ kind: 'daily', at: '03:20' });
    expect(INTEL_TIMES.adjudicate > '03:10').toBe(true); // after the occasions pass and the extraction submit
    expect(byName(jobs, 'intel-effects').schedule).toEqual({ kind: 'interval', everyMs: 5 * 60_000 });
    expect(byName(jobs, 'pre-event-push').schedule).toEqual({ kind: 'interval', everyMs: 15 * 60_000 });
  });

  it('the generator registry carries the intel kinds and the intro_pair wildcard', () => {
    const kinds = allGenerators().map((g) => g.kind);
    for (const k of ['pre_event_brief', 'event_followup', 'travel_overlap', 'intro'] as const) expect(kinds).toContain(k);
    expect(allWildcardSources().map((s) => s.generator)).toContain('intro_pair');
  });

  it('adjudication is skipped without an API key; the nightly pass, effects and push ticks run without one', async () => {
    const w = intelWorld();
    const push = new FakePushSender();
    const services = (): AgentServices => ({ llm: new FakeLlmClient({ configured: false }), egress: createEgress(w.db), outbound: new FakeOutboundSender(), push });
    const jobs = intelJobs({ services });
    expect(await byName(jobs, 'intel-adjudicate').run(ctxFor(w.db))).toEqual({ status: 'skipped' });
    const nightly = await byName(jobs, 'intel').run(ctxFor(w.db));
    expect(nightly).toMatchObject({ status: 'ok' });
    expect(await byName(jobs, 'intel-effects').run(ctxFor(w.db))).toEqual({ status: 'skipped' });
    setFlag(w.db, EFFECTS_DIRTY, NOW, NOW);
    expect(await byName(jobs, 'intel-effects').run(ctxFor(w.db))).toMatchObject({ stats: expect.any(Object) });
    expect(await byName(jobs, 'intel-effects').run(ctxFor(w.db))).toEqual({ status: 'skipped' });

    // push: off by default; on, one generic push for a same-day event with two known attendees
    const a = w.person('Ana', 'Arbor', { tie: 60 });
    const b = w.person('Bo', 'Birch', { tie: 50 });
    const dinner = occasion(w.db, { title: 'Dinner', start: at(0, 19) });
    w.attendee(dinner, a);
    w.attendee(dinner, b);
    w.db.prepare(`INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, created_at) VALUES (?, 'https://web.push.apple.com/synthetic-device', 'pk', 'au', ?)`).run(uuidv7(), NOW);
    expect(await byName(jobs, 'pre-event-push').run(ctxFor(w.db, at(0, 16, 30)))).toEqual({ status: 'skipped' });
    setSetting(w.db, 'push.enabled', true);
    expect(await byName(jobs, 'pre-event-push').run(ctxFor(w.db, at(0, 16, 30)))).toEqual({ stats: { considered: 1, pushed: 1, devices: 1 } });
    expect(push.sent).toHaveLength(1);
  });
});
