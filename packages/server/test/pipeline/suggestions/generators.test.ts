import { describe, expect, it } from 'vitest';
import { circleCheckinWildcard, circleNeglectGenerator, lastTogether } from '../../../src/pipeline/suggestions/gen/circles';
import { coolingGenerator, dormantCloseWildcard, dormantGenerator, fadingGenerator, fadingSeverity } from '../../../src/pipeline/suggestions/gen/cadence';
import { localDayRange, sameDayYearsAgo } from '../../../src/pipeline/suggestions/gen/common';
import { memoryCandidates } from '../../../src/pipeline/suggestions/gen/memory';
import { commitmentGenerator, replyDebtGenerator, replyDebtPriority } from '../../../src/pipeline/suggestions/gen/obligations';
import { unseenKindWildcard } from '../../../src/pipeline/suggestions/gen/unseen';
import { allGenerators, allWildcardSources } from '../../../src/pipeline/suggestions/registry';
import { mulberry32 } from '../../../src/pipeline/suggestions/rng';
import type { Candidate, GeneratorContext } from '../../../src/pipeline/suggestions/types';
import { nullLogger } from '../../../src/ops/logger';
import { settingsSnapshot } from '../../../src/settings/registry';
import type { DB } from '../../../src/db/connection';
import { seedCommitment } from '../../helpers';
import { circle, commitment, DAY, fadingFriend, friend, HOUR, message, occasion, replyDebt, stats, suggestionsDb, T0 } from './world';

const ctxOf = (db: DB, now = T0, runId: string | null = null): GeneratorContext => ({
  db,
  now,
  timeZone: 'UTC',
  settings: settingsSnapshot(db),
  runId,
  log: nullLogger,
});

describe('cadence generators', () => {
  it('fading: severity from H and F (priority ×1.5), suppressed and hidden people excluded', () => {
    const db = suggestionsDb();
    const a = fadingFriend(db, 'Avery', 'Quill');
    fadingFriend(db, 'Bram', 'Ostrow', { fadingSuppressed: true });
    const hidden = friend(db, 'Hollis', 'Vane', { is_hidden: 1 });
    stats(db, hidden.id, { state: 'fading', historical: 90, fadingRatio: 8 });
    const out = fadingGenerator.generate(ctxOf(db)) as Candidate[];
    expect(out.map((c) => c.personIds[0])).toEqual([a.id]);
    expect(out[0]).toMatchObject({ kind: 'fading', subjectKey: a.id, payload: { silenceD: 60, expectedGapD: 10, fadingRatio: 6, historical: 80 } });
    expect(out[0]!.base).toBeCloseTo(0.8 * Math.min(1, Math.log2(6) / 3));
    expect(fadingSeverity({ historical_strength: 50, fading_ratio: 8, is_priority: 1 })).toBeCloseTo(0.75);
    expect(fadingSeverity({ historical_strength: 50, fading_ratio: 1, is_priority: 0 })).toBe(0);
    expect(fadingSeverity({ historical_strength: 50, fading_ratio: 8, is_priority: 0, fading_severity: 0.42 })).toBe(0.42);
  });

  it('cooling 0.6·H/100; dormant only once-strong (H ≥ 50); 🎲 dormant_close is H ≥ 50 and quiet > 180 d', () => {
    const db = suggestionsDb();
    const c = friend(db, 'Cleo', 'Marsh');
    stats(db, c.id, { state: 'cooling', historical: 70, momentum: -1.4 });
    const d = friend(db, 'Dev', 'Tanaka');
    stats(db, d.id, { state: 'dormant', historical: 65, silenceD: 400 });
    const weak = friend(db, 'Eli', 'Brand');
    stats(db, weak.id, { state: 'dormant', historical: 20, silenceD: 500 });
    const quiet = friend(db, 'Fen', 'Okafor');
    stats(db, quiet.id, { state: 'steady', historical: 55, silenceD: 200 });
    const cooling = coolingGenerator.generate(ctxOf(db)) as { base: number; personIds: string[] }[];
    expect(cooling).toHaveLength(1);
    expect(cooling[0]!.base).toBeCloseTo(0.42);
    expect((dormantGenerator.generate(ctxOf(db)) as { personIds: string[] }[]).map((x) => x.personIds[0])).toEqual([d.id]);
    const wild = dormantCloseWildcard.generate(ctxOf(db), mulberry32(1)) as { personIds: string[]; kind: string }[];
    expect(wild.map((x) => x.personIds[0]).sort()).toEqual([d.id, quiet.id].sort());
    expect(wild.every((x) => x.kind === 'dormant')).toBe(true);
  });

  it('cites the latest 1:1 message as evidence', () => {
    const db = suggestionsDb();
    const a = fadingFriend(db, 'Avery', 'Quill');
    const m = message(db, a.dm, T0 - 60 * DAY, a.phoneId, 'see you around');
    const [c] = fadingGenerator.generate(ctxOf(db)) as { evidenceIds: string[] }[];
    expect(c!.evidenceIds).toEqual([`m:${m}`]);
  });
});

describe('open-loop generators', () => {
  it('reply debt: normalized priority, heuristic < 0.6 hidden, expires 30 d after the question', () => {
    const db = suggestionsDb();
    const a = friend(db, 'Avery', 'Quill');
    stats(db, a.id, { tie: 50 });
    const debt = replyDebt(db, a, T0 - 48 * HOUR);
    const b = friend(db, 'Bram', 'Ostrow');
    replyDebt(db, b, T0 - 48 * HOUR, { classifier: 'heuristic', confidence: 0.4 });
    const out = replyDebtGenerator.generate(ctxOf(db)) as { base: number; subjectKey: string; evidenceIds: string[]; expiresAt: number; links: { replyDebtId: string } }[];
    expect(out).toHaveLength(1);
    expect(out[0]!.subjectKey).toBe(debt.id);
    expect(out[0]!.base).toBeCloseTo(0.65 / 1.3);
    expect(out[0]!.evidenceIds).toEqual([`m:${debt.msgId}`]);
    expect(out[0]!.expiresAt).toBe(T0 - 48 * HOUR + 30 * DAY);
    expect(out[0]!.links.replyDebtId).toBe(debt.id);
    expect(replyDebtPriority({ urgency: 'high', tie_strength: 100, is_priority: 1, asked_at: T0 - 20 * DAY }, T0)).toBeCloseTo(1.5 * 1.3 * 0.5);
  });

  it('commitments: due (or within 2 days, or vague after 21 d); waiting-on-them only for strong ties at ×0.5', () => {
    const db = suggestionsDb();
    const a = friend(db, 'Avery', 'Quill');
    const due = commitment(db, a.id);
    commitment(db, a.id, { due_end: T0 + 10 * DAY }); // not due yet
    const vague = commitment(db, a.id, { due_end: null, due_precision: 'vague', created_at: T0 - 30 * DAY });
    commitment(db, a.id, { due_end: T0 - 40 * DAY }); // lapsed
    const b = friend(db, 'Bram', 'Ostrow');
    commitment(db, b.id, { owner: 'them' }); // weak tie: not surfaced
    const c = friend(db, 'Cleo', 'Marsh');
    stats(db, c.id, { tie: 75 });
    const theirs = commitment(db, c.id, { owner: 'them' });
    const out = commitmentGenerator.generate(ctxOf(db)) as { subjectKey: string; base: number; payload: Record<string, unknown> }[];
    expect(out.map((x) => x.subjectKey).sort()).toEqual([due, vague, theirs].sort());
    expect(out.find((x) => x.subjectKey === due)!.base).toBe(1);
    expect(out.find((x) => x.subjectKey === theirs)!.base).toBeCloseTo(0.3);
    expect(out.find((x) => x.subjectKey === due)!.payload).toMatchObject({ owner: 'me', overdueD: 1 });
  });
});

describe('circle generators', () => {
  it('circle neglect: last time together with ≥2 members 45+ days ago; 🎲 check-in for any circle not seen in 2 weeks', () => {
    const db = suggestionsDb();
    const ppl = ['Avery', 'Bram', 'Cleo', 'Dev'].map((n) => friend(db, n, 'Climber'));
    const crew = circle(db, 'Climbing crew', ppl.map((p) => p.id));
    const occ = occasion(db, T0 - 60 * DAY, [ppl[0]!.id, ppl[1]!.id]);
    expect(lastTogether(db, ppl.map((p) => p.id), T0)).toEqual({ at: T0 - 60 * DAY, ref: `occ:${occ}` });
    const out = circleNeglectGenerator.generate(ctxOf(db)) as { personIds: string[]; subjectKey: string; payload: Record<string, unknown>; links: { circleId: string } }[];
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ personIds: [], subjectKey: crew, links: { circleId: crew }, payload: { sinceD: 60, memberCount: 4 } });
    expect((circleCheckinWildcard.generate(ctxOf(db), mulberry32(1)) as object[]).length).toBe(1);

    // a recent group chat with two of them (I posted) counts as together
    const gid = (() => {
      const id = '019a0000-0000-7000-8000-0000000000c1';
      db.prepare(`INSERT INTO conversations (id, source, source_conv_id, kind, member_count, created_at, updated_at) VALUES (?, 'imessage', ?, 'group', 4, ?, ?)`).run(id, id, T0, T0);
      for (const p of ppl.slice(0, 3)) db.prepare(`INSERT INTO conversation_members (conversation_id, identity_id, source, first_seen_at, last_seen_at) VALUES (?, ?, 'roster', ?, ?)`).run(id, p.phoneId, T0, T0);
      return id;
    })();
    message(db, gid, T0 - 3 * DAY, null, 'who is in for saturday');
    expect(circleNeglectGenerator.generate(ctxOf(db))).toEqual([]);
    expect(circleCheckinWildcard.generate(ctxOf(db), mulberry32(1))).toEqual([]);
  });

  it('small circles (< 3 visible members) are skipped', () => {
    const db = suggestionsDb();
    const a = friend(db, 'Avery', 'Quill');
    const h = friend(db, 'Hollis', 'Vane', { is_hidden: 1 });
    const b = friend(db, 'Bram', 'Ostrow');
    circle(db, 'Duo', [a.id, b.id, h.id]);
    occasion(db, T0 - 60 * DAY, [a.id, b.id]);
    expect(circleNeglectGenerator.generate(ctxOf(db))).toEqual([]);
  });
});

describe('memory generator', () => {
  it('"on this day": a social occasion a year ago and a long two-way conversation, naming only people with a follow-up', () => {
    const db = suggestionsDb();
    const a = friend(db, 'Avery', 'Quill');
    const b = friend(db, 'Bram', 'Ostrow');
    stats(db, b.id, { tie: 80 });
    const c = friend(db, 'Cleo', 'Marsh');
    const yearAgo = T0 - 365 * DAY;
    const occ = occasion(db, yearAgo, [a.id, b.id]);
    occasion(db, yearAgo, [c.id], { sensitive: 1 }); // sensitive: never a memory
    occasion(db, yearAgo - 2 * DAY, [c.id]); // not this day
    db.prepare(
      `INSERT INTO interactions (id, person_id, kind, conversation_id, started_at, msgs_from_me, msgs_from_them, origin, created_at, updated_at)
       VALUES ('i-1', ?, 'dm_session', ?, ?, 6, 7, 'derived', ?, ?)`,
    ).run(c.id, c.dm, yearAgo + HOUR, T0, T0);
    // A year-old event is over: no memory without a documented intent to follow up from around then, still open.
    expect(memoryCandidates(db, T0, 'UTC')).toEqual([]);
    seedCommitment(db, a.id, { what: 'send the photos', created_at: T0 - DAY }); // made now, not then
    seedCommitment(db, b.id, { kind: 'call', what: 'call about the job', created_at: yearAgo + HOUR });
    seedCommitment(db, c.id, { kind: 'intro', what: 'intro to the climbing gym', created_at: yearAgo + 2 * HOUR });
    seedCommitment(db, a.id, { kind: 'send', what: 'send the photos', status: 'done', created_at: yearAgo + HOUR });
    const out = memoryCandidates(db, T0, 'UTC');
    expect(out.map((x) => x.subjectKey)).toEqual([`occ:${occ}`, `conv:${c.dm}:2025-10-14`]);
    expect(out[0]).toMatchObject({ personIds: [b.id], payload: { attendeeCount: 1 } });
    expect(out[1]).toMatchObject({ kind: 'memory', personIds: [c.id], payload: { messages: 13, source: 'conversation' } });
    const [, end] = localDayRange('2026-10-14', 'UTC');
    expect(out.every((x) => x.expiresAt === end)).toBe(true);
    expect(sameDayYearsAgo('2028-02-29')).toBe('2027-02-28');
    expect(localDayRange('2026-03-08', 'America/New_York')[1] - localDayRange('2026-03-08', 'America/New_York')[0]).toBe(23 * HOUR);
  });
});

describe('unseen-kind wildcard', () => {
  it('offers this run’s candidates of kinds no digest carried in 14 days', () => {
    const db = suggestionsDb();
    const ins = db.prepare(
      `INSERT INTO suggestions (id, kind, dedupe_key, subject_key, score, base_score, signals, status, last_seen_run, selected_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0.1, 0.1, '{}', ?, ?, ?, ?, ?)`,
    );
    ins.run('s1', 'cooling', 'cooling:x', 'x', 'candidate', 'run1', null, T0, T0);
    ins.run('s2', 'fading', 'fading:y', 'y', 'candidate', 'run1', null, T0, T0);
    ins.run('s3', 'fading', 'fading:z', 'z', 'ignored', 'run0', T0 - 3 * DAY, T0, T0); // fading shown 3 days ago
    const out = unseenKindWildcard.generate(ctxOf(db, T0, 'run1'), mulberry32(1)) as { kind: string; subjectKey: string }[];
    expect(out.map((x) => `${x.kind}:${x.subjectKey}`)).toEqual(['cooling:x']);
  });
});

describe('registry', () => {
  it('one generator per kind and one source per wildcard generator', () => {
    const kinds = allGenerators().map((g) => g.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
    for (const k of ['fading', 'cooling', 'dormant', 'reply_debt', 'commitment_due', 'circle_neglect', 'memory']) expect(kinds).toContain(k);
    const gens = allWildcardSources().map((s) => s.generator);
    expect(new Set(gens).size).toBe(gens.length);
    for (const g of ['dormant_close', 'unseen_kind', 'memory', 'circle_checkin']) expect(gens).toContain(g);
  });
});
