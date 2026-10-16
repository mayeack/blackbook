import { describe, expect, it } from 'vitest';
import { recordSourceHealth } from '../../../src/adapters/common/cursors';
import { nullLogger } from '../../../src/ops/logger';
import { allGenerators, allWildcardSources } from '../../../src/pipeline/suggestions/registry';
import type { Candidate, CandidateGenerator, GeneratorContext } from '../../../src/pipeline/suggestions/types';
import { coolingGenerator, dormantCloseWildcard, dormantGenerator, fadingGenerator } from '../../../src/pipeline/ties/generators';
import { tiesJobs } from '../../../src/pipeline/ties/jobs';
import { runTies, runTiesAsync } from '../../../src/pipeline/ties/run';
import { readTieStats } from '../../../src/pipeline/ties/view';
import { AGENT_TIMES } from '../../../src/scheduler/timetable';
import { settingsSnapshot } from '../../../src/settings/registry';
import { refreshConversations } from '../../../src/pipeline/interactions';
import { seedIdentity } from '../../helpers';
import { DAY, NOW, pointerMerge, socialWorld, type SocialWorld } from '../socialWorld';

const opts = { now: NOW, timeZone: 'UTC' };

/** Daily 1:1 contact for `count` days ending `silence` days ago. */
function daily(w: SocialWorld, personId: string, count: number, silence: number, conversationId?: string) {
  for (let i = 0; i < count; i++) w.dmTouch(personId, NOW - (silence + i) * DAY, { conversationId, mine: i % 2 === 0 });
}

const stat = (w: SocialWorld, id: string) =>
  w.db.prepare('SELECT * FROM person_stats WHERE person_id = ?').get(id) as Record<string, number | string | null> | undefined;

const gen = (g: CandidateGenerator, ctx: GeneratorContext) => g.generate(ctx) as Candidate[];

function genCtx(w: SocialWorld): GeneratorContext {
  return { db: w.db, now: NOW, timeZone: 'UTC', settings: settingsSnapshot(w.db), runId: null, log: nullLogger };
}

describe('ties pass', () => {
  it('builds touch days, stats and weekly snapshots; a second pass writes nothing new', () => {
    const w = socialWorld();
    const ava = w.person('Ava', 'Quill');
    const bo = w.person('Bo', 'Rook');
    daily(w, ava, 200, 30);
    daily(w, bo, 100, 0);
    const s1 = runTies(w.db, opts);
    expect(s1.withStats).toBe(2);
    expect(s1.touchDaysWritten).toBe(300);
    expect(s1.fading).toBe(1);
    expect(stat(w, ava)).toMatchObject({ state: 'fading', contact_days_365: 200, silence_d: 30, fading_ratio: 4.2857, fading_suppressed: 0, cold_start: 0 });
    expect(stat(w, ava)!.expected_gap_d).toBeLessThan(1.1);
    expect(stat(w, ava)!.fading_severity).toBeGreaterThan(0);
    expect(stat(w, bo)!.state).toBe('strong');
    expect(stat(w, w.me)).toBeUndefined(); // the owner never gets tie stats

    const t = readTieStats(w.db, bo);
    expect(t).toMatchObject({ personId: bo, state: 'strong', label: 'Strong', fadingSuppressed: false, contactDays365: 100 });
    expect(t.sparkline.length).toBeGreaterThan(10);
    expect(t.sparkline.length).toBeLessThanOrEqual(26);
    expect(t.sparkline[t.sparkline.length - 1]!.t).toBe(t.tieStrength);
    expect(t.iStartShare).toBeGreaterThan(0.4);

    const s2 = runTies(w.db, opts);
    expect(s2.touchDaysWritten).toBe(0);
    expect(s2.touchDaysDeleted).toBe(0);
    expect(s2.snapshotsWritten).toBe(0);
    expect(stat(w, ava)!.state).toBe('fading');
  });

  it('merges fold into the survivor and stale rows go away', () => {
    const w = socialWorld();
    const ava = w.person('Ava', 'Quill');
    const dup = w.person('Ava', 'Q');
    daily(w, ava, 10, 1);
    daily(w, dup, 10, 11);
    runTies(w.db, opts);
    expect(stat(w, dup)).toBeDefined();
    pointerMerge(w.db, dup, ava);
    const s = runTies(w.db, opts);
    expect(stat(w, dup)).toBeUndefined();
    expect(stat(w, ava)!.contact_days_365).toBe(20);
    expect(s.statsDeleted).toBe(1);
    expect(w.db.prepare('SELECT count(*) FROM person_touch_days WHERE person_id = ?').pluck().get(dup)).toBe(0);
    expect(w.db.prepare('SELECT count(*) FROM tie_stats_snapshot WHERE person_id = ?').pluck().get(dup)).toBe(0);
  });

  it('suppresses fading for WhatsApp/Instagram people until that source is ingesting', () => {
    const w = socialWorld();
    const ava = w.person('Ava', 'Quill');
    daily(w, ava, 200, 30);
    seedIdentity(w.db, ava, 'whatsapp_lid', 'lid-synthetic-0001');
    runTies(w.db, opts);
    expect(stat(w, ava)).toMatchObject({ fading_suppressed: 1 });
    expect(stat(w, ava)!.state).not.toBe('fading');
    expect(fadingGenerator.generate(genCtx(w))).toEqual([]);

    recordSourceHealth(w.db, 'whatsapp', NOW - DAY, 'ok', { newestDataAt: NOW - DAY });
    runTies(w.db, opts);
    expect(stat(w, ava)).toMatchObject({ fading_suppressed: 0, state: 'fading' });

    recordSourceHealth(w.db, 'whatsapp', NOW - 5 * DAY, 'ok');
    w.db.prepare(`UPDATE source_health SET last_ok_at = ? WHERE source = 'whatsapp'`).run(NOW - 5 * DAY);
    runTies(w.db, opts);
    expect(stat(w, ava)).toMatchObject({ fading_suppressed: 1 });
  });

  it('honors the fading settings', () => {
    const w = socialWorld();
    const ava = w.person('Ava', 'Quill');
    daily(w, ava, 200, 25);
    runTies(w.db, opts);
    expect(stat(w, ava)!.state).toBe('fading');
    w.db.prepare(`INSERT INTO settings (key, value, created_at, updated_at) VALUES ('agent.fading_min_silence_days', '30', 0, 0)`).run();
    runTies(w.db, opts);
    expect(stat(w, ava)!.state).not.toBe('fading');
  });

  it('counts calendar occasions, Partiful events and log entries as in-person touches', () => {
    const w = socialWorld();
    const ava = w.person('Ava', 'Quill');
    for (let i = 0; i < 8; i++) w.interaction(ava, i % 2 ? 'occasion' : 'event', NOW - (100 + i * 14) * DAY, { units: 1.5 });
    w.interaction(ava, 'text_log', NOW - 90 * DAY);
    runTies(w.db, opts);
    const s = stat(w, ava)!;
    expect(s.contact_days_365).toBe(9);
    expect(s.silence_d).toBe(90);
    expect(w.db.prepare('SELECT units FROM person_touch_days WHERE person_id = ? ORDER BY day DESC LIMIT 1').pluck().get(ava)).toBe(1.5);
  });

  it('reads the interactions the real sessionizer derives (1:1 and small groups)', () => {
    const w = socialWorld();
    const [ava, bo, cy] = [w.person('Ava', 'Quill'), w.person('Bo', 'Rook'), w.person('Cy', 'Lark')];
    const dm = w.dm(ava);
    const g = w.group('Dinner plans', [bo, cy]);
    for (let d = 1; d <= 30; d++) {
      w.msg(dm, NOW - d * DAY, 'me', 'how was your day');
      if (d % 2) w.msg(dm, NOW - d * DAY + 60_000, ava, 'good, you?');
    }
    w.msg(g, NOW - 2 * DAY, bo, 'friday?');
    w.msg(g, NOW - 2 * DAY + 60_000, 'me', 'yes');
    w.msg(g, NOW - 3 * DAY, cy, 'anyone around');
    refreshConversations(w.db, new Map([[dm, null], [g, null]]), { now: NOW });
    runTies(w.db, opts);
    const days = (id: string) => w.db.prepare('SELECT day, units FROM person_touch_days WHERE person_id = ? ORDER BY day').all(id) as { day: string; units: number }[];
    const ava365 = days(ava);
    expect(ava365).toHaveLength(30);
    expect(new Set(ava365.map((d) => d.units))).toEqual(new Set([1, 0.6]));
    expect(days(bo)).toEqual([{ day: '2026-10-12', units: 0.3 }]);
    expect(days(cy)).toEqual([{ day: '2026-10-11', units: 0.05 }]);
    expect(stat(w, ava)!.i_start_share).toBe(1);
  });

  it('keeps the event loop responsive during a long pass', async () => {
    const w = socialWorld();
    for (let i = 0; i < 60; i++) daily(w, w.person(`P${i}`, 'Load'), 60, i);
    let ticks = 0;
    const iv = setInterval(() => ticks++, 0);
    const r = await runTiesAsync(w.db, { ...opts, sliceMs: 1 });
    clearInterval(iv);
    expect(r.complete).toBe(true);
    expect(ticks).toBeGreaterThan(0);
  });

  it('the async pass yields and stops on abort', async () => {
    const w = socialWorld();
    const ava = w.person('Ava', 'Quill');
    daily(w, ava, 20, 0);
    const ac = new AbortController();
    ac.abort();
    expect((await runTiesAsync(w.db, { ...opts, signal: ac.signal })).complete).toBe(false);
    const done = await runTiesAsync(w.db, { ...opts, sliceMs: 0 });
    expect(done.complete).toBe(true);
    expect(done.stats.withStats).toBe(1);
  });

  it('registers one daily job at the timetable slot', async () => {
    const jobs = tiesJobs({});
    expect(jobs.map((j) => j.name)).toEqual(['ties']);
    expect(jobs[0]!.schedule).toEqual({ kind: 'daily', at: AGENT_TIMES.ties });
    const w = socialWorld();
    daily(w, w.person('Ava', 'Quill'), 5, 0);
    const out = await jobs[0]!.run({ db: w.db, jobRunId: 1, trigger: 'manual', now: () => NOW, log: nullLogger, signal: new AbortController().signal });
    expect(out).toMatchObject({ status: 'ok', stats: { withStats: 1 } });
  });
});

describe('tie generators', () => {
  it('fading / cooling / dormant candidates for visible people only, with citations', () => {
    const w = socialWorld();
    const ava = w.person('Ava', 'Quill');
    const hidden = w.person('Hal', 'Vane', { is_hidden: 1 });
    const cal = w.person('Cal', 'Moss');
    const dor = w.person('Dee', 'Fern');
    const dm = w.dm(ava);
    const m = w.msg(dm, NOW - 30 * DAY, ava, 'see you soon');
    daily(w, ava, 200, 30, dm);
    daily(w, hidden, 200, 30);
    for (let i = 0; i < 145; i++) w.dmTouch(cal, NOW - (365 - i) * DAY);
    w.dmTouch(cal, NOW - 10 * DAY);
    for (let i = 0; i < 100; i++) w.dmTouch(dor, NOW - (400 + i * 3) * DAY);
    runTies(w.db, opts);
    const ctx = genCtx(w);

    const fading = gen(fadingGenerator, ctx);
    expect(fading.map((c) => c.personIds[0])).toEqual([ava]);
    expect(fading[0]).toMatchObject({ kind: 'fading', subjectKey: ava, evidenceIds: [`m:${m}`, `conv:${dm}`] });
    expect(fading[0]!.base).toBeCloseTo(stat(w, ava)!.fading_severity as number, 6);
    expect(fading[0]!.expiresAt).toBeGreaterThan(NOW);

    const cooling = gen(coolingGenerator, ctx);
    expect(cooling.map((c) => c.personIds[0])).toEqual([cal]);
    expect(cooling[0]!.base).toBeCloseTo((0.6 * (stat(w, cal)!.historical_strength as number)) / 100, 6);

    const dormant = gen(dormantGenerator, ctx);
    expect(dormant.map((c) => c.personIds[0])).toEqual([dor]);
    expect(dormant[0]!.base).toBe(0.3);

    let i = 0;
    const wild = dormantCloseWildcard.generate(ctx, () => [0.99, 0.01][i++ % 2]!) as Candidate[];
    expect(wild.length).toBeGreaterThan(0);
    expect(wild.every((c) => c.kind === 'dormant' && c.subjectKey.startsWith('wild:'))).toBe(true);
    expect(wild.some((c) => c.subjectKey === `wild:${hidden}`)).toBe(false);
  });

  it('are registered with the suggestion stage', () => {
    const kinds = allGenerators().map((g) => g.kind);
    for (const k of ['fading', 'cooling', 'dormant', 'circle_neglect'] as const) expect(kinds).toContain(k);
    const wild = allWildcardSources().map((s) => s.generator);
    expect(wild).toContain('dormant_close');
    expect(wild).toContain('circle_checkin');
  });
});
