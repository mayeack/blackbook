import { describe, expect, it } from 'vitest';
import { withBatch } from '../../../src/journal/batch';
import { startRun } from '../../../src/journal/runs';
import { undoBatch } from '../../../src/journal/undo';
import { debtPriority, recordNeedsReplyFromExtraction, recordNeedsReplyVerdict, runReplyDebts, scoreMessage } from '../../../src/pipeline/obligations';
import { atMentionsMe, isCloser, meNames, mentionsMe } from '../../../src/pipeline/obligations/text';
import { ago, batchCount, DAY, debts, HOUR, NOW, world } from './world';

const me = meNames('Avery', null);

describe('reply-debt heuristic h', () => {
  it('scores questions, requests and invitations; closers are out', () => {
    expect(scoreMessage('are you free saturday?', me)).toMatchObject({ h: 0.9, reason: 'invitation', asks: true });
    expect(scoreMessage('how was the trip?', me).h).toBeCloseTo(0.6);
    expect(scoreMessage('Avery can you send me the playlist when you get a chance', me).h).toBeGreaterThanOrEqual(0.6);
    expect(scoreMessage('saw a great movie last night', me).h).toBeLessThan(0.6);
    expect(scoreMessage('haha ok see you then', me).h).toBe(0);
    for (const t of ['lol', 'ok', 'Thanks!', 'sounds good', '👍', 'haha ok', 'ok thanks!', 'nice!!']) expect(isCloser(t), t).toBe(true);
    for (const t of ['ok can you call me?', 'thanks, are you around tomorrow?']) expect(isCloser(t), t).toBe(false);
    expect(scoreMessage('can you call me asap?', me).urgency).toBe('high');
    expect(mentionsMe('Avery, you coming?', me)).toBe(true);
    expect(mentionsMe('ok AVERY!', me)).toBe(true);
    expect(mentionsMe('averyone is here', me)).toBe(false);
    expect(atMentionsMe('@Avery thoughts?', me)).toBe(true);
    expect(atMentionsMe('see you there @avery.', me)).toBe(true);
  });

  it('priority = urg · (0.3 + 0.7·T/100 + 0.3·priority) · age_w', () => {
    const d = { urgency: 'normal', asked_at: NOW - 48 * HOUR };
    expect(debtPriority(d, 50, false, NOW)).toBeCloseTo(0.65);
    expect(debtPriority(d, 50, true, NOW)).toBeCloseTo(0.95);
    expect(debtPriority({ urgency: 'high', asked_at: NOW - 48 * HOUR }, 100, false, NOW)).toBeCloseTo(1.5);
    expect(debtPriority({ urgency: 'normal', asked_at: NOW - 24 * HOUR }, 0, false, NOW)).toBeCloseTo(0.15);
    expect(debtPriority({ urgency: 'low', asked_at: NOW - 20 * DAY }, 0, false, NOW)).toBeCloseTo(0.6 * 0.3 * 0.5);
  });
});

describe('reply-debt candidates', () => {
  it('a DM question ≥ 4 h old becomes a "likely" debt with evidence; a re-run changes nothing', () => {
    const w = world();
    const sam = w.person('Sam');
    const dm = w.dm(sam.identity);
    w.msg(dm, 'me', ago(2 * DAY), 'great to see you');
    const q = w.msg(dm, sam.identity, ago(5 * HOUR), 'are you free saturday?');
    const r = runReplyDebts(w.db, { now: NOW });
    expect(r.stats.created).toBe(1);
    const [d] = debts(w.db);
    expect(d).toMatchObject({ person_id: sam.id, conversation_id: dm, debt_msg: q, last_inbound_msg: q, asked_at: ago(5 * HOUR), classifier: 'heuristic', status: 'open', reason: 'invitation' });
    expect(w.db.prepare(`SELECT count(*) FROM evidence WHERE subject_type = 'reply_debt'`).pluck().get()).toBe(1);
    const batches = batchCount(w.db);
    expect(runReplyDebts(w.db, { now: NOW + 60_000 }).stats.created).toBe(0);
    expect(batchCount(w.db)).toBe(batches);
  });

  it('too recent, closers, file-only, tapbacked statements and answered threads are not debts', () => {
    const w = world();
    const cases: [string, (conv: string, id: string) => void][] = [
      ['recent', (c, i) => w.msg(c, i, ago(2 * HOUR), 'are you free saturday?')],
      ['closer', (c, i) => w.msg(c, i, ago(6 * HOUR), 'sounds good!')],
      ['file', (c, i) => w.msg(c, i, ago(6 * HOUR), null, { kind: 'attachment', attachments: [{ mime: 'image/jpeg' }] })],
      ['answered', (c, i) => {
        w.msg(c, i, ago(9 * HOUR), 'are you free saturday?');
        w.msg(c, 'me', ago(8 * HOUR), 'yes!');
      }],
      ['tapback', (c, i) => w.react(w.msg(c, i, ago(7 * HOUR), 'I got the job, starting in november and I am so excited about it'))],
      ['statement', (c, i) => w.msg(c, i, ago(7 * HOUR), 'saw the best band last night')],
    ];
    for (const [name, setup] of cases) {
      const p = w.person(name.charAt(0).toUpperCase() + name.slice(1));
      setup(w.dm(p.identity), p.identity);
    }
    expect(runReplyDebts(w.db, { now: NOW }).stats.created).toBe(0);
    // A tapbacked question still counts.
    const q = w.person('Quinn');
    w.react(w.msg(w.dm(q.identity), q.identity, ago(7 * HOUR), 'can you do dinner thursday?'));
    expect(runReplyDebts(w.db, { now: NOW }).stats.created).toBe(1);
  });

  it('services, hidden people and the self thread never get debts', () => {
    const w = world();
    const svc = w.person('Alerts', { status: 'service' });
    w.msg(w.dm(svc.identity), svc.identity, ago(6 * HOUR), 'can you confirm your appointment?');
    const hidden = w.person('Hollis', { hidden: true });
    w.msg(w.dm(hidden.identity), hidden.identity, ago(6 * HOUR), 'are you around tomorrow?');
    expect(runReplyDebts(w.db, { now: NOW }).stats.created).toBe(0);
    expect(debts(w.db)).toEqual([]);
  });

  it('small groups need me addressed and 12 h; big groups never count', () => {
    const w = world();
    const a = w.person('Rowan');
    const b = w.person('Kit');
    const g = w.group([a.identity, b.identity]);
    w.msg(g, a.identity, ago(14 * HOUR), 'who is bringing snacks?');
    expect(runReplyDebts(w.db, { now: NOW }).stats.created).toBe(0);
    const ask = w.msg(g, b.identity, ago(13 * HOUR), 'Avery are you driving on sunday?');
    const r = runReplyDebts(w.db, { now: NOW });
    expect(r.stats.created).toBe(1);
    expect(debts(w.db)[0]).toMatchObject({ person_id: b.id, debt_msg: ask });
    // A reply to my own message also addresses me (12 h rule applies).
    const c = w.person('Indigo');
    const g2 = w.group([c.identity, a.identity]);
    const mine = w.msg(g2, 'me', ago(20 * HOUR), 'trip plan is in the doc');
    w.msg(g2, c.identity, ago(13 * HOUR), 'can we leave earlier?', { replyTo: mine });
    expect(runReplyDebts(w.db, { now: NOW }).stats.created).toBe(1);
    // n > 8 (me included) is out.
    const crowd = Array.from({ length: 8 }, (_, i) => w.person(`Crowd${i}`).identity);
    const big = w.group(crowd);
    w.msg(big, crowd[0]!, ago(13 * HOUR), 'Avery are you coming?');
    expect(runReplyDebts(w.db, { now: NOW }).stats.created).toBe(0);
  });

  it('newer inbound messages roll the debt forward; "since" stays on the question', () => {
    const w = world();
    const sam = w.person('Sam');
    const dm = w.dm(sam.identity);
    const q = w.msg(dm, sam.identity, ago(30 * HOUR), 'did you book the cabin?');
    runReplyDebts(w.db, { now: NOW });
    const later = w.msg(dm, sam.identity, ago(5 * HOUR), 'also my cousin might join');
    const r = runReplyDebts(w.db, { now: NOW });
    expect(r.stats.created).toBe(0);
    expect(r.stats.updated).toBe(1);
    expect(debts(w.db)).toHaveLength(1);
    expect(debts(w.db)[0]).toMatchObject({ debt_msg: q, last_inbound_msg: later, asked_at: ago(30 * HOUR) });
  });
});

describe('reply-debt auto-close', () => {
  it('an outbound on another channel to the same person closes it (replied, closed_by_msg)', () => {
    const w = world();
    const sam = w.person('Sam');
    const im = w.dm(sam.identity, 'imessage');
    w.msg(im, sam.identity, ago(10 * HOUR), 'what time is the game?');
    runReplyDebts(w.db, { now: NOW });
    const wa = w.dm(w.identity(sam.id), 'whatsapp');
    const reply = w.msg(wa, 'me', ago(1 * HOUR), '7pm, see you there');
    const r = runReplyDebts(w.db, { now: NOW });
    expect(r.stats.replied).toBe(1);
    expect(debts(w.db)[0]).toMatchObject({ status: 'replied', closed_reason: 'outbound', closed_by_msg: reply });
    // Bot rows never count as outbound.
    const pat = w.person('Pat');
    const pdm = w.dm(pat.identity);
    w.msg(pdm, pat.identity, ago(10 * HOUR), 'are you around later?');
    runReplyDebts(w.db, { now: NOW });
    w.msg(pdm, 'me', ago(1 * HOUR), '\u{1F168} digest', { bot: true });
    expect(runReplyDebts(w.db, { now: NOW + 1 }).stats.replied).toBe(0);
  });

  it('time together (a log: interaction) closes it; 30 days drops it', () => {
    const w = world();
    const sam = w.person('Sam');
    w.msg(w.dm(sam.identity), sam.identity, ago(10 * HOUR), 'what time is the game?');
    const lee = w.person('Lee');
    w.msg(w.dm(lee.identity), lee.identity, ago(25 * DAY), 'can you send me that recipe?');
    runReplyDebts(w.db, { now: NOW });
    expect(debts(w.db)).toHaveLength(2);
    w.interaction(sam.id, 'manual', ago(2 * HOUR));
    const r = runReplyDebts(w.db, { now: NOW + 6 * DAY });
    expect(r.stats.together).toBe(1);
    expect(r.stats.dropped).toBe(1);
    const byPerson = Object.fromEntries(debts(w.db).map((d) => [d.person_id as string, d]));
    expect(byPerson[sam.id]).toMatchObject({ status: 'replied', closed_reason: 'together' });
    expect(byPerson[lee.id]).toMatchObject({ status: 'dropped', closed_reason: 'expired' });
  });

  it('an undone close is not re-closed by the same outbound; a newer outbound closes it', () => {
    const w = world();
    const sam = w.person('Sam');
    const dm = w.dm(sam.identity);
    w.msg(dm, sam.identity, ago(20 * HOUR), 'what time is the game?');
    runReplyDebts(w.db, { now: ago(10 * HOUR) });
    w.msg(dm, 'me', ago(9 * HOUR), 'not sure yet');
    runReplyDebts(w.db, { now: ago(8 * HOUR) });
    const closeBatch = w.db.prepare(`SELECT id FROM change_batches WHERE title LIKE 'Closed a reply debt%'`).pluck().get() as string;
    undoBatch(w.db, closeBatch, { now: ago(7 * HOUR) });
    expect(debts(w.db)[0]).toMatchObject({ status: 'open' });
    runReplyDebts(w.db, { now: ago(6 * HOUR) });
    expect(debts(w.db)[0]).toMatchObject({ status: 'open' });
    w.msg(dm, 'me', ago(5 * HOUR), 'ok 7pm');
    runReplyDebts(w.db, { now: NOW });
    expect(debts(w.db)[0]).toMatchObject({ status: 'replied' });
  });

  it('an undone debt is never re-created from the same messages', () => {
    const w = world();
    const sam = w.person('Sam');
    const dm = w.dm(sam.identity);
    w.msg(dm, sam.identity, ago(10 * HOUR), 'what time is the game?');
    runReplyDebts(w.db, { now: NOW });
    const created = w.db.prepare(`SELECT id FROM change_batches WHERE kind = 'reply_debt'`).pluck().get() as string;
    undoBatch(w.db, created, { now: NOW + 1000 });
    expect(debts(w.db)[0]).toMatchObject({ status: 'retracted' });
    expect(runReplyDebts(w.db, { now: NOW + 2000 }).stats.created).toBe(0);
    // A new question later is a new debt.
    w.msg(dm, sam.identity, ago(5 * HOUR), 'also, are you coming friday?');
    expect(runReplyDebts(w.db, { now: NOW + 3000 }).stats.created).toBe(1);
  });
});

describe('needs_reply verdicts', () => {
  it('a current no_reply_needed verdict closes the live debt inside the extraction batch', () => {
    const w = world();
    const sam = w.person('Sam');
    const dm = w.dm(sam.identity);
    const q = w.msg(dm, sam.identity, ago(10 * HOUR), 'did you see the game?');
    runReplyDebts(w.db, { now: NOW });
    const runId = startRun(w.db, 'nightly', { now: NOW });
    const r = withBatch(w.db, { runId, kind: 'fact', title: 'Read a conversation', actor: 'agent' }, (t) =>
      recordNeedsReplyFromExtraction(t, { conversationId: dm, throughMsgId: q, state: 'no_reply_needed', msgId: null, reason: null, urgency: 'low', confidence: 0.8 }),
    );
    expect(r.result).toEqual({ stored: true, effect: 'dismissed' });
    expect(debts(w.db)[0]).toMatchObject({ status: 'dismissed', closed_reason: 'no_reply_needed', llm_state: 'no_reply_needed' });
    // Undoing the extraction batch reopens it.
    undoBatch(w.db, r.batchId, { now: NOW + 1 });
    expect(debts(w.db)[0]).toMatchObject({ status: 'open' });
  });

  it('needs_reply confirms a debt the heuristic missed (not "likely"); a stale verdict does not suppress', () => {
    const w = world();
    const sam = w.person('Sam');
    const dm = w.dm(sam.identity);
    const m = w.msg(dm, sam.identity, ago(10 * HOUR), 'my dad is in the hospital again');
    expect(runReplyDebts(w.db, { now: NOW }).stats.created).toBe(0);
    expect(recordNeedsReplyVerdict(w.db, { conversationId: dm, throughMsgId: m, state: 'needs_reply', msgId: m, reason: 'emotional', urgency: 'high', confidence: 0.9 }, NOW)).toMatchObject({ stored: true });
    expect(runReplyDebts(w.db, { now: NOW }).stats.created).toBe(1);
    expect(debts(w.db)[0]).toMatchObject({ classifier: 'llm', reason: 'emotional', urgency: 'high', llm_state: 'needs_reply', confidence: 0.9 });

    const lee = w.person('Lee');
    const ldm = w.dm(lee.identity);
    const old = w.msg(ldm, lee.identity, ago(30 * HOUR), 'ok');
    recordNeedsReplyVerdict(w.db, { conversationId: ldm, throughMsgId: old, state: 'no_reply_needed', msgId: null, reason: null, urgency: 'low', confidence: 0.9 }, NOW);
    w.msg(ldm, lee.identity, ago(6 * HOUR), 'wait, are you coming tonight?');
    expect(runReplyDebts(w.db, { now: NOW }).stats.created).toBe(1);
  });

  it('rejects verdicts for unknown conversations or messages', () => {
    const w = world();
    const sam = w.person('Sam');
    const dm = w.dm(sam.identity);
    const m = w.msg(dm, sam.identity, ago(10 * HOUR), 'hey');
    expect(recordNeedsReplyVerdict(w.db, { conversationId: 'nope', throughMsgId: m, state: 'n_a', msgId: null, reason: null, urgency: 'low', confidence: 0.5 })).toMatchObject({ stored: false, reason: 'unknown_conversation' });
    expect(recordNeedsReplyVerdict(w.db, { conversationId: dm, throughMsgId: m + 99, state: 'n_a', msgId: null, reason: null, urgency: 'low', confidence: 0.5 })).toMatchObject({ stored: false, reason: 'unknown_message' });
    expect(recordNeedsReplyVerdict(w.db, { conversationId: dm, throughMsgId: m, state: 'n_a', msgId: null, reason: null, urgency: 'low', confidence: Number.NaN })).toMatchObject({ stored: false, reason: 'invalid' });
  });
});
