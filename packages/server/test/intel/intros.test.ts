import { beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@yb/shared';
import { drain } from '../../src/intel/common';
import { introGenerator, introPairWildcard } from '../../src/intel/generators';
import { INTRO, introCandidates, scorePairsSteps, storePairs, type PairScore } from '../../src/intel/intros';
import { nullLogger } from '../../src/ops/logger';
import type { GeneratorContext } from '../../src/pipeline/suggestions/types';
import { settingsSnapshot } from '../../src/settings/registry';
import { intelWorld, NOW, setSetting, TZ, type IntelWorld } from './world';

let w: IntelWorld;
let ana: string, bo: string, cy: string, dee: string, eli: string, fay: string, gus: string, ivy: string, hid: string;
let pairs: PairScore[];

const key = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const pair = (a: string, b: string) => pairs.find((p) => `${p.a}|${p.b}` === key(a, b));
const ctx = (): GeneratorContext => ({ db: w.db, now: NOW, timeZone: TZ, settings: settingsSnapshot(w.db), runId: null, log: nullLogger });

beforeEach(() => {
  w = intelWorld();
  ana = w.person('Ana', 'Arbor', { tie: 70, historical: 80 });
  bo = w.person('Bo', 'Birch', { tie: 50, historical: 60 });
  cy = w.person('Cy', 'Cedar', { tie: 45, historical: 55 });
  dee = w.person('Dee', 'Dune', { tie: 60, historical: 60 });
  eli = w.person('Eli', 'Elm', { tie: 80, historical: 80 });
  fay = w.person('Fay', 'Fern', { tie: 55, historical: 30 });
  gus = w.person('Gus', 'Gale', { tie: 10, historical: 20 });
  ivy = w.person('Ivy', 'Iris', { tie: 42, historical: 10 });
  hid = w.person('Hal', 'Hush', { tie: 90, historical: 90, extra: { is_hidden: 1 } });
  for (const [p, city] of [
    [ana, 'Austin'],
    [bo, 'Austin, TX'],
    [cy, 'Austin'],
    [ivy, 'Austin'],
    [dee, 'Denver'],
    [fay, 'Boulder'],
    [eli, 'Austin'],
    [hid, 'Austin'],
    [gus, 'Austin'],
  ] as const) {
    w.fact(p, 'location_current', city);
  }
  w.fact(ana, 'interest', 'climbing');
  w.fact(ana, 'interest', 'sourdough');
  w.fact(bo, 'interest', 'climbing');
  w.fact(bo, 'interest', 'jazz');
  w.fact(dee, 'interest', 'jazz');
  w.fact(bo, 'interest', 'sourdough');
  w.fact(eli, 'interest', 'climbing');
  w.fact(hid, 'interest', 'climbing');
  w.fact(ivy, 'other', 'looking for a climbing partner');
  // Ana and Cy share a small group chat; Ana and Dee already know each other; Bo and Fay are siblings.
  const conv = uuidv7();
  w.db.prepare(`INSERT INTO conversations (id, source, source_conv_id, kind, title, member_count, created_at, updated_at) VALUES (?, 'imessage', ?, 'group', 'Crew', 4, ?, ?)`).run(conv, conv, NOW, NOW);
  for (const p of [ana, cy]) {
    w.db.prepare(`INSERT INTO conversation_members (conversation_id, identity_id, source, first_seen_at, last_seen_at) VALUES (?, ?, 'roster', ?, ?)`).run(conv, w.phone(p), NOW, NOW);
  }
  w.edge(ana, dee, 0.3);
  const [x, y] = bo < fay ? [bo, fay] : [fay, bo];
  w.db.prepare(`INSERT INTO edge_labels (id, a_id, b_id, label, confidence, origin, created_at, updated_at) VALUES (?, ?, ?, 'sibling', 0.9, 'llm', ?, ?)`).run(uuidv7(), x, y, NOW, NOW);
  // Eli opted out with a tag.
  const tag = uuidv7();
  w.db.prepare(`INSERT INTO tags (id, name, created_at, updated_at) VALUES (?, 'No intros', ?, ?)`).run(tag, NOW, NOW);
  w.db.prepare(`INSERT INTO person_tags (person_id, tag_id, origin, created_at) VALUES (?, ?, 'user', ?)`).run(eli, tag, NOW);
  pairs = drain(scorePairsSteps(w.db, NOW));
});

describe('intro pair scoring', () => {
  it('scores interest overlap (IDF-weighted), same metro, ties and a need match', () => {
    const ab = pair(ana, bo)!;
    expect(ab).toBeTruthy();
    expect(ab.sameMetro).toBe(true);
    expect(ab.interest).toBeGreaterThan(0.1);
    expect(ab.score).toBeGreaterThanOrEqual(INTRO.threshold);
    expect(ab.shared).toHaveLength(4); // both people’s fact ids for climbing + sourdough
    expect(pairs[0]).toEqual(ab);
    const ib = pair(ivy, bo)!;
    expect(ib.needMatch).toBe(true);
    expect(ib.score).toBeCloseTo(0.3 + 0.2 * 0.42 + 0.1, 3);
  });

  it('never pairs people who already know each other, share a group, are family, opted out, are weak ties or hidden', () => {
    expect(pair(ana, cy)).toBeUndefined();
    expect(pair(ana, dee)).toBeUndefined();
    expect(pair(bo, fay)).toBeUndefined();
    const everyone = pairs.flatMap((p) => [p.a, p.b]);
    expect(everyone).not.toContain(eli);
    expect(everyone).not.toContain(gus);
    expect(everyone).not.toContain(hid);
    expect(everyone).not.toContain(w.me);
  });

  it('opting out also works through people.custom', () => {
    w.db.prepare(`UPDATE people SET custom = ? WHERE id = ?`).run(JSON.stringify({ no_intros: true }), bo);
    const again = drain(scorePairsSteps(w.db, NOW));
    expect(again.flatMap((p) => [p.a, p.b])).not.toContain(bo);
  });
});

describe('intro candidates', () => {
  it('the best pairs, each person once, the closer person first (the draft goes to them only)', async () => {
    storePairs(w.db, pairs, NOW);
    const cands = introCandidates(w.db);
    const people = cands.flatMap((c) => c.personIds);
    expect(new Set(people).size).toBe(people.length);
    expect(cands[0]).toMatchObject({ kind: 'intro', personIds: [ana, bo], subjectKey: key(ana, bo), links: { relatedPersonId: bo } });
    expect(cands[0]!.payload.draftTo).toBe(ana);
    expect(cands[0]!.base).toBe(pair(ana, bo)!.score);
    expect(cands[0]!.evidenceIds.every((e) => e.startsWith('F'))).toBe(true);
    expect((await introGenerator.generate(ctx())).length).toBe(cands.length);
    setSetting(w.db, 'intros.enabled', false);
    expect(await introGenerator.generate(ctx())).toEqual([]);
  });

  it('🎲 intro_pair draws a mid-score pair (0.3–0.45)', async () => {
    storePairs(w.db, pairs, NOW);
    const mid = pairs.filter((p) => p.score >= INTRO.keepFrom && p.score < INTRO.threshold);
    expect(mid.length).toBeGreaterThan(0);
    const [c] = await introPairWildcard.generate(ctx(), () => 0);
    expect(c?.kind).toBe('intro');
    const s = pair(c!.personIds[0]!, c!.personIds[1]!)!;
    expect(s.score).toBeGreaterThanOrEqual(INTRO.keepFrom);
    expect(s.score).toBeLessThan(INTRO.threshold);
  });
});
