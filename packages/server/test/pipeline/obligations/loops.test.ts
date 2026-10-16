import { OpenLoopCounts, OpenLoopList, uuidv7 } from '@yb/shared';
import { describe, expect, it } from 'vitest';
import { rebuildPersonCanon } from '../../../src/db/canon';
import { HttpError } from '../../../src/http/errors';
import { withBatch } from '../../../src/journal/batch';
import { startRun } from '../../../src/journal/runs';
import { undoBatch } from '../../../src/journal/undo';
import {
  applyLoopAction,
  commitmentCandidates,
  generators,
  loopFeedbackFromSuggestion,
  obligationsJobs,
  openLoopCounts,
  openLoops,
  openLoopsByPerson,
  personOpenLoops,
  replyDebtCandidates,
  runCommitments,
  runReplyDebts,
  todayOpenLoops,
  upsertCommitmentFromExtraction,
  type ExtractedCommitmentInput,
} from '../../../src/pipeline/obligations';
import { allGenerators } from '../../../src/pipeline/suggestions/registry';
import type { JobContext } from '../../../src/scheduler/scheduler';
import { AGENT_TIMES } from '../../../src/scheduler/timetable';
import { nullLogger } from '../../../src/ops/logger';
import { ago, DAY, debts, HOUR, NOW, world, type World } from './world';

function promise(w: World, personId: string, conv: string, o: Partial<ExtractedCommitmentInput> & { at?: number; text?: string; from?: string } = {}) {
  const m = w.msg(conv, o.from ?? 'me', o.at ?? ago(3 * DAY), o.text ?? "I'll send the photos");
  const runId = startRun(w.db, 'nightly', { now: NOW });
  return withBatch(w.db, { runId, kind: 'fact', title: 'Read a conversation', actor: 'agent' }, (t) =>
    upsertCommitmentFromExtraction(t, {
      personId,
      owner: 'ME',
      kind: 'favor',
      what: 'Send the photos',
      due: { kind: 'date', start: '2026-10-13', end: null },
      status: 'open',
      conversationId: conv,
      evidence: [{ messageId: m, quote: o.text ?? "I'll send the photos" }],
      confidence: 0.9,
      ...o,
    }),
  ).result.commitmentId!;
}

/** A world with: a reply debt from Sam, a due promise to Sam, a waiting-on from Lee (T 30) and from Kit (priority). */
function scene() {
  const w = world();
  const sam = w.person('Sam', { tie: 80 });
  const lee = w.person('Lee', { tie: 30 });
  const kit = w.person('Kit', { priority: true });
  const sdm = w.dm(sam.identity);
  w.msg(sdm, sam.identity, ago(2 * DAY), 'can you send me the address?');
  runReplyDebts(w.db, { now: NOW });
  const mine = promise(w, sam.id, sdm);
  const ldm = w.dm(lee.identity);
  const leeOwes = promise(w, lee.id, ldm, { owner: 'THEM', from: lee.identity, what: 'Lend the tent', text: 'I can lend you my tent' });
  const kdm = w.dm(kit.identity);
  const kitOwes = promise(w, kit.id, kdm, { owner: 'THEM', from: kit.identity, what: 'Book the court', text: 'I will book the court' });
  runCommitments(w.db, { now: NOW });
  return { w, sam, lee, kit, sdm, mine, leeOwes, kitOwes };
}

describe('open-loop read model', () => {
  it('global lists validate against the shared DTOs; waiting-on is gated to priority people or T ≥ 60', () => {
    const { w, sam, kit } = scene();
    const list = OpenLoopList.parse(openLoops(w.db, { now: NOW }));
    expect(list.replyDebts.map((l) => [l.person.id, l.type, l.likely, l.owner])).toEqual([[sam.id, 'reply_debt', true, 'me']]);
    expect(list.replyDebts[0]!.evidence[0]).toMatchObject({ kind: 'message', quote: 'can you send me the address?', source: 'imessage' });
    expect(list.commitments.map((l) => [l.person.id, l.title, l.status])).toEqual([[sam.id, 'Send the photos', 'due']]);
    expect(list.commitments[0]!.evidence[0]!.ref).toMatch(/^K/);
    expect(list.waitingOn.map((l) => l.person.id)).toEqual([kit.id]);
    expect(OpenLoopCounts.parse(openLoopCounts(w.db, { now: NOW }))).toEqual({ replyDebts: 1, commitments: 1, waitingOn: 1 });
    const today = todayOpenLoops(w.db, { now: NOW, previewLimit: 2 });
    expect(today.counts).toEqual({ replyDebts: 1, commitments: 1, waitingOn: 1 });
    expect(today.preview).toHaveLength(2);
    expect(today.preview.map((l) => l.type).sort()).toEqual(['commitment', 'reply_debt']);
  });

  it('the person page shows every waiting-on item of theirs, through merges; hidden people show nothing', () => {
    const { w, lee, sam } = scene();
    const leeLoops = OpenLoopList.parse(personOpenLoops(w.db, lee.id, { now: NOW }));
    expect(leeLoops.waitingOn.map((l) => l.title)).toEqual(['Lend the tent']);
    // A merged-away duplicate of Sam resolves to Sam.
    const dup = w.person('Sammy');
    w.db.prepare(`UPDATE people SET merged_into_id = ?, status = 'merged' WHERE id = ?`).run(sam.id, dup.id);
    rebuildPersonCanon(w.db);
    expect(personOpenLoops(w.db, dup.id, { now: NOW }).replyDebts).toHaveLength(1);
    w.db.prepare('UPDATE people SET is_hidden = 1 WHERE id = ?').run(sam.id);
    expect(personOpenLoops(w.db, sam.id, { now: NOW })).toEqual({ replyDebts: [], commitments: [], waitingOn: [], nextCursor: null });
    expect(openLoopCounts(w.db, { now: NOW }).replyDebts).toBe(0);
    expect(replyDebtCandidates(w.db, NOW)).toEqual([]);
  });

  it('sensitive promises read "Something personal" and carry no quotes', () => {
    const w = world();
    const sam = w.person('Sam');
    const dm = w.dm(sam.identity);
    promise(w, sam.id, dm, { sensitive: true, what: 'Drive to the clinic' });
    const [loop] = personOpenLoops(w.db, sam.id, { now: NOW }).commitments;
    expect(loop!.title).toBe('Something personal');
    expect(loop!.evidence.every((e) => e.quote === null)).toBe(true);
    const [cand] = commitmentCandidates(w.db, NOW);
    expect(cand!.sensitive).toBe(true);
  });

  it('pages with an opaque cursor', () => {
    const w = world();
    for (let i = 0; i < 3; i++) {
      const p = w.person(`Pal${i}`);
      w.msg(w.dm(p.identity), p.identity, ago((10 + i) * HOUR), 'are you around this weekend?');
    }
    runReplyDebts(w.db, { now: NOW });
    const first = openLoops(w.db, { now: NOW, limit: 2 });
    expect(first.replyDebts).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = openLoops(w.db, { now: NOW, limit: 2, cursor: first.nextCursor });
    expect(second.replyDebts).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(openLoopsByPerson(w.db, [first.replyDebts[0]!.person.id], { now: NOW }).get(first.replyDebts[0]!.person.id)).toHaveLength(1);
  });
});

describe('loop actions', () => {
  it('done / dismiss / wrong / snooze are journaled (undoable) and leave a feedback row', () => {
    const { w, mine } = scene();
    const debtId = debts(w.db)[0]!.id as string;
    const done = applyLoopAction(w.db, 'reply_debt', debtId, { action: 'done' }, { channel: 'web', now: NOW });
    expect(done).toMatchObject({ status: 'replied' });
    expect(done.batchId).toBeTruthy();
    expect(applyLoopAction(w.db, 'reply_debt', debtId, { action: 'done' }, { channel: 'web', now: NOW }).batchId).toBeNull();
    expect(() => applyLoopAction(w.db, 'reply_debt', debtId, { action: 'snooze', until: NOW + DAY }, { channel: 'web', now: NOW })).toThrow(HttpError);
    undoBatch(w.db, done.batchId!, { now: NOW + 1 });
    expect(debts(w.db)[0]).toMatchObject({ status: 'open' });

    const snz = applyLoopAction(w.db, 'commitment', mine, { action: 'snooze', until: NOW + 2 * DAY }, { channel: 'imessage', now: NOW });
    expect(snz.status).toBe('snoozed');
    expect(openLoopCounts(w.db, { now: NOW }).commitments).toBe(0);
    expect(personOpenLoops(w.db, snz.personId, { now: NOW }).commitments.map((l) => l.status)).toEqual(['snoozed']);
    expect(() => applyLoopAction(w.db, 'commitment', mine, { action: 'snooze', until: NOW - 1 }, { channel: 'web', now: NOW })).toThrow(/future/);
    expect(applyLoopAction(w.db, 'commitment', mine, { action: 'wrong' }, { channel: 'web', now: NOW }).status).toBe('retracted');
    expect(() => applyLoopAction(w.db, 'commitment', 'missing', { action: 'done' }, { channel: 'web', now: NOW })).toThrow(/not found/);
    const fb = w.db.prepare(`SELECT subject_type, action, channel FROM feedback ORDER BY created_at, rowid`).all();
    expect(fb).toEqual([
      { subject_type: 'reply_debt', action: 'done', channel: 'web' },
      { subject_type: 'commitment', action: 'snooze', channel: 'imessage' },
      { subject_type: 'commitment', action: 'wrong', channel: 'web' },
    ]);
  });

  it('a digest card of kind reply_debt maps to its loop (skip leaves it open; no duplicate feedback row)', () => {
    const { w, sam } = scene();
    const debtId = debts(w.db)[0]!.id as string;
    const sid = uuidv7();
    w.db.prepare(
      `INSERT INTO suggestions (id, kind, person_id, reply_debt_id, dedupe_key, score, signals, status, created_at, updated_at)
       VALUES (?, 'reply_debt', ?, ?, ?, 0.8, '{}', 'delivered', ?, ?)`,
    ).run(sid, sam.id, debtId, `reply_debt:${debtId}`, NOW, NOW);
    expect(loopFeedbackFromSuggestion(w.db, sid, 'skip', { channel: 'imessage', now: NOW })).toBeNull();
    expect(loopFeedbackFromSuggestion(w.db, sid, 'dismiss', { channel: 'imessage', now: NOW })).toMatchObject({ status: 'dismissed' });
    expect(loopFeedbackFromSuggestion(w.db, sid, 'snooze', { channel: 'imessage', now: NOW })).toBeNull(); // closed meanwhile
    expect(w.db.prepare('SELECT count(*) FROM feedback').pluck().get()).toBe(0);
  });
});

describe('generators', () => {
  it('are registered for reply_debt and commitment_due; reply_debt is one per person with the normalized priority', () => {
    expect(generators.map((g) => g.kind)).toEqual(['reply_debt', 'commitment_due']);
    expect(allGenerators().map((g) => g.kind)).toEqual(expect.arrayContaining(['reply_debt', 'commitment_due']));
    const { w, sam } = scene();
    const wa = w.dm(w.identity(sam.id), 'whatsapp');
    w.msg(wa, sam.identity, ago(30 * HOUR), 'what time on friday?');
    runReplyDebts(w.db, { now: NOW });
    expect(debts(w.db).filter((d) => d.status === 'open')).toHaveLength(2);
    const c = replyDebtCandidates(w.db, NOW);
    expect(c).toHaveLength(1);
    // T 80, normal urgency, 48 h old: 0.3 + 0.56 = 0.86.
    expect(c[0]).toMatchObject({ kind: 'reply_debt', personIds: [sam.id], links: { replyDebtId: c[0]!.subjectKey } });
    expect(c[0]!.base).toBeCloseTo(0.86, 2);
    expect(c[0]!.evidenceIds[0]).toMatch(/^m:\d+$/);
  });

  it('commitment_due: due ones at 1.0, gated waiting-on at 0.3, and "did this happen?" once after a lapse', () => {
    const { w, mine, kitOwes, kit } = scene();
    const c = commitmentCandidates(w.db, NOW);
    expect(c.map((x) => [x.subjectKey, x.base])).toEqual(
      expect.arrayContaining([
        [mine, 1],
        [kitOwes, 0.3],
      ]),
    );
    expect(c).toHaveLength(2);
    expect(c.find((x) => x.subjectKey === kitOwes)!.personIds).toEqual([kit.id]);
    // 30 days past due: lapsed, asked once.
    const later = Date.UTC(2026, 9, 14) + 30 * DAY;
    runCommitments(w.db, { now: later });
    const asks = commitmentCandidates(w.db, later).filter((x) => x.payload.lapsed);
    expect(asks.map((x) => x.subjectKey)).toEqual(expect.arrayContaining([`lapsed:${mine}`]));
    w.db.prepare(
      `INSERT INTO suggestions (id, kind, commitment_id, dedupe_key, score, signals, status, delivered_at, created_at, updated_at)
       VALUES (?, 'commitment_due', ?, ?, 0.4, '{}', 'delivered', ?, ?, ?)`,
    ).run(uuidv7(), mine, `commitment_due:lapsed:${mine}`, later, later, later);
    expect(commitmentCandidates(w.db, later).some((x) => x.subjectKey === `lapsed:${mine}`)).toBe(false);
    expect(commitmentCandidates(w.db, later + 8 * DAY).some((x) => x.payload.lapsed)).toBe(false);
  });
});

describe('jobs', () => {
  it('reply-debt and commitments hourly, obligations at 07:00; a run reports non-zero stats; an aborted run is partial', async () => {
    const jobs = obligationsJobs({});
    expect(jobs.map((j) => [j.name, j.schedule])).toEqual([
      ['reply-debt', { kind: 'interval', everyMs: AGENT_TIMES.obligationsEveryMs }],
      ['commitments', { kind: 'interval', everyMs: AGENT_TIMES.obligationsEveryMs }],
      ['obligations', { kind: 'daily', at: AGENT_TIMES.obligations }],
    ]);
    const w = world();
    const sam = w.person('Sam');
    w.msg(w.dm(sam.identity), sam.identity, ago(6 * HOUR), 'are you free saturday?');
    const ctx = (signal = new AbortController().signal): JobContext => ({ db: w.db, jobRunId: 1, trigger: 'manual', now: () => NOW, log: nullLogger, signal });
    expect(await jobs[0]!.run(ctx())).toEqual({ status: 'ok', stats: { conversations: 1, created: 1 } });
    expect(w.db.prepare(`SELECT kind, status FROM runs`).all()).toEqual([{ kind: 'system', status: 'ok' }]);
    expect(await jobs[1]!.run(ctx())).toEqual({ status: 'ok', stats: {} });
    const nightly = await jobs[2]!.run(ctx());
    expect(nightly).toMatchObject({ status: 'ok' });
    const aborted = new AbortController();
    aborted.abort();
    expect(await jobs[0]!.run(ctx(aborted.signal))).toMatchObject({ status: 'partial' });
  });
});
