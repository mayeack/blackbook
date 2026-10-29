import { uuidv7 } from '@yb/shared';
import { describe, expect, it } from 'vitest';
import { withBatch, type JournalTx } from '../../../src/journal/batch';
import { startRun } from '../../../src/journal/runs';
import { undoBatch } from '../../../src/journal/undo';
import {
  applyExtractedCommitments,
  openCommitmentsForPeople,
  runCommitments,
  upsertCommitmentFromExtraction,
  type ExtractedCommitmentInput,
} from '../../../src/pipeline/obligations';
import { checkDue, localDayEnd, localDayStart, resolveDue } from '../../../src/pipeline/obligations/dates';
import { whatNorm, whatSimilarity } from '../../../src/pipeline/obligations/text';
import { ago, commitments, DAY, HOUR, NOW, world, type World } from './world';

function inBatch<T>(w: World, fn: (t: JournalTx) => T, now = NOW): T {
  const runId = startRun(w.db, 'nightly', { now });
  return withBatch(w.db, { runId, kind: 'fact', title: 'Read a conversation', actor: 'agent' }, fn, { now }).result;
}

function setup() {
  const w = world();
  const sam = w.person('Sam');
  const dm = w.dm(sam.identity);
  const m = w.msg(dm, 'me', ago(2 * DAY), "I'll send you the gym link tonight");
  const item = (o: Partial<ExtractedCommitmentInput> = {}): ExtractedCommitmentInput => ({
    personId: sam.id,
    owner: 'ME',
    kind: 'send',
    what: 'Send the gym link',
    due: { kind: 'date', start: '2026-10-12', end: null },
    status: 'open',
    conversationId: dm,
    evidence: [{ messageId: m, quote: "I'll send you the gym link tonight" }],
    confidence: 0.85,
    ...o,
  });
  return { w, sam, dm, m, item };
}

describe('due dates', () => {
  it('local dates resolve in the zone; chrono wins when the LLM is >2 days off; past dues turn vague', () => {
    expect(localDayStart('2026-10-14', 'UTC')).toBe(Date.UTC(2026, 9, 14));
    expect(localDayStart('2026-10-14', 'America/New_York')).toBe(Date.UTC(2026, 9, 14, 4));
    expect(localDayEnd('2026-11-01', 'America/New_York')).toBe(Date.UTC(2026, 10, 2, 5) - 1); // DST ends Nov 1
    const msgAt = Date.UTC(2026, 9, 14, 15); // a Wednesday
    const due = resolveDue({ precision: 'date', start: '2026-10-30', end: null }, 'UTC');
    expect(checkDue(due, ['see you friday for dinner'], msgAt, 'UTC')).toEqual({ precision: 'date', start: Date.UTC(2026, 9, 16), end: Date.UTC(2026, 9, 17) - 1 });
    expect(checkDue(resolveDue({ precision: 'date', start: '2026-10-15', end: null }, 'UTC'), ['see you friday'], msgAt, 'UTC').start).toBe(Date.UTC(2026, 9, 15));
    expect(checkDue(resolveDue({ precision: 'date', start: '2026-09-01', end: null }, 'UTC'), ['soon'], msgAt, 'UTC').precision).toBe('vague');
    expect(resolveDue({ precision: 'range', start: '2026-10-20', end: '2026-10-22' }, 'UTC')).toEqual({ precision: 'range', start: Date.UTC(2026, 9, 20), end: Date.UTC(2026, 9, 23) - 1 });
    expect(resolveDue({ precision: 'date', start: 'next week', end: null }, 'UTC').precision).toBe('vague');
    // Resolved ms bounds (what the extraction stage passes) are kept as given.
    const s = Date.UTC(2026, 9, 20, 4);
    expect(resolveDue({ precision: 'date', start: s, end: s + DAY - 1 }, 'UTC')).toEqual({ precision: 'date', start: s, end: s + DAY - 1 });
    expect(resolveDue({ precision: 'date', start: s, end: null }, 'UTC')).toEqual({ precision: 'date', start: s, end: s });
  });

  it('what dedup: normalized tokens and Jaccard', () => {
    expect(whatNorm('Send Sam the gym links')).toBe('gym link sam send');
    expect(whatSimilarity(whatNorm('Send the gym link'), whatNorm('send gym link to Sam'))).toBe(1);
    expect(whatSimilarity(whatNorm('Dinner at the new place'), whatNorm('Send the gym link'))).toBe(0);
  });
});

describe('upsertCommitmentFromExtraction', () => {
  it('inserts at conf ≥ 0.70 with evidence, made_at and the run; skips below the gate, hidden people and no evidence', () => {
    const { w, m, item } = setup();
    const r = inBatch(w, (t) => upsertCommitmentFromExtraction(t, item()));
    expect(r.action).toBe('inserted');
    const [k] = commitments(w.db);
    expect(k).toMatchObject({ owner: 'me', kind: 'send', what: 'Send the gym link', origin: 'llm', made_at: ago(2 * DAY), source_msg: m, status: 'open', due_precision: 'date' });
    expect(k!.run_id).toBeTruthy();
    expect(w.db.prepare(`SELECT quote FROM evidence WHERE subject_type = 'commitment'`).pluck().get()).toContain('gym link');
    expect(inBatch(w, (t) => upsertCommitmentFromExtraction(t, item({ confidence: 0.6 })))).toMatchObject({ action: 'skipped', reason: 'below_gate' });
    expect(inBatch(w, (t) => upsertCommitmentFromExtraction(t, item({ evidence: [{ messageId: 99999, quote: 'x' }] })))).toMatchObject({ reason: 'no_evidence' });
    const hidden = w.person('Hollis', { hidden: true });
    expect(inBatch(w, (t) => upsertCommitmentFromExtraction(t, item({ personId: hidden.id })))).toMatchObject({ reason: 'no_person' });
    expect(inBatch(w, (t) => upsertCommitmentFromExtraction(t, item({ owner: 'nobody' as never })))).toMatchObject({ reason: 'invalid' });
  });

  it('a repeat updates the live one (better due, merged people); a second promise of another kind in the same message is its own row', () => {
    const { w, sam, dm, m, item } = setup();
    inBatch(w, (t) => upsertCommitmentFromExtraction(t, item({ due: { kind: 'vague', start: null, end: null } })));
    const kit = w.person('Kit');
    const again = inBatch(w, (t) => upsertCommitmentFromExtraction(t, item({ otherPersonIds: [kit.id], confidence: 0.9 })));
    expect(again.action).toBe('updated');
    expect(commitments(w.db)).toHaveLength(1);
    expect(commitments(w.db)[0]).toMatchObject({ due_precision: 'date', confidence: 0.9, other_person_ids: JSON.stringify([kit.id]) });
    expect(inBatch(w, (t) => upsertCommitmentFromExtraction(t, item({ otherPersonIds: [kit.id], confidence: 0.9 })))).toMatchObject({ reason: 'duplicate' });
    const meet = inBatch(w, (t) =>
      upsertCommitmentFromExtraction(t, item({ kind: 'meet', what: 'Dinner at the new noodle place', owner: 'BOTH', due: { kind: 'none', start: null, end: null } })),
    );
    expect(meet.action).toBe('inserted');
    expect(openCommitmentsForPeople(w.db, [sam.id]).map((c) => [c.kind, c.ref.startsWith('K')])).toEqual([
      ['send', true],
      ['meet', true],
    ]);
    void dm;
    void m;
  });

  it('done with closes=K… closes it; an undone ("wrong") commitment is never re-created', () => {
    const { w, sam, dm, item } = setup();
    const ins = inBatch(w, (t) => upsertCommitmentFromExtraction(t, item()));
    const doneMsg = w.msg(dm, 'me', ago(1 * DAY), 'here you go');
    const closed = inBatch(w, (t) =>
      upsertCommitmentFromExtraction(t, item({ status: 'done', closes: `K${ins.commitmentId}`, evidence: [{ messageId: doneMsg, quote: 'here you go' }] })),
    );
    expect(closed).toEqual({ action: 'closed', commitmentId: ins.commitmentId });
    expect(commitments(w.db)[0]).toMatchObject({ status: 'done', closed_reason: 'said_done', closed_by_ref: `m:${doneMsg}` });
    // Re-extracting the original message doesn't bring it back.
    expect(inBatch(w, (t) => upsertCommitmentFromExtraction(t, item()))).toMatchObject({ action: 'skipped', reason: 'already_decided' });

    // A retracted one blocks a near-duplicate from another message too.
    const kit = w.person('Kit');
    const kdm = w.dm(kit.identity);
    const km = w.msg(kdm, kit.identity, ago(3 * DAY), 'I will call you about the lease');
    const runId = startRun(w.db, 'nightly', { now: NOW });
    const batch = applyExtractedCommitments(w.db, [item({ personId: kit.id, owner: 'THEM', kind: 'call', what: 'Call about the lease', conversationId: kdm, evidence: [{ messageId: km, quote: 'I will call you about the lease' }] })], { runId, now: NOW });
    expect(batch.results[0]!.action).toBe('inserted');
    undoBatch(w.db, batch.batchId!, { now: NOW + 1 });
    const km2 = w.msg(kdm, kit.identity, ago(2 * DAY), 'will call about the lease');
    expect(inBatch(w, (t) => upsertCommitmentFromExtraction(t, item({ personId: kit.id, owner: 'THEM', kind: 'call', what: 'call about lease', conversationId: kdm, evidence: [{ messageId: km2, quote: 'will call about the lease' }] })))).toMatchObject({ reason: 'blocked' });
    void sam;
  });

  it('stores the stakes (guessed when the extraction gave none); a repeat raises them but never lowers them', () => {
    const { w, sam, dm, item } = setup();
    inBatch(w, (t) => upsertCommitmentFromExtraction(t, item({ stakes: 'low' })));
    expect(commitments(w.db)[0]).toMatchObject({ stakes: 'low' });
    expect(inBatch(w, (t) => upsertCommitmentFromExtraction(t, item({ stakes: 'high' })))).toMatchObject({ action: 'updated' });
    expect(commitments(w.db)[0]).toMatchObject({ stakes: 'high' });
    expect(inBatch(w, (t) => upsertCommitmentFromExtraction(t, item({ stakes: 'low' })))).toMatchObject({ reason: 'duplicate' });
    expect(commitments(w.db)[0]).toMatchObject({ stakes: 'high' });
    const m2 = w.msg(dm, 'me', ago(1 * DAY), "I'll bring tomatoes saturday");
    const tomatoes = inBatch(w, (t) =>
      upsertCommitmentFromExtraction(t, item({ kind: 'favor', what: 'bring tomatoes', stakes: undefined, evidence: [{ messageId: m2, quote: "I'll bring tomatoes" }] })),
    );
    expect(commitments(w.db).find((k) => k.id === tomatoes.commitmentId)).toMatchObject({ stakes: 'low' });
    void sam;
  });

  it('sensitive commitments keep no quotes', () => {
    const { w, item } = setup();
    inBatch(w, (t) => upsertCommitmentFromExtraction(t, item({ sensitive: true })));
    expect(w.db.prepare(`SELECT quote FROM evidence WHERE subject_type = 'commitment'`).pluck().get()).toBeNull();
    expect(commitments(w.db)[0]).toMatchObject({ sensitive: 1 });
  });
});

describe('commitment lifecycle', () => {
  it('open → due at the due end → lapsed 30 days later; vague ones are due 21 days after they were made', () => {
    const { w, item } = setup();
    inBatch(w, (t) => upsertCommitmentFromExtraction(t, item({ kind: 'favor', what: 'Water the plants' })));
    inBatch(w, (t) => upsertCommitmentFromExtraction(t, item({ kind: 'intro', what: 'Intro to the recruiter', due: { kind: 'vague', start: null, end: null } })));
    const r = runCommitments(w.db, { now: NOW });
    expect(r.stats.due).toBe(1);
    const byKind = () => Object.fromEntries(commitments(w.db).map((k) => [k.kind as string, k.status]));
    expect(byKind()).toEqual({ favor: 'due', intro: 'open' });
    runCommitments(w.db, { now: ago(2 * DAY) + 21 * DAY + HOUR });
    expect(byKind()).toEqual({ favor: 'due', intro: 'due' });
    runCommitments(w.db, { now: Date.UTC(2026, 9, 13) + 30 * DAY });
    expect(byKind()).toEqual({ favor: 'lapsed', intro: 'due' });
    // A second pass changes nothing.
    expect(runCommitments(w.db, { now: Date.UTC(2026, 9, 13) + 30 * DAY }).runId).toBeNull();
  });

  it('send (owner me) closes on my outbound link or attachment; plain text does not', () => {
    const { w, dm, item } = setup();
    inBatch(w, (t) => upsertCommitmentFromExtraction(t, item()));
    w.msg(dm, 'me', ago(1 * DAY), 'will do it later');
    expect(runCommitments(w.db, { now: NOW }).stats.autoClosed).toBe(0);
    const link = w.msg(dm, 'me', ago(12 * HOUR), 'https://gym.example.com/join');
    expect(runCommitments(w.db, { now: NOW }).stats.autoClosed).toBe(1);
    expect(commitments(w.db)[0]).toMatchObject({ status: 'auto_closed', closed_reason: 'sent', closed_by_ref: `m:${link}` });
    // The conversation later confirms it: "likely done" becomes done.
    const thanks = w.msg(dm, w.db.prepare('SELECT identity_id FROM conversation_members WHERE conversation_id = ?').pluck().get(dm) as string, ago(6 * HOUR), 'got it, thanks!');
    const id = commitments(w.db)[0]!.id as string;
    expect(inBatch(w, (t) => upsertCommitmentFromExtraction(t, item({ status: 'done', closes: `K${id}`, evidence: [{ messageId: thanks, quote: 'got it' }] })))).toEqual({ action: 'closed', commitmentId: id });
    expect(commitments(w.db)[0]).toMatchObject({ status: 'done', closed_reason: 'said_done' });
  });

  it('send (owner them) closes on their attachment; reply_later on my outbound ≥ 2 h later', () => {
    const { w, sam, dm, item } = setup();
    const theirs = w.msg(dm, sam.identity, ago(3 * DAY), "I'll send the photos from the trip");
    inBatch(w, (t) => upsertCommitmentFromExtraction(t, item({ owner: 'THEM', what: 'Send the trip photos', evidence: [{ messageId: theirs, quote: "I'll send the photos" }] })));
    w.msg(dm, sam.identity, ago(1 * DAY), null, { kind: 'attachment', attachments: [{ mime: 'image/heic' }] });
    const later = w.msg(dm, 'me', ago(20 * HOUR), 'let me check and get back to you');
    inBatch(w, (t) => upsertCommitmentFromExtraction(t, item({ kind: 'reply_later', what: 'Get back about the weekend', evidence: [{ messageId: later, quote: 'get back to you' }] })));
    w.msg(dm, 'me', ago(20 * HOUR) + 40 * 60_000, 'ok'); // too soon to count
    expect(runCommitments(w.db, { now: NOW }).stats.autoClosed).toBe(1);
    w.msg(dm, 'me', ago(2 * HOUR), 'free saturday works');
    runCommitments(w.db, { now: NOW });
    expect(Object.fromEntries(commitments(w.db).map((k) => [k.kind as string, k.closed_reason]))).toEqual({ send: 'received', reply_later: 'replied' });
  });

  it('meet closes on time together or a scheduled occasion in [made_at, due_end + 7 d]; an undone close needs a newer signal', () => {
    const { w, sam, dm, item } = setup();
    const ask = w.msg(dm, sam.identity, ago(5 * DAY), 'dinner next week?');
    inBatch(w, (t) => upsertCommitmentFromExtraction(t, item({ kind: 'meet', owner: 'BOTH', what: 'Dinner next week', due: { kind: 'range', start: '2026-10-12', end: '2026-10-18' }, evidence: [{ messageId: ask, quote: 'dinner next week?' }] })));
    w.interaction(sam.id, 'manual', ago(10 * DAY)); // before it was made: doesn't count
    expect(runCommitments(w.db, { now: NOW }).stats.autoClosed).toBe(0);
    w.interaction(sam.id, 'manual', ago(1 * DAY));
    expect(runCommitments(w.db, { now: NOW }).stats.autoClosed).toBe(1);
    expect(commitments(w.db)[0]).toMatchObject({ status: 'auto_closed', closed_reason: 'logged' });
    const close = w.db.prepare(`SELECT id FROM change_batches WHERE title LIKE 'Closed a promise%'`).pluck().get() as string;
    undoBatch(w.db, close, { now: NOW + 1000 });
    expect(runCommitments(w.db, { now: NOW + 2000 }).stats.autoClosed).toBe(0);

    // An upcoming occasion both of you are on closes it too (it is on the calendar).
    const occ = uuidv7();
    w.db.prepare(`INSERT INTO occasions (id, kind, title, starts_at, is_social, created_at, updated_at) VALUES (?, 'social', 'Dinner', ?, 1, ?, ?)`).run(occ, NOW + 2 * DAY, NOW, NOW);
    w.db.prepare(
      `INSERT INTO event_attendees (id, occasion_id, person_id, status, source, confidence, created_at, updated_at) VALUES (?, ?, ?, 'attended', 'llm', 0.8, ?, ?)`,
    ).run(uuidv7(), occ, sam.id, NOW, NOW);
    expect(runCommitments(w.db, { now: NOW + 3000 }).stats.autoClosed).toBe(1);
    expect(commitments(w.db)[0]).toMatchObject({ closed_reason: 'scheduled', closed_by_ref: `occ:${occ}` });
  });

  it('a snoozed commitment wakes as due when its time has passed', () => {
    const { w, item } = setup();
    const r = inBatch(w, (t) => upsertCommitmentFromExtraction(t, item({ kind: 'favor', what: 'Return the ladder' })));
    w.db.prepare(`UPDATE commitments SET status = 'snoozed', snoozed_until = ? WHERE id = ?`).run(NOW + HOUR, r.commitmentId);
    expect(runCommitments(w.db, { now: NOW }).stats.woke).toBe(0);
    expect(runCommitments(w.db, { now: NOW + 2 * HOUR }).stats.woke).toBe(1);
    expect(commitments(w.db)[0]).toMatchObject({ status: 'due', snoozed_until: null });
  });
});
