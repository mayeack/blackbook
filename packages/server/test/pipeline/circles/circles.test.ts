import { describe, expect, it } from 'vitest';
import { writeSettings } from '../../../src/settings/registry';
import { uuidv7 } from '@yb/shared';
import { undoBatch } from '../../../src/journal/undo';
import { nullLogger } from '../../../src/ops/logger';
import { editMembers, updateCollection } from '../../../src/pipeline/circles/collections';
import { buildCircleGraph, detectCommunities, greedyMatch, jaccard, seededRng } from '../../../src/pipeline/circles/detect';
import { circleCheckinWildcard, circleNeglectGenerator } from '../../../src/pipeline/circles/generators';
import { circlesJobs } from '../../../src/pipeline/circles/jobs';
import { cleanTitle, validateName } from '../../../src/pipeline/circles/naming';
import { runCircles } from '../../../src/pipeline/circles/run';
import type { PairAgg } from '../../../src/pipeline/graph/aggregate';
import type { Candidate, GeneratorContext } from '../../../src/pipeline/suggestions/types';
import { AGENT_TIMES } from '../../../src/scheduler/timetable';
import { settingsSnapshot } from '../../../src/settings/registry';
import { FakeEgress, FakeLlmClient } from '../../fakes/llm';
import { DAY, NOW, socialWorld, type SocialWorld } from '../socialWorld';

function link(w: SocialWorld, a: string, b: string, wRaw = 1, ref = 'event:e1') {
  const [x, y] = a < b ? [a, b] : [b, a];
  w.db
    .prepare(`INSERT INTO edge_evidence (a_id, b_id, type, directed, ref, at, w_raw, created_at) VALUES (?, ?, 'co_attend', 0, ?, ?, ?, ?)`)
    .run(x, y, ref, NOW - DAY, wRaw, NOW);
}

function clique(w: SocialWorld, ids: string[], wRaw = 1) {
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) link(w, ids[i]!, ids[j]!, wRaw);
}

interface Fixture {
  w: SocialWorld;
  climbers: string[];
  readers: string[];
  bridge: string;
}

function fixture(): Fixture {
  const w = socialWorld();
  const climbers = ['Ari', 'Bex', 'Cole', 'Dina', 'Eli'].map((f) => w.person(f, 'Climb'));
  const readers = ['Fay', 'Gus', 'Hana', 'Ivo'].map((f) => w.person(f, 'Read'));
  const bridge = w.person('Jo', 'Bridge');
  clique(w, climbers);
  clique(w, readers);
  link(w, bridge, climbers[0]!);
  link(w, bridge, climbers[1]!);
  link(w, bridge, readers[0]!);
  w.group('Climbing crew', climbers);
  return { w, climbers, readers, bridge };
}

const circles = (w: SocialWorld) =>
  w.db.prepare(`SELECT id, name, kind, status, color_hex, icon FROM circles ORDER BY name`).all() as {
    id: string;
    name: string;
    kind: string;
    status: string;
    color_hex: string | null;
    icon: string | null;
  }[];
const members = (w: SocialWorld, circleId: string) =>
  (w.db.prepare(`SELECT person_id FROM circle_members WHERE circle_id = ? AND excluded = 0 ORDER BY person_id`).pluck().all(circleId) as string[]).sort();
const batches = (w: SocialWorld) => w.db.prepare('SELECT count(*) FROM change_batches').pluck().get() as number;
const sorted = (xs: string[]) => [...xs].sort();

describe('community detection', () => {
  it('splits two cliques, keeps sizes 3–60, scores shares, and is deterministic', () => {
    const p = (a: string, b: string, w: number): PairAgg => ({
      a: a < b ? a : b,
      b: a < b ? b : a,
      byType: { co_attend: { w, n: 1, last: null } },
      closeLabelW: 0,
      weight: w,
      strength: 0,
      tier: 'faint',
      dominant: null,
      last: null,
      evidenceCount: 1,
    });
    const pairs: PairAgg[] = [];
    const A = ['a1', 'a2', 'a3', 'a4'];
    const B = ['b1', 'b2', 'b3'];
    for (const g of [A, B]) for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) pairs.push(p(g[i]!, g[j]!, 2));
    pairs.push(p('a1', 'b1', 0.3), p('x', 'a1', 2), p('x', 'a2', 2), p('x', 'b1', 1.2), p('y', 'z', 3));
    const visible = new Set([...A, ...B, 'x', 'y', 'z']);
    const g = buildCircleGraph(pairs, visible);
    expect(g.adj.get('a1')!.has('b1')).toBe(false); // strength < 0.2
    const d = detectCommunities(g);
    expect(d.communities.map((c) => c.core)).toEqual([
      ['a1', 'a2', 'a3', 'a4', 'x'],
      ['b1', 'b2', 'b3'],
    ]);
    expect(d.communities[0]!.scores.get('a3')).toBe(1);
    expect(d.communities[1]!.near.get('x')).toBeGreaterThanOrEqual(0.25);
    expect(detectCommunities(g)).toEqual(d);
    expect(jaccard(new Set(['a', 'b']), new Set(['b', 'c']))).toBeCloseTo(1 / 3);
    const m = greedyMatch([new Set(['a', 'b', 'c']), new Set(['d', 'e'])], [{ key: 'old1', members: new Set(['a', 'b']) }, { key: 'old2', members: new Set(['a', 'b', 'c', 'd']) }], 0.5);
    expect([...m.entries()]).toEqual([[0, { key: 'old2', jaccard: 0.75 }]]);
    const r1 = seededRng(1);
    const r2 = seededRng(1);
    expect([r1(), r1()]).toEqual([r2(), r2()]);
  });
});

describe('weekly circles pass', () => {
  it('creates named auto circles, then stays stable', async () => {
    const { w, climbers, readers, bridge } = fixture();
    const r = await runCircles(w.db, { now: NOW });
    expect(r).toMatchObject({ complete: true, stats: { communities: 2, created: 2 } });
    const cs = circles(w);
    expect(cs.map((c) => [c.name, c.kind, c.status])).toEqual([
      ['Climbing crew', 'auto', 'active'],
      ['Gus, Hana & Ivo +1', 'auto', 'active'],
    ]);
    expect(cs.every((c) => /^#[0-9a-f]{6}$/.test(c.color_hex!))).toBe(true);
    expect(members(w, cs[0]!.id)).toEqual(sorted([...climbers, bridge]));
    expect(members(w, cs[1]!.id)).toEqual(sorted(readers));
    expect(w.db.prepare(`SELECT named_by, json_extract(name_basis, '$.kind') AS k FROM circle_auto_meta WHERE circle_id = ?`).get(cs[0]!.id)).toEqual({
      named_by: 'rule',
      k: 'group',
    });
    // the bridge person is a suggested addition for the readers
    expect(w.db.prepare('SELECT person_id, reason FROM circle_suggestions WHERE circle_id = ?').all(cs[1]!.id)).toEqual([
      { person_id: bridge, reason: 'near_member' },
    ]);
    const feed = w.db.prepare(`SELECT title, actor FROM change_batches ORDER BY seq`).all() as { title: string; actor: string }[];
    expect(feed.every((b) => b.actor === 'agent' && !/Climb|Fay|Gus/.test(b.title))).toBe(true);

    const before = batches(w);
    const again = await runCircles(w.db, { now: NOW + 7 * DAY });
    expect(again.stats).toMatchObject({ created: 0, updated: 0, membersAdded: 0, membersDropped: 0 });
    expect(batches(w)).toBe(before);
    expect(circles(w).map((c) => c.id)).toEqual(cs.map((c) => c.id));
  });

  it('follows drift but respects the owner: removed members stay out, renamed circles keep their name', async () => {
    const { w, climbers } = fixture();
    await runCircles(w.db, { now: NOW });
    const crew = circles(w).find((c) => c.name === 'Climbing crew')!;
    // the owner removes Eli and renames the circle
    editMembers(w.db, 'circle', crew.id, { add: [], remove: [climbers[4]!] }, NOW);
    updateCollection(w.db, 'circle', crew.id, { name: 'Rock gym' }, NOW);
    // a new climber shows up; Dina drifts away entirely
    const kai = w.person('Kai', 'Climb');
    for (const c of climbers.slice(0, 3)) link(w, kai, c, 1, 'event:e9');
    w.db.prepare(`DELETE FROM edge_evidence WHERE a_id = ? OR b_id = ?`).run(climbers[3]!, climbers[3]!);
    const r = await runCircles(w.db, { now: NOW + 7 * DAY });
    expect(r.stats.membersAdded).toBe(1);
    expect(r.stats.membersDropped).toBe(1);
    const now = members(w, crew.id);
    expect(now).toContain(kai);
    expect(now).not.toContain(climbers[3]);
    expect(now).not.toContain(climbers[4]); // the owner's removal is sticky
    expect(circles(w).find((c) => c.id === crew.id)!.name).toBe('Rock gym');
  });

  it('never revives what the owner undid or deleted', async () => {
    const { w } = fixture();
    await runCircles(w.db, { now: NOW });
    const created = w.db.prepare(`SELECT id FROM change_batches WHERE kind = 'circle' ORDER BY seq`).pluck().all() as string[];
    undoBatch(w.db, created[1]!, { now: NOW });
    const readers = circles(w).find((c) => c.status === 'retracted')!;
    expect(readers).toBeDefined();
    const r = await runCircles(w.db, { now: NOW + 7 * DAY });
    expect(r.stats).toMatchObject({ created: 0, leftAlone: 1 });
    expect(circles(w).filter((c) => c.status === 'active')).toHaveLength(1);
  });

  it("doesn't duplicate the owner's own circle: suggests additions there instead", async () => {
    const { w, readers } = fixture();
    const legacy = uuidv7();
    w.db
      .prepare(`INSERT INTO circles (id, name, kind, locked, status, created_at, updated_at) VALUES (?, 'Book club', 'user', 1, 'active', ?, ?)`)
      .run(legacy, NOW, NOW);
    for (const p of readers.slice(0, 3))
      w.db.prepare(`INSERT INTO circle_members (circle_id, person_id, origin, created_at, updated_at) VALUES (?, ?, 'legacy', ?, ?)`).run(legacy, p, NOW, NOW);
    const r = await runCircles(w.db, { now: NOW });
    expect(r.stats).toMatchObject({ created: 1, userMatches: 1 });
    expect(w.db.prepare(`SELECT person_id FROM circle_suggestions WHERE circle_id = ? AND reason = 'community'`).pluck().all(legacy)).toEqual([readers[3]]);
    expect(members(w, legacy)).toEqual(sorted(readers.slice(0, 3)));
  });

  it('names with the LLM when available (egress, effort low, bounds checked) and falls back otherwise', async () => {
    const { w } = fixture();
    const llm = new FakeLlmClient().on('circle_name', { json: { name: 'Weekend climbers', emoji: '🧗', description: 'Friends who climb on weekends', conf: 0.9 } });
    const r = await runCircles(w.db, { now: NOW, llm, egress: new FakeEgress() });
    expect(r.stats.llmNamed).toBe(2);
    expect(circles(w).map((c) => [c.name, c.icon])).toEqual([
      ['Weekend climbers', '🧗'],
      ['Weekend climbers', '🧗'],
    ]);
    expect(llm.calls.every((c) => c.kind === 'circle_name' && c.route === 'circle_name' && c.effort === 'low' && !c.fallbacks)).toBe(true);
    expect(llm.calls[0]!.userText).toContain('Climbing crew');
    expect(llm.calls[0]!.userText).not.toMatch(/\+1\d{10}|@example\.com/);
    expect(w.db.prepare(`SELECT count(*) FROM circle_auto_meta WHERE named_by = 'llm'`).pluck().get()).toBe(2);

    const { w: w2 } = fixture();
    const bad = new FakeLlmClient().on('circle_name', { json: { name: 'A very long circle name', emoji: null, description: 'x', conf: 0.9 } });
    await runCircles(w2.db, { now: NOW, llm: bad, egress: new FakeEgress() });
    expect(circles(w2).map((c) => c.name)).toContain('Climbing crew');

    const { w: w3 } = fixture();
    await runCircles(w3.db, { now: NOW, llm: new FakeLlmClient({ configured: false }), egress: new FakeEgress() });
    expect(circles(w3).map((c) => c.name)).toContain('Climbing crew');
  });

  it('LLM-excluded people and conversations never reach the naming call', async () => {
    const { w, climbers } = fixture();
    const crew = w.db.prepare(`SELECT id FROM conversations WHERE title = 'Climbing crew'`).pluck().get() as string;
    writeSettings(w.db, { 'llm.excluded_person_ids': [climbers[0]!], 'llm.excluded_conversation_ids': [crew] }, { actor: 'user', allowInternal: true });
    const llm = new FakeLlmClient().on('circle_name', { json: { name: 'Weekend climbers', emoji: null, description: 'Friends who climb', conf: 0.9 } });
    await runCircles(w.db, { now: NOW, llm, egress: new FakeEgress() });
    expect(llm.calls.length).toBeGreaterThan(0);
    // without the exclusions the climbers' packet carries both
    const { w: plain } = fixture();
    const open = new FakeLlmClient().on('circle_name', { json: { name: 'Weekend climbers', emoji: null, description: 'Friends who climb', conf: 0.9 } });
    await runCircles(plain.db, { now: NOW, llm: open, egress: new FakeEgress() });
    expect(open.calls.some((c) => c.userText.includes('Ari') && c.userText.includes('Climbing crew'))).toBe(true);
    for (const c of llm.calls) {
      expect(c.userText).not.toContain('Ari');
      expect(c.userText).not.toContain('Climbing crew');
    }
  });

  it('hidden people never join a circle', async () => {
    const { w, climbers } = fixture();
    const hid = w.person('Hal', 'Hidden', { is_hidden: 1 });
    for (const c of climbers) link(w, hid, c, 2, 'event:e7');
    await runCircles(w.db, { now: NOW });
    expect(w.db.prepare('SELECT count(*) FROM circle_members WHERE person_id = ?').pluck().get(hid)).toBe(0);
  });

  it('the job runs weekly at the timetable slot, with the injected (inert) LLM', async () => {
    const jobs = circlesJobs({ services: () => ({ llm: new FakeLlmClient({ configured: false }), egress: new FakeEgress() }) as never });
    expect(jobs.map((j) => [j.name, j.schedule])).toEqual([['circles', { kind: 'weekly', dow: AGENT_TIMES.circles.dow, at: AGENT_TIMES.circles.at }]]);
    const { w } = fixture();
    const out = await jobs[0]!.run({ db: w.db, jobRunId: 1, trigger: 'manual', now: () => NOW, log: nullLogger, signal: new AbortController().signal });
    expect(out).toMatchObject({ status: 'ok', stats: { created: 2 } });
  });
});

describe('naming helpers', () => {
  it('validates LLM names and cleans titles', () => {
    expect(validateName({ name: 'Book club', emoji: '📚', description: 'Monthly readers', conf: 0.8 })).toEqual([]);
    expect(validateName({ name: 'One two three four', emoji: null, description: 'x', conf: 0.8 }).length).toBe(1);
    expect(validateName({ name: 'P1a crew', emoji: null, description: 'x', conf: 0.8 })).toContain('name contains a token');
    expect(validateName({ name: 'Crew', emoji: 'ab', description: 'x', conf: 2 }).length).toBe(2);
    const ctx = { redact: (t: string | null) => t };
    expect(cleanTitle(ctx, '  Ski   trip  ')).toBe('Ski trip');
    expect(cleanTitle(ctx, 'call +12025550123')).not.toContain('5550123');
    expect(cleanTitle({ redact: () => '…' }, 'Hal & me')).toBeNull();
  });
});

describe('circle generators', () => {
  it('circle_neglect for a quiet circle; check-in wildcard', async () => {
    const { w, climbers } = fixture();
    await runCircles(w.db, { now: NOW });
    const crew = circles(w).find((c) => c.name === 'Climbing crew')!;
    const ins = w.db.prepare(
      `INSERT INTO person_stats (person_id, last_at, expected_gap_d, historical_strength, tie_strength, computed_at) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    climbers.forEach((c, i) => ins.run(c, NOW - (60 + i) * DAY, 7, 60, 40 - i, NOW));
    const ctx: GeneratorContext = { db: w.db, now: NOW, timeZone: 'UTC', settings: settingsSnapshot(w.db), runId: null, log: nullLogger };
    const out = circleNeglectGenerator.generate(ctx) as Candidate[];
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'circle_neglect', subjectKey: crew.id, personIds: [], base: 0.4, links: { circleId: crew.id } });
    expect(out[0]!.payload).toMatchObject({ silenceD: 60, memberCount: 6, memberIds: climbers.slice(0, 3) });
    // recent contact with one member: not neglected
    w.db.prepare('UPDATE person_stats SET last_at = ? WHERE person_id = ?').run(NOW - DAY, climbers[2]);
    expect(circleNeglectGenerator.generate(ctx)).toEqual([]);
    w.db.prepare('UPDATE person_stats SET last_at = ? WHERE person_id = ?').run(NOW - 20 * DAY, climbers[2]);
    const wild = circleCheckinWildcard.generate(ctx, () => 0) as Candidate[];
    expect(wild.map((c) => c.subjectKey)).toEqual([`checkin:${crew.id}`]);
  });
});
