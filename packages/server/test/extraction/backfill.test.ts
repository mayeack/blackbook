/**
 * The one-time historical backfill (conversation-month windows, ADD-only, its own budget pool), the
 * chronological reconcile, the per-person consolidation pass, the jobs and the CLI. Fakes and synthetic data only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { backfillExtractCommand } from '../../src/extraction/cli';
import { buildConsolidation, consolidatePerson, personSummary } from '../../src/extraction/consolidate';
import { buildEnv } from '../../src/extraction/env';
import { HISTORICAL_MAX_TOKENS } from '../../src/extraction/prompt';
import { extractionJobs } from '../../src/extraction/jobs';
import { advanceBackfill, backfillStatus, collect, planBackfill, startBackfill, submitSteady } from '../../src/extraction/run';
import { closeDatabase, openDatabase } from '../../src/db/connection';
import { migrate } from '../../src/db/migrate';
import type { JobContext } from '../../src/scheduler/scheduler';
import { nullLogger } from '../../src/ops/logger';
import { tempDir } from '../helpers';
import { HOUR, MIN, NOW, buildXWorld, deps, extraction, fact, fakes, lineOf, tokenOf, windowsOf, type XWorld } from './world';

const count = (w: XWorld, sql: string, ...p: unknown[]) => w.db.prepare(sql).pluck().get(...p) as number;

function history(w: XWorld) {
  // Two months of old DM history plus last night's messages (steady).
  const sep = Date.UTC(2026, 7, 10, 20); // Aug 10
  const oct = Date.UTC(2026, 6, 6, 20); // Jul 6
  const a = w.msg(w.dm, w.ids.sam, oct, 'I just moved to Austin, the heat is unreal but I love it');
  const b = w.msg(w.dm, w.ids.sam, oct + 5 * MIN, 'lets grab coffee next week when you are in town');
  const c = w.msg(w.dm, w.ids.sam, sep, 'update: moved again, I live in Denver now, way better climbing here');
  const d = w.msg(w.dm, null, sep + 5 * MIN, 'no way! I will visit you in Denver this winter for sure');
  const e = w.msg(w.dm, w.ids.sam, NOW - 3 * HOUR, 'are you around this weekend? I could use a hand moving a couch');
  return { a, b, c, d, e };
}

describe('historical backfill', () => {
  it('builds conversation-month windows before the steady start, ADD-only; old windows send no obligations request', async () => {
    const w = buildXWorld();
    const m = history(w);
    const f = fakes();
    const rep = await startBackfill(deps(w, f));
    expect(rep.status).toBe('running');
    const hist = windowsOf(w.db, w.dm).filter((x) => x.mode === 'historical');
    expect(hist).toHaveLength(2); // July and August
    const batch = f.llm.calls.filter((c) => c.method === 'batch');
    // Both months are older than 30 days: knowledge requests only (their obligations would be dropped anyway).
    expect(batch).toHaveLength(2);
    expect(batch.every((c) => !/_o-\d+$/.test(c.customId!))).toBe(true);
    expect(batch.every((c) => c.kind === 'historical' && c.route === 'extract_historical' && c.maxTokens === HISTORICAL_MAX_TOKENS && !c.fallbacks)).toBe(true);
    expect(batch[0]!.userText).toMatch(/^mode=historical /);
    expect(batch[0]!.userText).not.toContain('SUMMARY:');
    // The steady side starts at the backfill: last night's message is NOT in a historical window.
    expect(count(w, 'SELECT count(*) FROM extraction_coverage WHERE message_id = ?', m.e)).toBe(0);

    const [jul, aug] = hist;
    const P = tokenOf(w.db, jul!.id, w.sam);
    f.llm.on(`historical:${jul!.id}`, {
      json: extraction({
        facts: [
          fact(P, 'location_current', 'Austin', [{ msg: lineOf(w.db, jul!.id, m.a), quote: 'I just moved to Austin' }], 0.92),
          // historical mode: UPDATE is dropped
          fact(P, 'interest', 'heat', [{ msg: lineOf(w.db, jul!.id, m.a), quote: 'the heat is unreal' }], 0.9, { op: 'UPDATE', target: 'F1' }),
        ],
        commitments: [
          {
            owner: 'BOTH',
            with: [P],
            kind: 'meet',
            what: 'coffee',
            due: { kind: 'range', start: '2026-07-13', end: '2026-07-19' },
            status: 'open',
            closes: null,
            ev: [{ msg: lineOf(w.db, jul!.id, m.b), quote: 'lets grab coffee next week' }],
            conf: 0.9,
          },
        ],
        needs_reply: { state: 'needs_reply', msg: lineOf(w.db, jul!.id, m.b), reason: 'invitation', urgency: 'normal', conf: 0.9 },
      }),
    });
    const P2 = tokenOf(w.db, aug!.id, w.sam);
    f.llm.on(`historical:${aug!.id}`, {
      json: extraction({ facts: [fact(P2, 'location_current', 'Denver', [{ msg: lineOf(w.db, aug!.id, m.c), quote: 'I live in Denver now' }], 0.95)] }),
    });
    const c1 = await collect(deps(w, f, NOW + 10 * MIN));
    // The scripted answer carries a commitment and a reply verdict, but no obligations request was sent: none applies.
    expect(c1.counts).toMatchObject({ applied: 2, dropped_fact_historical_op: 1 });
    expect(count(w, 'SELECT count(*) FROM commitments')).toBe(0);
    expect(count(w, 'SELECT count(*) FROM reply_verdicts')).toBe(0);
    // Chronology: Denver (Aug) closes Austin (Jul), whatever order the windows were applied in.
    expect(w.db.prepare(`SELECT value, status FROM facts ORDER BY value`).all()).toEqual([
      { value: 'Austin', status: 'invalidated' },
      { value: 'Denver', status: 'confirmed' },
    ]);
    // Nobody has ≥8 facts → no consolidation; the backfill is done after the next step.
    expect(c1.counts.backfill_done).toBe(1);
    expect(backfillStatus(w.db)).toMatchObject({ state: 'done', windows: { applied: 2 } });
    // Steady extraction then picks up only the recent message.
    const s = await submitSteady(deps(w, f, NOW + 20 * MIN));
    expect(s.counts.windows).toBe(1);
    const steady = windowsOf(w.db, w.dm).find((x) => x.mode === 'steady')!;
    expect(count(w, 'SELECT count(*) FROM extraction_coverage WHERE window_id = ?', steady.id)).toBe(1);
    // A second start reports done and changes nothing.
    expect((await startBackfill(deps(w, f, NOW + HOUR))).status).toBe('done');
  });

  it('uses only the backfill pool and stops at its allowance (budget_exhausted, resumable)', async () => {
    const w = buildXWorld();
    history(w);
    const f = fakes({ budget: { steady: null, backfill: 0.000001 } });
    const rep = await startBackfill(deps(w, f));
    expect(rep.status).toBe('budget_exhausted');
    expect(f.llm.calls).toHaveLength(0);
    expect(windowsOf(w.db, w.dm).filter((x) => x.mode === 'historical').every((x) => x.status === 'pending')).toBe(true);
    // Raise the allowance: the same pending windows go out.
    const g = fakes();
    const rep2 = await advanceBackfill(deps(w, g, NOW + HOUR));
    expect(rep2.status).toBe('running');
    expect(g.llm.calls.filter((c) => c.method === 'batch')).toHaveLength(2);
  });

  it('without a key nothing is created (graceful no-op); --plan estimates read-only', async () => {
    const w = buildXWorld();
    history(w);
    const rep = await startBackfill(deps(w, fakes({ configured: false })));
    expect(rep).toMatchObject({ status: 'unavailable', reason: 'no_key' });
    expect(count(w, 'SELECT count(*) FROM extraction_backfill')).toBe(0);
    const plan = planBackfill(w.db, NOW);
    expect(plan).toMatchObject({ conversations: 1, messages: 4, windows: 2, alreadyStarted: false, windowsWithinBudget: 2, budgetUsd: 20 });
    // Haiku at batch prices: a couple of tiny windows cost a small fraction of a cent.
    expect(plan.estimateUsd).toBeGreaterThan(0);
    expect(plan.estimateUsd).toBeLessThan(0.01);
    expect(count(w, 'SELECT count(*) FROM windows')).toBe(0);
    expect(count(w, 'SELECT count(*) FROM extraction_conv_state')).toBe(0);
  });

  it('consolidates people with ≥8 facts after the backfill: merges, invalidations, a 2-sentence summary', async () => {
    const w = buildXWorld();
    const msgs: number[] = [];
    const interests = ['pottery', 'ceramics', 'jazz piano', 'hiking', 'board games', 'natural wine', 'formula 1', 'film photography', 'surfing'];
    for (let i = 0; i < interests.length; i++) {
      msgs.push(w.msg(w.dm, w.ids.sam, Date.UTC(2026, 5, 1 + i, 18), `honestly I am so into ${interests[i]} these days, it is my favorite thing`));
      msgs.push(w.msg(w.dm, w.ids.sam, Date.UTC(2026, 5, 1 + i, 19), `did I mention how much I love ${interests[i]}? cannot stop thinking about it`));
    }
    const f = fakes();
    await startBackfill(deps(w, f));
    const [win] = windowsOf(w.db, w.dm);
    const P = tokenOf(w.db, win!.id, w.sam);
    f.llm.on(`historical:${win!.id}`, {
      json: extraction({
        facts: interests.map((it, i) =>
          fact(P, 'interest', it, [
            { msg: lineOf(w.db, win!.id, msgs[2 * i]!), quote: `so into ${it} these days` },
            { msg: lineOf(w.db, win!.id, msgs[2 * i + 1]!), quote: `how much I love ${it}` },
          ], 0.9),
        ),
      }),
    });
    const c1 = await collect(deps(w, f, NOW + 10 * MIN));
    expect(c1.counts.applied).toBe(1);
    expect(c1.counts.backfill_consolidating).toBe(1);
    // pottery + ceramics folded already by the synonym map → 8 facts: still ≥8.
    expect(count(w, `SELECT count(*) FROM facts WHERE status = 'confirmed'`)).toBe(8);
    const cons = f.llm.calls.filter((c) => c.kind === 'consolidate');
    expect(cons).toHaveLength(1);
    expect(cons[0]!.userText).toMatch(/^as_of=2026-10-16\nperson: P\w+ Sam\nFACTS:\nF1 interest: /);
    // F aliases are ordered by type, support, created_at; look them up by value.
    const aliases = new Map([...cons[0]!.userText.matchAll(/\n(F\d+) interest: ([^·\n]+?) ·/g)].map((x) => [x[2]!, x[1]!]));
    const aliasOf = (v: string) => aliases.get(v)!;
    f.llm.on(`consolidate:${w.sam}`, {
      json: {
        summary: 'They are a creative friend who loves pottery and music. They also enjoy the outdoors and racing. Extra sentence dropped.',
        merges: [{ keep: aliasOf('film photography'), drop: [aliasOf('formula 1')], value: 'photography' }],
        invalidate: [{ fact: aliasOf('surfing'), reason: 'not_a_fact' }, { fact: 'F99', reason: 'duplicate' }],
      },
    });
    const c2 = await collect(deps(w, f, NOW + 20 * MIN));
    expect(c2.counts).toMatchObject({ consolidated: 1, consolidation_merged: 1, consolidation_invalidated: 1, consolidation_summary: 1, backfill_done: 1 });
    expect(w.db.prepare(`SELECT value FROM facts WHERE status = 'confirmed' ORDER BY value`).pluck().all()).toEqual([
      'board games',
      'hiking',
      'jazz piano',
      'natural wine',
      'photography',
      'pottery',
    ]);
    expect(personSummary(w.db, w.sam)?.summary).toBe('They are a creative friend who loves pottery and music. They also enjoy the outdoors and racing.');
    expect(backfillStatus(w.db).state).toBe('done');
  });

  it('consolidatePerson (on demand, synchronous on the extract_consolidate route) degrades without a key', async () => {
    const w = buildXWorld();
    const f = fakes({ configured: false });
    expect(await consolidatePerson({ db: w.db, llm: f.llm, egress: f.egress, now: () => NOW }, w.sam)).toEqual({ status: 'unavailable', reason: 'no_key' });
    const g = fakes();
    expect(await consolidatePerson({ db: w.db, llm: g.llm, egress: g.egress, now: () => NOW }, w.sam)).toEqual({ status: 'skipped', reason: 'too_few_facts' });
    for (const v of ['tea', 'chess', 'cycling']) {
      w.db.prepare(
        `INSERT INTO facts (id, person_id, type, value, value_norm, confidence, status, recorded_at, source, created_at, updated_at)
         VALUES (?, ?, 'interest', ?, ?, 0.9, 'confirmed', 0, 'test', 0, 0)`,
      ).run(`f-${v}`, w.sam, v, v);
    }
    const env = buildEnv(w.db, NOW);
    expect(buildConsolidation(env, g.egress, w.sam, { min: 3 })?.factCount).toBe(3);
    g.llm.on('consolidate', { json: { summary: 'They like tea and chess. They ride bikes.', merges: [], invalidate: [] } });
    const out = await consolidatePerson({ db: w.db, llm: g.llm, egress: g.egress, now: () => NOW }, w.sam);
    expect(out).toMatchObject({ status: 'ok', stats: { summary: 1 } });
    expect(g.llm.calls[0]).toMatchObject({ method: 'parse', route: 'extract_consolidate', fallbacks: false, effort: 'low', thinking: 'disabled', kind: 'consolidate' });
  });
});

describe('jobs and CLI', () => {
  const ctx = (w: XWorld, trigger: JobContext['trigger']): JobContext => ({
    db: w.db,
    jobRunId: 1,
    trigger,
    now: () => NOW,
    log: nullLogger,
    signal: new AbortController().signal,
  });

  it('registers submit (daily 03:10), collect (5 min) and a manual-only backfill', async () => {
    const w = buildXWorld();
    history(w);
    const f = fakes();
    const jobs = extractionJobs({ services: () => ({ llm: f.llm, egress: f.egress }) as never });
    expect(jobs.map((j) => [j.name, j.schedule])).toEqual([
      ['extract-submit', { kind: 'daily', at: '03:10' }],
      ['extract-collect', { kind: 'interval', everyMs: 300_000 }],
      ['extract-backfill', { kind: 'interval', everyMs: 86_400_000 }],
    ]);
    const backfill = jobs.find((j) => j.name === 'extract-backfill')!;
    expect(await backfill.run(ctx(w, 'schedule'))).toEqual({ status: 'skipped' });
    expect(await backfill.run(ctx(w, 'boot'))).toEqual({ status: 'skipped' });
    expect(count(w, 'SELECT count(*) FROM extraction_backfill')).toBe(0);
    const out = (await backfill.run(ctx(w, 'manual'))) as { status: string; stats: Record<string, number> };
    expect(out.status).toBe('ok');
    expect(out.stats).toMatchObject({ state_running: 1, windows_submitted: 2 });
    const sub = (await jobs[0]!.run(ctx(w, 'schedule'))) as { stats: Record<string, number> };
    expect(sub.stats).toMatchObject({ windows: 1, submitted: 1 });
    const col = (await jobs[1]!.run(ctx(w, 'schedule'))) as { stats: Record<string, number> };
    expect(col.stats.applied).toBe(3);
  });

  it('yb backfill-extract --estimate (alias --plan) is a read-only dry run with counts and $; offline without a key it sends nothing', async () => {
    const { dir, cleanup } = tempDir();
    try {
      const dbPath = path.join(dir, 'yeackbot.db');
      const db = openDatabase(dbPath);
      migrate(db);
      closeDatabase(db);
      const paths = {
        dataDir: dir,
        dbPath,
        lockPath: path.join(dir, 'yeackbot.pid'),
        backupDir: path.join(dir, 'backups'),
        logDir: path.join(dir, 'logs'),
        adminSocketPath: path.join(dir, 'admin.sock'),
      };
      const lines: string[] = [];
      const io = { out: (s: string) => lines.push(s), err: (s: string) => lines.push(`ERR ${s}`) };
      expect(await backfillExtractCommand(['--plan', '--json'], paths, io)).toBe(0);
      expect(JSON.parse(lines[0]!)).toMatchObject({ conversations: 0, windows: 0, estimateUsd: 0, model: 'claude-haiku-5-5', budgetUsd: 20, spentUsd: 0, windowsWithinBudget: 0 });
      lines.length = 0;
      expect(await backfillExtractCommand(['--estimate'], paths, io)).toBe(0);
      expect(lines.join('\n')).toMatch(/dry run, nothing sent/);
      expect(lines.join('\n')).toMatch(/estimated cost ≈ \$0\.00 \(Claude Haiku 5\.5, batch prices/);
      expect(lines.join('\n')).toMatch(/allowance \$20\.00 \(spent \$0\.00, left \$20\.00\) · covers 0 of 0 windows/);
      const saved = process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      try {
        lines.length = 0;
        expect(await backfillExtractCommand([], paths, io)).toBe(1);
        expect(lines.join('\n')).toContain('no ANTHROPIC_API_KEY: nothing was sent');
      } finally {
        if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
      }
      expect(fs.existsSync(paths.lockPath)).toBe(false);
      expect(await backfillExtractCommand(['--bogus'], paths, io)).toBe(2);
    } finally {
      cleanup();
    }
  });
});

