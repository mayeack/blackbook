import { describe, expect, it } from 'vitest';
import { withBatch } from '../../../src/journal/batch';
import { startRun } from '../../../src/journal/runs';
import { undoBatch } from '../../../src/journal/undo';
import { nullLogger } from '../../../src/ops/logger';
import { aggregateEdges, finishPair, type PairAgg } from '../../../src/pipeline/graph/aggregate';
import { deriveCoGroup, loadGraphPeople, words } from '../../../src/pipeline/graph/evidence';
import { graphJobs } from '../../../src/pipeline/graph/jobs';
import { refreshEdgeStats, runGraph, runGraphAsync } from '../../../src/pipeline/graph/run';
import { drainSteps } from '../../../src/pipeline/graph/steps';
import { neighborEdges, pairEvidence, readEdge, rejectEdgeEvidence } from '../../../src/pipeline/graph/view';
import { contribution, labelFamily, strengthOf, tierOf } from '../../../src/pipeline/graph/weights';
import { AGENT_TIMES } from '../../../src/scheduler/timetable';
import { DAY, HOUR, NOW, pointerMerge, socialWorld, type SocialWorld } from '../socialWorld';

const ev = (w: SocialWorld, type: string) =>
  w.db.prepare('SELECT a_id, b_id, ref, at, w_raw FROM edge_evidence WHERE type = ? ORDER BY a_id, b_id, ref').all(type) as {
    a_id: string;
    b_id: string;
    ref: string;
    at: number;
    w_raw: number;
  }[];

const pair = (x: string, y: string) => (x < y ? [x, y] : [y, x]);

function insertEvidence(w: SocialWorld, a: string, b: string, type: string, ref: string, at: number | null, wRaw: number, directed = 0) {
  const [x, y] = directed ? [a, b] : pair(a, b);
  w.db
    .prepare(`INSERT INTO edge_evidence (a_id, b_id, type, directed, ref, at, w_raw, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(x, y, type, directed, ref, at, wRaw, NOW);
}

describe('edge weights', () => {
  it('per-type decay, tiers and label families', () => {
    expect(contribution('co_attend', 1, NOW - 365 * DAY, NOW)).toBeCloseTo(Math.exp(-1), 6);
    expect(contribution('invited_by', 1.5, NOW - 730 * DAY, NOW)).toBeCloseTo(0.75, 6);
    expect(contribution('mentioned_together', 0.3, NOW - 365 * DAY, NOW)).toBeCloseTo(0.15, 6);
    expect(contribution('group_reply', 0.1, NOW - 366 * DAY, NOW)).toBe(0);
    expect(contribution('met_via', 2, NOW - 3000 * DAY, NOW)).toBe(2);
    expect(contribution('co_group', 0.4, NOW - 3000 * DAY, NOW)).toBe(0.4);
    expect(strengthOf(2)).toBeCloseTo(1 - Math.exp(-1), 6);
    expect([0.8, 0.5, 0.2, 0.1].map(tierOf)).toEqual(['close', 'know', 'acquainted', 'faint']);
    expect(['partner', 'Wife', 'sister-in-law', 'ex-boyfriend', 'colleague', 'mystery'].map(labelFamily)).toEqual([
      'partner',
      'spouse',
      'family_other',
      'ex',
      'coworker',
      'other',
    ]);
  });

  it('caps, roster factor and blocks', () => {
    const p: PairAgg = {
      a: 'a',
      b: 'b',
      byType: { mentioned_together: { w: 3, n: 10, last: 5 }, group_reply: { w: 2, n: 20, last: 7 }, co_group: { w: 1, n: 1, last: 3 } },
      closeLabelW: 0,
      weight: 0,
      strength: 0,
      tier: 'faint',
      dominant: null,
      last: null,
      evidenceCount: 0,
    };
    finishPair(p, false, undefined);
    expect(p.byType.mentioned_together!.w).toBe(1.5);
    expect(p.byType.group_reply!.w).toBe(1);
    expect(p.weight).toBe(3.5);
    expect(p.dominant).toBe('mentioned_together');
    expect(p.last).toBe(7);
    const roster = finishPair({ ...p, byType: { co_group: { w: 1, n: 1, last: 3 } } }, true, new Set(['label']));
    expect(roster.weight).toBe(0.25);
    const blocked = finishPair({ ...p, byType: { co_group: { w: 1, n: 1, last: 3 } } }, false, new Set(['*']));
    expect(blocked.weight).toBe(0);
  });
});

describe('graph evidence', () => {
  it('co_group follows the formula; big groups add nothing, mid-size ones count half', () => {
    const w = socialWorld();
    const [a, b, c] = [w.person('Ann', 'Arbor'), w.person('Ben', 'Birch'), w.person('Cy', 'Cedar')];
    const g = w.group('Climbing crew', [a, b, c]);
    for (let i = 0; i < 40; i++) w.msg(g, NOW - i * DAY, [a, b, c, 'me'][i % 4]!, 'send beta');
    const people = loadGraphPeople(w.db);
    const rows = drainSteps(deriveCoGroup(w.db, people, NOW));
    expect(rows.size).toBe(3);
    // n = 3, M_g = Σ 0.5^(i/90), m = 10 each, R_g = 1 (last message now)
    let mg = 0;
    for (let i = 0; i < 40; i++) mg += 0.5 ** (i / 90);
    const expected = (1 / Math.log2(4)) * (1 - Math.exp(-mg / 50)) * (0.25 + 0.75 * Math.min(1, 10 / 20));
    const [x, y] = pair(a, b);
    expect(rows.get(`${x}|${y}|conv:${g}`)!.w).toBeCloseTo(expected, 5);

    const many = Array.from({ length: 41 }, (_, i) => w.person(`P${i}x`, 'Many'));
    const big = w.group('Neighborhood', many);
    for (let i = 0; i < 30; i++) w.msg(big, NOW - i * HOUR, many[i % 41]!, 'hi all');
    const mid = w.group('Book club', many.slice(0, 30));
    for (let i = 0; i < 30; i++) w.msg(mid, NOW - i * HOUR, many[i]!, 'chapter 3');
    const after = drainSteps(deriveCoGroup(w.db, loadGraphPeople(w.db), NOW));
    expect([...after.values()].some((r) => r.ref === `conv:${big}`)).toBe(false);
    const midRow = [...after.values()].find((r) => r.ref === `conv:${mid}`)!;
    const n = 30;
    let mgMid = 0;
    for (let i = 0; i < 30; i++) mgMid += 0.5 ** (i / 24 / 90);
    expect(midRow.w).toBeCloseTo((1 / Math.log2(1 + n)) * (1 - Math.exp(-mgMid / 50)) * (0.25 + 0.75 / 20) * 0.5, 5);
  });

  it('group replies and mentions; mentioned_together from full names and group first names', () => {
    const w = socialWorld();
    const [ann, ben, cy, dot] = [w.person('Ann', 'Arbor'), w.person('Ben', 'Birch'), w.person('Cyrus', 'Cedar'), w.person('Dora', 'Dune')];
    const g = w.group('Trip planning', [ann, ben, cy]);
    const root = w.msg(g, NOW - 2 * DAY, ben, 'who is driving?');
    const reply = w.msg(g, NOW - 2 * DAY + 60_000, ann, 'me!', { replyTo: root });
    const mention = w.msg(g, NOW - DAY, ann, 'Cyrus can you bring snacks');
    const lower = w.msg(g, NOW - DAY + 1, ann, 'cyrus maybe');
    const dm = w.dm(dot);
    const both = w.msg(dm, NOW - 3 * DAY, 'me', 'saw Ann Arbor and ben birch at the market');
    const one = w.msg(dm, NOW - 3 * DAY, 'me', 'Ann Arbor says hi');
    const stats = runGraph(w.db, { now: NOW });
    expect(stats.messagesScanned).toBeGreaterThanOrEqual(6);
    const replies = ev(w, 'group_reply');
    expect(replies.map((r) => r.ref).sort()).toEqual([`m:${mention}`, `m:${reply}`].sort());
    expect(replies.every((r) => r.w_raw === 0.1)).toBe(true);
    expect(replies.some((r) => r.ref === `m:${lower}`)).toBe(false); // lowercase first names aren't read as mentions
    const mentioned = ev(w, 'mentioned_together');
    expect(mentioned.map((r) => r.ref)).toEqual([`m:${both}`]);
    expect([mentioned[0]!.a_id, mentioned[0]!.b_id]).toEqual(pair(ann, ben));
    expect(mentioned.some((r) => r.ref === `m:${one}`)).toBe(false);
    expect(words("Ann's café-trip!").map((x) => x.norm)).toEqual(['ann', 'cafe-trip']);
  });

  it('aggregates every writer into edge_stats: canonical, visible people only, labels and met_via included', () => {
    const w = socialWorld();
    const [ann, ben, cy, hid, dup] = [w.person('Ann', 'Arbor'), w.person('Ben', 'Birch'), w.person('Cy', 'Cedar'), w.person('Hal', 'Hidden', { is_hidden: 1 }), w.person('Ann', 'A')];
    insertEvidence(w, ann, ben, 'co_attend', 'event:e1', NOW - 10 * DAY, 1);
    insertEvidence(w, dup, ben, 'co_attend', 'event:e2', NOW - 20 * DAY, 0.5);
    insertEvidence(w, ann, cy, 'invited_by', 'event:e1', NOW, 1.5, 1);
    insertEvidence(w, ann, hid, 'co_attend', 'event:e1', NOW, 1);
    insertEvidence(w, ann, w.me, 'co_attend', 'event:e1', NOW, 1);
    const run = startRun(w.db, 'migration', { now: NOW });
    withBatch(w.db, { runId: run, kind: 'edge_label', title: 'x', actor: 'system' }, (t) => {
      const [x, y] = pair(ben, cy);
      t.insert('edge_labels', { id: '019a0000-0000-7000-8000-0000000000e1', a_id: x, b_id: y, label: 'roommate', confidence: 1, origin: 'legacy' });
      t.insert('edge_labels', { id: '019a0000-0000-7000-8000-0000000000e2', a_id: cy, b_id: ann, label: 'met_via', directed: 1, confidence: 1, origin: 'legacy' });
    });
    pointerMerge(w.db, dup, ann);
    const s = runGraph(w.db, { now: NOW });
    expect(s.edgeStatsStored).toBe(3);
    const ab = readEdge(w.db, ben, ann)!;
    expect(ab.types).toEqual(['co_attend']);
    expect(ab.breakdown.co_attend!.n).toBe(2);
    expect(ab.weight).toBeCloseTo(Math.exp(-10 / 365) + 0.5 * Math.exp(-20 / 365), 3);
    expect(ab.tier).toBe(tierOf(ab.strength));
    const bc = readEdge(w.db, ben, cy)!;
    expect(bc).toMatchObject({ dominantType: 'label', weight: 3, types: ['label'] });
    const ac = readEdge(w.db, ann, cy)!;
    expect(ac.types).toEqual(['invited_by', 'met_via']);
    expect(ac.weight).toBeCloseTo(3.5, 3);
    expect(readEdge(w.db, ann, hid)).toBeNull();
    expect(readEdge(w.db, ann, w.me)).toBeNull();
    expect(neighborEdges(w.db, ann).map((e) => (e.a === ann ? e.b : e.a))).toEqual([cy, ben]);
    expect(pairEvidence(w.db, ann, ben).map((e) => e.ref)).toEqual(['event:e1', 'event:e2']); // the merged-in record's too
    expect(pairEvidence(w.db, cy, ann)).toEqual([{ type: 'invited_by', ref: 'event:e1', at: NOW, wRaw: 1.5, from: ann }]);

    // idempotent
    expect(runGraph(w.db, { now: NOW })).toMatchObject({ edgeStatsUpserted: 0, edgeStatsDeleted: 0, evidenceInserted: 0 });
  });

  it('a "wrong" on an evidence type is sticky, and undoing it brings the evidence back', () => {
    const w = socialWorld();
    const [ann, ben] = [w.person('Ann', 'Arbor'), w.person('Ben', 'Birch')];
    insertEvidence(w, ann, ben, 'co_attend', 'event:e1', NOW, 1);
    insertEvidence(w, ann, ben, 'plus_one', 'event:e1', NOW, 3, 1);
    runGraph(w.db, { now: NOW });
    expect(readEdge(w.db, ann, ben)!.types).toEqual(['co_attend', 'plus_one']);
    const run = startRun(w.db, 'user', { now: NOW });
    const { batchId } = withBatch(w.db, { runId: run, kind: 'edge_label', title: 'Marked a connection wrong', actor: 'user' }, (t) => {
      expect(rejectEdgeEvidence(t, ben, ann, 'co_attend')).toBe(true);
      expect(rejectEdgeEvidence(t, ann, ben, 'co_attend')).toBe(false);
    });
    refreshEdgeStats(w.db, NOW);
    expect(readEdge(w.db, ann, ben)!.types).toEqual(['plus_one']);
    runGraph(w.db, { now: NOW });
    expect(readEdge(w.db, ann, ben)!.types).toEqual(['plus_one']);
    undoBatch(w.db, batchId, { now: NOW });
    refreshEdgeStats(w.db, NOW);
    expect(readEdge(w.db, ann, ben)!.types).toEqual(['co_attend', 'plus_one']);
    const run2 = startRun(w.db, 'user', { now: NOW });
    withBatch(w.db, { runId: run2, kind: 'edge_label', title: 'They don’t know each other', actor: 'user' }, (t) => rejectEdgeEvidence(t, ann, ben, '*'));
    refreshEdgeStats(w.db, NOW);
    expect(readEdge(w.db, ann, ben)).toBeNull();
  });

  it('only rewrites its own evidence types; Partiful/occasion rows stay', () => {
    const w = socialWorld();
    const [ann, ben] = [w.person('Ann', 'Arbor'), w.person('Ben', 'Birch')];
    insertEvidence(w, ann, ben, 'co_attend', 'occ:o1', NOW, 0.6);
    insertEvidence(w, ann, ben, 'co_group', 'conv:gone', NOW, 0.6);
    runGraph(w.db, { now: NOW });
    expect(ev(w, 'co_attend')).toHaveLength(1);
    expect(ev(w, 'co_group')).toHaveLength(0);
  });

  it('the job: daily slot, async pass, abort → partial', async () => {
    const jobs = graphJobs({});
    expect(jobs.map((j) => [j.name, j.schedule])).toEqual([['graph', { kind: 'daily', at: AGENT_TIMES.graph }]]);
    const w = socialWorld();
    const ac = new AbortController();
    ac.abort();
    expect((await runGraphAsync(w.db, { now: NOW, signal: ac.signal })).complete).toBe(false);
    const ctx = { db: w.db, jobRunId: 1, trigger: 'manual' as const, now: () => NOW, log: nullLogger, signal: new AbortController().signal };
    expect(await jobs[0]!.run(ctx)).toMatchObject({ status: 'ok' });
    const pairs = drainSteps(aggregateEdges(w.db, NOW));
    expect(pairs.size).toBe(0);
  });
});
