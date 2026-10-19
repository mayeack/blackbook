/**
 * The two-way texting executor end to end over a synthetic self thread. The suggestion feedback entry point and
 * the Ask engine are other builders' modules: they are mocked here at their contract (applySuggestionFeedback /
 * whyThis / undoSuggestionFeedback, askForImessage) so these tests pin the executor's behaviour, not theirs
 * (commands/integration.test.ts runs the real ones).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SuggestionFeedback, SuggestionFeedbackResult, WhyThis } from '@yb/shared';
import { BOT_MARKER } from '@yb/shared/collector/v1';
import { HttpError } from '../../src/http/errors';
import { INTENT_SYSTEM } from '../../src/commands/intent';
import { commandsJobs } from '../../src/commands/jobs';
import type { DB } from '../../src/db/connection';
import { FakeLlmClient } from '../fakes/llm';
import { BRIEF_AT, commandsWorld, DAY, HOUR, MIN, setSetting } from './world';

const fb = vi.hoisted(() => ({ apply: vi.fn(), why: vi.fn(), undo: vi.fn() }));
vi.mock('../../src/pipeline/suggestions/feedback', () => ({ applySuggestionFeedback: fb.apply, whyThis: fb.why, undoSuggestionFeedback: fb.undo }));
const askMock = vi.hoisted(() => ({ askForImessage: vi.fn() }));
vi.mock('../../src/ask/imessage', () => ({ askForImessage: askMock.askForImessage }));

/** What askForImessage answers: the formatted body plus the engine result. */
function askAnswer(text: string, engine: Partial<{ citations: unknown[]; people: unknown[]; degraded: boolean; degradedReason: string | null; error: unknown }> = {}) {
  return {
    text,
    conversationId: 'c1',
    degraded: engine.degraded ?? false,
    engine: { conversationId: 'c1', turnId: 't1', answer: text, citations: [], people: [], degraded: false, degradedReason: null, error: null, ...engine },
  };
}

const STATUS: Record<string, string> = { done: 'done', skip: 'dismissed', snooze: 'snoozed', wrong: 'wrong' };

/** A minimal stand-in for the suggestions module: moves the status and records the explicit reward. */
async function fakeApply(db: DB, id: string, f: SuggestionFeedback, ctx: { now: number }): Promise<SuggestionFeedbackResult> {
  const status = STATUS[f.action];
  if (status) {
    db.prepare('UPDATE suggestions SET status = ?, snoozed_until = ?, acted_at = ?, updated_at = ? WHERE id = ?').run(
      status,
      f.action === 'snooze' ? f.until : null,
      f.action === 'done' ? ctx.now : null,
      ctx.now,
      id,
    );
    if (f.action !== 'snooze') {
      db.prepare(`INSERT INTO suggestion_outcomes (suggestion_id, reward, weight, source, decided_at) VALUES (?, ?, 1, 'explicit', ?)`).run(id, f.action === 'done' ? 1 : 0, ctx.now);
    }
  }
  if (f.action === 'draft') throw new HttpError(501, 'NOT_IMPLEMENTED', 'not yet');
  const cur = db.prepare('SELECT status FROM suggestions WHERE id = ?').pluck().get(id) as SuggestionFeedbackResult['status'];
  return { suggestionId: id, status: cur, batchId: null, why: null, openers: null };
}

/** Records the feedback row the real module writes (so the executor's undo can find it). */
async function fakeApplyRecorded(db: DB, id: string, f: SuggestionFeedback, ctx: { now: number; inboundCommandId?: string | null }): Promise<SuggestionFeedbackResult> {
  const prev = db.prepare('SELECT status, snoozed_until, acted_at FROM suggestions WHERE id = ?').get(id);
  const out = await fakeApply(db, id, f, ctx);
  db.prepare(
    `INSERT INTO feedback (id, suggestion_id, subject_type, subject_id, action, payload, channel, inbound_command_id, created_at)
     VALUES (?, ?, 'suggestion', ?, ?, ?, 'imessage', ?, ?)`,
  ).run(`fb-${id}-${ctx.now}`, id, id, f.action, JSON.stringify({ prev }), ctx.inboundCommandId ?? null, ctx.now);
  return out;
}

/** The real module's undo contract: earlier status back, explicit reward withdrawn. */
function fakeUndo(db: DB, feedbackId: string, ctx: { now: number }) {
  const row = db.prepare('SELECT suggestion_id, payload FROM feedback WHERE id = ?').get(feedbackId) as { suggestion_id: string; payload: string };
  const prev = (JSON.parse(row.payload) as { prev: { status: string; snoozed_until: number | null; acted_at: number | null } }).prev;
  db.prepare('UPDATE suggestions SET status = ?, snoozed_until = ?, acted_at = ?, updated_at = ? WHERE id = ?').run(prev.status, prev.snoozed_until, prev.acted_at, ctx.now, row.suggestion_id);
  db.prepare(`DELETE FROM suggestion_outcomes WHERE suggestion_id = ? AND source = 'explicit'`).run(row.suggestion_id);
  db.prepare(`INSERT INTO feedback (id, suggestion_id, subject_type, subject_id, action, payload, channel, created_at) VALUES (?, ?, 'suggestion', ?, 'undo', '{}', 'imessage', ?)`).run(
    `undo-${feedbackId}`,
    row.suggestion_id,
    row.suggestion_id,
    ctx.now,
  );
  return { suggestionId: row.suggestion_id, batchId: null };
}

beforeEach(() => {
  fb.apply.mockReset().mockImplementation(fakeApplyRecorded);
  fb.why.mockReset().mockImplementation(() => {
    throw new HttpError(501, 'NOT_IMPLEMENTED', 'not yet');
  });
  fb.undo.mockReset().mockImplementation(fakeUndo);
  askMock.askForImessage.mockReset().mockResolvedValue(askAnswer('Ask needs the Anthropic API key. A plain search found nothing for that.', { degraded: true, degradedReason: 'no_key' }));
});

function briefWorld(o: Parameters<typeof commandsWorld>[0] = {}) {
  const w = commandsWorld(o);
  const sam = w.person('Sam', 'Rivera');
  const priya = w.person('Priya', 'Shah');
  const jordan = w.person('Jordan', 'Lee');
  const d = w.digest([{ personId: sam }, { personId: priya, kind: 'reply_debt' }, { personId: jordan, kind: 'commitment_due' }]);
  return { w, sam, priya, jordan, ...d };
}

const at = (mins: number) => BRIEF_AT + mins * MIN;

describe('commands: item verbs bind to the latest brief', () => {
  it('done 2 → feedback through the suggestions entry point, one ack to self', async () => {
    const { w, suggestionIds, digestId } = briefWorld();
    const { commandId } = w.say('done 2', at(5));
    const stats = await w.run({ now: at(5) + 10_000 });
    expect(stats).toMatchObject({ pending: 1, handled: 1, replies: 1 });
    expect(fb.apply).toHaveBeenCalledTimes(1);
    expect(fb.apply.mock.calls[0]![1]).toBe(suggestionIds[1]);
    expect(fb.apply.mock.calls[0]![2]).toEqual({ action: 'done' });
    expect(fb.apply.mock.calls[0]![3]).toMatchObject({ channel: 'imessage', inboundCommandId: commandId });
    expect(w.replies()).toEqual([`${BOT_MARKER} ✓ 2 done (Priya S.) · undo to revert`]);
    expect(w.outbound.sent[0]).toMatchObject({ purpose: 'reply', options: { bypassQuietHours: true } });
    expect(w.command(commandId)).toMatchObject({ status: 'handled', target_digest_id: digestId, intent: 'done' });
    expect(w.suggestionStatus(suggestionIds[1]!)).toBe('done');
  });

  it('bare numbers are done; several clauses get one grouped reply', async () => {
    const { w, suggestionIds } = briefWorld();
    w.say('2', at(5));
    w.say('done 1, snooze 3 2w', at(6));
    await w.run({ now: at(7) });
    expect(w.suggestionStatus(suggestionIds[1]!)).toBe('done');
    expect(w.suggestionStatus(suggestionIds[0]!)).toBe('done');
    expect(w.suggestionStatus(suggestionIds[2]!)).toBe('snoozed');
    const snoozeCall = fb.apply.mock.calls.find((c) => (c[2] as SuggestionFeedback).action === 'snooze')!;
    expect((snoozeCall[2] as { until: number }).until).toBe(at(6) + 14 * DAY);
    expect(w.replies()).toEqual([
      `${BOT_MARKER} ✓ 2 done (Priya S.) · undo to revert`,
      `${BOT_MARKER} ✓ 1 done (Sam R.) · 3 snoozed (Jordan L.) → Oct 28 · undo to revert`,
    ]);
  });

  it('unknown item numbers, already-done items, "done" with several open items, bad dates', async () => {
    const { w } = briefWorld();
    w.say('done 7', at(1));
    w.say('done', at(2));
    w.say('done 1', at(3));
    w.say('done 1', at(4));
    w.say('snooze 2 banana', at(5));
    await w.run({ now: at(6) });
    expect(w.replies()).toEqual([
      `${BOT_MARKER} No item 7 in that brief (1–3)`,
      `${BOT_MARKER} Which one? reply done 1–3`,
      `${BOT_MARKER} ✓ 1 done (Sam R.) · undo to revert`,
      `${BOT_MARKER} 1 is already done`,
      `${BOT_MARKER} Didn't get "banana" · try snooze 2 2w`,
    ]);
  });

  it('an inline reply binds to its own (older) digest', async () => {
    const w = commandsWorld();
    const a = w.person('Alex', 'Moreno');
    const b = w.person('Blair', 'Novak');
    const yesterday = w.digest([{ personId: a }, { personId: a, kind: 'cooling' }], BRIEF_AT - DAY, '2026-10-13');
    const today = w.digest([{ personId: b }, { personId: b, kind: 'cooling' }]);
    w.say('done 2', at(10), { replyTo: yesterday.messageId });
    w.say('done 2', at(11));
    await w.run({ now: at(12) });
    expect(w.suggestionStatus(yesterday.suggestionIds[1]!)).toBe('done');
    expect(w.suggestionStatus(today.suggestionIds[1]!)).toBe('done');
    expect(w.suggestionStatus(today.suggestionIds[0]!)).toBe('delivered');
  });

  it('sensitive items are acknowledged without a name', async () => {
    const w = commandsWorld();
    const p = w.person('Casey', 'Wren');
    const { suggestionIds } = w.digest([{ personId: p, sensitive: true }]);
    w.say('skip 1', at(1));
    await w.run({ now: at(2) });
    expect(w.lastReply()).toBe(`${BOT_MARKER} ✓ 1 skipped · undo to revert`);
    expect(w.suggestionStatus(suggestionIds[0]!)).toBe('dismissed');
  });

  it('feedback not built yet → a pointer to the web, nothing pretends to have happened', async () => {
    const { w } = briefWorld();
    fb.apply.mockImplementation(() => {
      throw new HttpError(501, 'NOT_IMPLEMENTED', 'not yet');
    });
    const { commandId } = w.say('done 2', at(1));
    await w.run({ now: at(2) });
    expect(w.lastReply()).toBe(`${BOT_MARKER} Feedback by text isn’t available yet · use yeackbot.com/today`);
    expect(w.db.prepare('SELECT effect FROM command_effects WHERE command_id = ?').pluck().get(commandId)).toBe('none');
  });
});

describe('commands: gating keeps notes-to-self private', () => {
  it('no brief and no bot message: commands and free text are ignored silently; ? and log: always work', async () => {
    const w = commandsWorld();
    w.person('Sam', 'Rivera');
    const c1 = w.say('done 2', at(0));
    const c2 = w.say('buy milk and eggs', at(1));
    const c3 = w.say('who do I know in Austin', at(2));
    w.say('? who do I know in Austin', at(3));
    w.say('log: coffee with Sam', at(4));
    const stats = await w.run({ now: at(5) });
    expect(stats).toMatchObject({ ignored: 3, handled: 2 });
    for (const c of [c1, c2, c3]) expect(w.command(c.commandId)).toMatchObject({ status: 'ignored', response_outbound_id: null });
    expect(w.command(c1.commandId).parsed).toMatchObject({ reason: 'not_addressed' });
    expect(askMock.askForImessage).toHaveBeenCalledTimes(1);
    expect(askMock.askForImessage.mock.calls[0]![0]).toBe('who do I know in Austin');
    expect(w.replies()).toHaveLength(2);
  });

  it('within 12 h of a bot message free text is read; after that only with a yb prefix', async () => {
    const w = commandsWorld();
    w.botSays('✓ Logged for Sam R.: coffee today', at(0));
    w.say('who do I know in Austin', at(60));
    const notes = w.say('pick up dry cleaning', at(61));
    await w.run({ now: at(62) });
    // 12 h after the last bot text (the answer above went out at +62 min):
    const late = w.say('who do I know in Denver', at(62 + 12 * 60 + 5));
    w.say('yb who do I know in Denver', at(62 + 12 * 60 + 6));
    await w.run({ now: at(62 + 12 * 60 + 7) });
    expect(askMock.askForImessage.mock.calls.map((c) => c[0])).toEqual(['who do I know in Austin', 'who do I know in Denver']);
    expect(w.command(late.commandId).status).toBe('ignored');
    // Without the LLM, plain notes in the window stay silent (only explicitly addressed text gets "Didn't get that").
    expect(w.command(notes.commandId)).toMatchObject({ status: 'ignored', response_outbound_id: null });
  });

  it('a brief older than 36 h no longer binds bare numbers', async () => {
    const w = commandsWorld();
    const p = w.person('Drew', 'Okafor');
    w.digest([{ personId: p }], BRIEF_AT - 37 * HOUR, '2026-10-12');
    const c = w.say('1', at(0));
    await w.run({ now: at(1) });
    expect(w.command(c.commandId).status).toBe('ignored');
    expect(fb.apply).not.toHaveBeenCalled();
  });

  it('yb addresses the bot: "yb hello" → help pointer; commands.enabled=false ignores everything', async () => {
    const w = commandsWorld();
    w.say('yb hello there', at(0));
    await w.run({ now: at(1) });
    expect(w.lastReply()).toContain("Didn't get that · try help");
    setSetting(w.db, 'commands.enabled', false);
    const c = w.say('? anything', at(2));
    await w.run({ now: at(3) });
    expect(w.command(c.commandId)).toMatchObject({ status: 'ignored' });
    expect(w.command(c.commandId).parsed).toMatchObject({ reason: 'disabled' });
    expect(w.replies()).toHaveLength(1);
  });

  it('rows older than 6 h when processed are "seen late", never executed', async () => {
    const { w, suggestionIds } = briefWorld();
    const c = w.say('done 1', at(1));
    const note = w.say('random thought', at(2));
    await w.run({ now: at(1) + 7 * HOUR });
    expect(w.command(c.commandId).status).toBe('seen_late');
    expect(w.command(note.commandId).status).toBe('ignored');
    expect(w.suggestionStatus(suggestionIds[0]!)).toBe('delivered');
    expect(w.replies()).toEqual([`${BOT_MARKER} Seen late (sent 8:01 AM) · didn't act on it · send it again if you still want it`]);
  });
});

describe('commands: limits and idempotency', () => {
  it('≤30 commands an hour: the 31st is ignored with one notice', async () => {
    const w = commandsWorld();
    for (let i = 0; i < 31; i++) w.say('help', at(i));
    for (let k = 0; k < 4; k++) await w.run({ now: at(31) });
    const statuses = w.db.prepare('SELECT status FROM inbound_commands ORDER BY created_at').pluck().all() as string[];
    // help without a brief or bot message is gated: only the yb/always forms count. Use ? instead.
    expect(statuses.every((s) => s === 'ignored')).toBe(true);

    const w2 = commandsWorld();
    for (let i = 0; i < 31; i++) w2.say('? q', at(i));
    for (let k = 0; k < 4; k++) await w2.run({ now: at(32) });
    const rows = w2.db.prepare(`SELECT status, json_extract(parsed, '$.reason') AS reason FROM inbound_commands ORDER BY created_at`).all() as {
      status: string;
      reason: string | null;
    }[];
    expect(rows.slice(0, 30).every((r) => r.status === 'handled')).toBe(true);
    expect(rows[30]).toEqual({ status: 'ignored', reason: 'rate_limited' });
  });

  it('the outbound circuit breaker holds replies (effects still apply)', async () => {
    const { w, suggestionIds } = briefWorld();
    for (let i = 0; i < 20; i++) w.botSays(`answer ${i}`, at(10 + i));
    const c = w.say('done 1', at(31));
    await w.run({ now: at(32) });
    expect(w.suggestionStatus(suggestionIds[0]!)).toBe('done');
    expect(w.outbound.sent).toHaveLength(0);
    expect(w.command(c.commandId).parsed).toMatchObject({ replyStatus: 'circuit_open' });
  });

  it('a second pass does nothing; an interrupted command is never re-run', async () => {
    const { w } = briefWorld();
    w.say('done 1', at(1));
    await w.run({ now: at(2) });
    await w.run({ now: at(3) });
    expect(fb.apply).toHaveBeenCalledTimes(1);
    expect(w.outbound.sent).toHaveLength(1);

    const c = w.say('done 2', at(4));
    w.db.prepare(`INSERT INTO command_effects (command_id, state, created_at, updated_at) VALUES (?, 'started', ?, ?)`).run(c.commandId, at(4), at(4));
    await w.run({ now: at(5) });
    expect(fb.apply).toHaveBeenCalledTimes(1);
    expect(w.command(c.commandId)).toMatchObject({ status: 'error' });
    expect(w.lastReply()).toBe(`${BOT_MARKER} Something went wrong with a command · check yeackbot.com/today`);
  });

  it('a reply composed but never handed to the sender (crash) goes out once on the next pass', async () => {
    const { w } = briefWorld({ outboundConfigured: true });
    const c = w.say('help', at(1));
    await w.run({ now: at(2) });
    const first = w.outbound.sent.length;
    w.db.prepare(`UPDATE inbound_commands SET response_outbound_id = NULL, parsed = json_remove(parsed, '$.replyStatus') WHERE id = ?`).run(c.commandId);
    const stats = await w.run({ now: at(3) });
    // Handed over again with the same clientRef: the sender recognizes it, so nothing is texted twice.
    expect(stats.replies_recovered).toBe(1);
    expect(w.outbound.sent).toHaveLength(first);
    expect(w.command(c.commandId).parsed).toMatchObject({ replyStatus: 'duplicate' });
  });

  it('every reply starts with the marker and goes to self; no collector → nothing sent, still handled', async () => {
    const { w } = briefWorld({ outboundConfigured: false });
    const c = w.say('help', at(1));
    await w.run({ now: at(2) });
    expect(w.command(c.commandId)).toMatchObject({ status: 'handled' });
    expect(w.command(c.commandId).parsed).toMatchObject({ replyStatus: 'disabled' });
  });
});

describe('commands: log', () => {
  it('log: coffee with Sam → a journaled interaction (1.5 units) + note; undo reverts it', async () => {
    const w = commandsWorld();
    const sam = w.person('Sam', 'Rivera');
    w.person('Priya', 'Shah');
    const { commandId, messageId } = w.say('log: coffee with Sam yesterday', at(0));
    await w.run({ now: at(1) });
    const inter = w.db.prepare(`SELECT * FROM interactions WHERE person_id = ?`).all(sam) as Record<string, unknown>[];
    expect(inter).toHaveLength(1);
    expect(inter[0]).toMatchObject({ kind: 'text_log', units: 1.5, origin: 'user', summary: 'Coffee', retracted_at: null });
    expect(inter[0]!.started_at).toBe(Date.UTC(2026, 9, 13, 17, 0)); // yesterday, local noon
    expect(w.db.prepare(`SELECT content, origin, source_message_id FROM notes WHERE person_id = ?`).get(sam)).toEqual({
      content: 'coffee with Sam yesterday',
      origin: 'text_log',
      source_message_id: messageId,
    });
    expect(w.lastReply()).toBe(`${BOT_MARKER} ✓ Logged for Sam R.: coffee yesterday · undo to revert`);
    const batch = w.db.prepare(`SELECT kind, actor, subject_person_id, run_id FROM change_batches WHERE kind = 'text_log'`).get() as Record<string, string>;
    expect(batch).toMatchObject({ kind: 'text_log', actor: 'user', subject_person_id: sam });
    expect(w.db.prepare('SELECT kind FROM runs WHERE id = ?').pluck().get(batch.run_id)).toBe('command');
    expect(w.command(commandId).batch_id).not.toBeNull();

    w.say('undo', at(2));
    await w.run({ now: at(3) });
    expect(w.lastReply()).toBe(`${BOT_MARKER} ✓ Undid: log for Sam R. (coffee yesterday)`);
    expect(w.db.prepare('SELECT retracted_at FROM interactions WHERE person_id = ?').pluck().get(sam)).toBe(at(3));
    expect(w.db.prepare('SELECT status FROM notes WHERE person_id = ?').pluck().get(sam)).toBe('retracted');
    w.say('undo', at(4));
    await w.run({ now: at(5) });
    expect(w.lastReply()).toBe(`${BOT_MARKER} Already undone · nothing else to undo by text`);
  });

  it('two people named Sam → "Sam R. or Sam K.? reply 1/2", then "2" logs Sam K. (not done 2)', async () => {
    const { w, suggestionIds } = briefWorld();
    const samK = w.person('Sam', 'Kowalski');
    const c = w.say('log: drinks with Sam', at(5));
    await w.run({ now: at(6) });
    expect(w.lastReply()).toMatch(/^🅨 Sam [RK]\. or Sam [RK]\.\? reply 1\/2$/u);
    expect(w.command(c.commandId).status).toBe('clarifying');
    const options = JSON.parse(w.db.prepare(`SELECT options FROM command_clarifications WHERE status = 'open'`).pluck().get() as string) as { personId: string }[];
    const k = options.findIndex((o) => o.personId === samK) + 1;
    w.say(String(k), at(7));
    await w.run({ now: at(8) });
    expect(w.db.prepare(`SELECT count(*) FROM interactions WHERE person_id = ? AND kind = 'text_log'`).pluck().get(samK)).toBe(1);
    expect(w.lastReply()).toBe(`${BOT_MARKER} ✓ Logged for Sam K.: drinks today · undo to revert`);
    expect(w.command(c.commandId).status).toBe('handled');
    expect(w.suggestionStatus(suggestionIds[k - 1]!)).toBe('delivered');
  });

  it('two ambiguous names are asked one at a time; the original log is handled once both are answered', async () => {
    const w = commandsWorld();
    const samR = w.person('Sam', 'Rivera');
    w.person('Sam', 'Kowalski');
    w.person('Alex', 'Moreno');
    const alexN = w.person('Alex', 'Novak');
    const c = w.say('log: dinner with Sam and Alex', at(0));
    await w.run({ now: at(1) });
    const pick = (personId: string) => {
      const opts = JSON.parse(w.db.prepare(`SELECT options FROM command_clarifications WHERE status = 'open'`).pluck().get() as string) as { personId: string }[];
      return String(opts.findIndex((o) => o.personId === personId) + 1);
    };
    expect(w.lastReply()).toMatch(/^🅨 Sam [RK]\. or Sam [RK]\.\? reply 1\/2$/u);
    w.say(pick(samR), at(2));
    await w.run({ now: at(3) });
    expect(w.lastReply()).toMatch(/^🅨 Alex [MN]\. or Alex [MN]\.\? reply 1\/2$/u);
    expect(w.command(c.commandId).status).toBe('clarifying');
    w.say(pick(alexN), at(4));
    await w.run({ now: at(5) });
    expect(w.lastReply()).toBe(`${BOT_MARKER} ✓ Logged for Sam R. and Alex N.: meal today · undo to revert`);
    expect(w.command(c.commandId).status).toBe('handled');
    expect((w.db.prepare(`SELECT person_id FROM interactions ORDER BY person_id`).pluck().all() as string[]).sort()).toEqual([samR, alexN].sort());

    // A new ambiguous log replaces an unanswered question; the old log is dropped.
    const first = w.say('log: coffee with Sam', at(6));
    await w.run({ now: at(7) });
    w.say('log: lunch with Sam', at(8));
    await w.run({ now: at(9) });
    expect(w.command(first.commandId)).toMatchObject({ status: 'ignored' });
    expect(w.db.prepare(`SELECT count(*) FROM command_clarifications WHERE status = 'open'`).pluck().get()).toBe(1);
  });

  it('overlapping passes never process a command twice', async () => {
    const { w } = briefWorld();
    w.say('done 1', at(1));
    w.say('done 2', at(2));
    await Promise.all([w.run({ now: at(3) }), w.run({ now: at(3) })]);
    expect(fb.apply).toHaveBeenCalledTimes(2);
    expect(w.outbound.sent).toHaveLength(2);
  });

  it('clarifications expire after an hour; "cancel" drops one', async () => {
    const w = commandsWorld();
    w.person('Sam', 'Rivera');
    w.person('Sam', 'Kowalski');
    const c = w.say('log: lunch with sam', at(0));
    await w.run({ now: at(1) });
    await w.run({ now: at(62) });
    expect(w.db.prepare(`SELECT status FROM command_clarifications`).pluck().get()).toBe('expired');
    expect(w.command(c.commandId).status).toBe('ignored');
    w.say('log: lunch with Sam', at(63));
    await w.run({ now: at(64) });
    w.say('cancel', at(65));
    await w.run({ now: at(66) });
    expect(w.lastReply()).toBe(`${BOT_MARKER} ✓ Dropped that log`);
    expect(w.db.prepare('SELECT count(*) FROM interactions').pluck().get()).toBe(0);
  });

  it('nobody recognizable → a hint, no effect; hidden people are never matched', async () => {
    const w = commandsWorld();
    w.person('Morgan', 'Hale', { is_hidden: 1 });
    w.say('log: coffee with Morgan', at(0));
    await w.run({ now: at(1) });
    expect(w.lastReply()).toBe(`${BOT_MARKER} Couldn't tell who that was with · try log: coffee with Sam R.`);
    expect(w.db.prepare('SELECT count(*) FROM interactions').pluck().get()).toBe(0);
  });

  it('with the AI key: the intent parser (effort low, pseudonymized) adds facts at 0.95 from user_log', async () => {
    const llm = new FakeLlmClient({
      responder: (call) => {
        const token = /^(P\w+) = Sam R\.$/m.exec(call.userText)?.[1] ?? 'P?';
        return {
          json: {
            intent: 'log_interaction',
            command: null,
            question: null,
            log: { people: [{ surface: 'Sam', ref: token }], kind: 'meal', date: '2026-10-14', facts: [{ ref: token, cat: 'location_next', value: 'moving to Denver' }], note: 'dinner' },
          },
        };
      },
    });
    const w = commandsWorld({ llm });
    const sam = w.person('Sam', 'Rivera');
    w.say('log: dinner with Sam Rivera, he is moving to Denver (sam@example.com)', at(0));
    await w.run({ now: at(1) });
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]).toMatchObject({ method: 'parse', kind: 'intent', route: 'intent', effort: 'low', fallbacks: false, system: INTENT_SYSTEM });
    expect(llm.calls[0]!.userText).not.toContain('Rivera');
    expect(llm.calls[0]!.userText).not.toContain('@example.com');
    expect(INTENT_SYSTEM).not.toMatch(/\d{4}-\d{2}-\d{2}/); // byte-stable prefix: no dates
    const fact = w.db.prepare('SELECT type, value, confidence, source, status FROM facts WHERE person_id = ?').get(sam);
    expect(fact).toEqual({ type: 'location_next', value: 'moving to Denver', confidence: 0.95, source: 'user_log', status: 'confirmed' });
    expect(w.lastReply()).toBe(`${BOT_MARKER} ✓ Logged for Sam R.: meal today · “moving to Denver” · undo to revert`);
  });

  it('with the AI key, free text in the window is classified: notes stay silent, questions go to Ask', async () => {
    const llm = new FakeLlmClient()
      .on('intent', { json: { intent: 'note', command: null, log: null, question: null } }, { json: { intent: 'question', command: null, log: null, question: 'Who lives in Austin?' } });
    const w = commandsWorld({ llm });
    w.botSays('✓ done', at(0));
    const note = w.say('remember to water plants', at(1));
    w.say('anyone around Austin', at(2));
    await w.run({ now: at(3) });
    expect(llm.calls[0]!.userText).toContain('### ADDRESSED\nno');
    expect(w.command(note.commandId)).toMatchObject({ status: 'ignored', response_outbound_id: null });
    expect(askMock.askForImessage.mock.calls[0]![0]).toBe('Who lives in Austin?');
  });

  it('text addressed to the bot is never dropped as a note: yb and inline replies get "Didn\'t get that"', async () => {
    const llm = new FakeLlmClient().on('intent', { json: { intent: 'note', command: null, log: null, question: null } });
    const w = commandsWorld({ llm });
    const bot = w.botSays('✓ done', at(-13 * 60)); // outside the 12 h window: only yb or an inline reply reaches the bot
    const yb = w.say('Yb prioritize inviting this person to parties, is a great DJ', at(0));
    const inline = w.say('put them on the party list', at(1), { replyTo: bot });
    await w.run({ now: at(2) });
    expect(llm.calls).toHaveLength(2);
    for (const call of llm.calls) expect(call.userText).toContain('### ADDRESSED\nyes');
    for (const c of [yb, inline]) {
      const row = w.command(c.commandId);
      expect(row).toMatchObject({ status: 'handled', intent: 'note' });
      expect(row.response_outbound_id).not.toBeNull();
    }
    expect(w.lastReply()).toBe(`${BOT_MARKER} Didn't get that · try help`);
  });

  it('people excluded from the AI are never sent: the text is logged deterministically', async () => {
    const llm = new FakeLlmClient().on('intent', { json: { intent: 'note', command: null, log: null, question: null } });
    const w = commandsWorld({ llm });
    const sam = w.person('Sam', 'Rivera');
    setSetting(w.db, 'llm.excluded_person_ids', [sam]);
    w.say('log: coffee with Sam', at(0));
    await w.run({ now: at(1) });
    expect(llm.calls).toHaveLength(0);
    expect(w.db.prepare(`SELECT count(*) FROM interactions WHERE person_id = ?`).pluck().get(sam)).toBe(1);
  });

  it('an LLM refusal or outage falls back to the deterministic path', async () => {
    const llm = new FakeLlmClient().on('intent', { refusal: 'policy' });
    const w = commandsWorld({ llm });
    const sam = w.person('Sam', 'Rivera');
    w.say('log: call with sam', at(0));
    await w.run({ now: at(1) });
    expect(w.db.prepare(`SELECT summary FROM interactions WHERE person_id = ?`).pluck().get(sam)).toBe('Call');
    expect(w.lastReply()).toBe(`${BOT_MARKER} ✓ Logged for Sam R.: call today · undo to revert`);
  });
});

describe('commands: undo, pause, why, draft, more, help, ask', () => {
  it('undo restores the suggestion and withdraws the explicit reward', async () => {
    const { w, suggestionIds } = briefWorld();
    w.say('done 2', at(1));
    await w.run({ now: at(2) });
    expect(w.db.prepare('SELECT count(*) FROM suggestion_outcomes').pluck().get()).toBe(1);
    const done = w.db.prepare(`SELECT id FROM feedback WHERE action = 'done'`).pluck().get() as string;
    w.say('undo', at(3));
    await w.run({ now: at(4) });
    expect(fb.undo).toHaveBeenCalledTimes(1);
    expect(fb.undo.mock.calls[0]!.slice(1)).toEqual([done, { now: at(4), channel: 'imessage' }]);
    expect(w.suggestionStatus(suggestionIds[1]!)).toBe('delivered');
    expect(w.db.prepare('SELECT count(*) FROM suggestion_outcomes').pluck().get()).toBe(0);
    expect(w.lastReply()).toBe(`${BOT_MARKER} ✓ Undid: 2 done (Priya S.)`);
    w.say('undo 3', at(5));
    await w.run({ now: at(6) });
    expect(w.lastReply()).toBe(`${BOT_MARKER} Only your last command can be undone by text · everything else at yeackbot.com/today`);
  });

  it('pause 2w writes digest.paused_until (journaled); undo and resume clear it', async () => {
    const { w } = briefWorld();
    w.say('pause 2w', at(1));
    await w.run({ now: at(2) });
    const paused = () => JSON.parse((w.db.prepare(`SELECT value FROM settings WHERE key = 'digest.paused_until'`).pluck().get() as string | undefined) ?? 'null');
    expect(paused()).toBe(at(1) + 14 * DAY);
    expect(w.lastReply()).toBe(`${BOT_MARKER} ✓ Brief paused until Wed Oct 28 (the brief is also off in Settings) · resume to restart · undo to revert`);
    expect(w.db.prepare(`SELECT count(*) FROM change_batches WHERE kind = 'setting'`).pluck().get()).toBe(1);
    w.say('undo', at(3));
    await w.run({ now: at(4) });
    expect(paused()).toBeNull();
    w.say('pause', at(5));
    w.say('resume', at(6));
    await w.run({ now: at(7) });
    expect(paused()).toBeNull();
    expect(w.lastReply()).toBe(`${BOT_MARKER} ✓ Brief resumed (turn it on in Settings to get it) · undo to revert`);
  });

  it('why N: the learned explanation, or a fallback while the module is not built', async () => {
    const { w, suggestionIds } = briefWorld();
    w.say('why 1', at(1));
    await w.run({ now: at(2) });
    expect(w.lastReply()).toBe(`${BOT_MARKER} Why 1 · Sam R.: quiet a while · score 0.50 · more at yeackbot.com/today`);
    const why: WhyThis = {
      suggestionId: suggestionIds[0]!,
      kind: 'fading',
      summary: 'Quiet 41 days; you usually talk every 9.',
      base: 0.6,
      score: 0.7,
      factors: [{ arm: 'kind', label: 'Fading overall', value: 1.3, propensity: 0.6, n: 12 }],
      signals: [{ label: 'Quiet', value: '41 days' }],
      evidence: [],
      adjustments: [],
    };
    fb.why.mockReturnValue(why);
    w.say('why 1', at(3));
    await w.run({ now: at(4) });
    expect(w.lastReply()).toBe(`${BOT_MARKER} Why 1 · Sam R.: Quiet 41 days; you usually talk every 9.\n• Quiet: 41 days\nLearned: Fading overall ×1.3\nyeackbot.com/today`);
  });

  it('draft N: needs the AI key; with it, two drafts (shown to self only)', async () => {
    const off = briefWorld();
    off.w.say('draft 1', at(1));
    await off.w.run({ now: at(2) });
    expect(off.w.lastReply()).toBe(`${BOT_MARKER} Drafts need the AI key`);

    const llm = new FakeLlmClient().on('command', { json: { openers: ['Hey Sam, been too long. Coffee this week?', 'Sam! How did the move go?'] } });
    const on = briefWorld({ llm });
    on.w.say('draft 1', at(1));
    await on.w.run({ now: at(2) });
    expect(llm.calls[0]).toMatchObject({ kind: 'command', effort: 'low' });
    expect(on.w.lastReply()).toBe(`${BOT_MARKER} Drafts for Sam R. (copy them; nothing is sent):\n1) Hey Sam, been too long. Coffee this week?\n2) Sam! How did the move go?`);
    expect(on.w.outbound.sent).toHaveLength(1); // the drafts went to self, never to Sam
  });

  it('more: the next candidates continue the numbering and bind like brief items', async () => {
    const { w } = briefWorld();
    const p = w.person('Emery', 'Vale');
    const extra = w.suggestion({ personId: p, kind: 'dormant', score: 0.4 });
    w.suggestion({ personId: null, kind: 'circle_neglect', score: 0.1, status: 'expired' });
    // Never offered: a muted kind, a muted person.
    setSetting(w.db, 'learner.muted_kinds', ['intro']);
    w.suggestion({ personId: p, kind: 'intro', score: 0.9 });
    const muted = w.person('Kit', 'Arden');
    w.db.prepare(`INSERT INTO learner_person_state (person_id, muted, updated_at) VALUES (?, 1, ?)`).run(muted, at(0));
    w.suggestion({ personId: muted, kind: 'fading', score: 0.95 });
    w.say('more', at(1));
    await w.run({ now: at(2) });
    expect(w.lastReply()).toBe(`${BOT_MARKER} 4 Emery V. · long time\ndone 4 · skip 4 · yeackbot.com/today`);
    w.say('done 4', at(3));
    await w.run({ now: at(4) });
    expect(w.suggestionStatus(extra)).toBe('done');
    w.say('more', at(5));
    await w.run({ now: at(6) });
    expect(w.lastReply()).toBe(`${BOT_MARKER} That's everything for now · yeackbot.com/today`);
  });

  it('help and status', async () => {
    const { w } = briefWorld();
    w.say('help', at(1));
    w.say('status', at(2));
    await w.run({ now: at(3) });
    expect(w.replies()[0]).toContain('done 2 · snooze 1 2w');
    expect(w.replies()[1]).toBe(`${BOT_MARKER} Brief: off\nLast sent: Oct 14\nAI: off · commands: on`);
  });

  it('? → the shared Ask engine through its iMessage entry point; the reply goes out as an answer (≤600 chars)', async () => {
    const w = commandsWorld();
    const body = `Sam R. lives in Austin¹.\n¹ Sam · iMessage Oct 3\nFull answer: https://yeackbot.com/ask/c1 ${'x'.repeat(700)}`;
    askMock.askForImessage.mockResolvedValue(askAnswer(body, { citations: [{ ref: 'm:5', kind: 'message', label: 'Sam · iMessage Oct 3', href: null, at: null }] }));
    w.say('? who do I know in Austin', at(0));
    await w.run({ now: at(1) });
    expect(askMock.askForImessage.mock.calls[0]![1]).toMatchObject({ now: at(1) });
    const r = w.lastReply()!;
    expect(r.startsWith(`${BOT_MARKER} Sam R. lives in Austin¹.`)).toBe(true);
    expect(r.length).toBeLessThanOrEqual(600);
    expect(r).toContain('yeackbot.com/ask/c1');
    expect(r).not.toContain('https://');
    expect(w.outbound.sent.at(-1)).toMatchObject({ purpose: 'answer', options: { bypassQuietHours: true } });
  });

  it('? without the AI key and nothing found → "Ask needs the AI key"; an answer citing a sensitive fact is withheld', async () => {
    const w = commandsWorld();
    w.say('? who do I know in Austin', at(0));
    await w.run({ now: at(1) });
    expect(w.lastReply()).toBe(`${BOT_MARKER} Ask needs the AI key · try yeackbot.com/ask`);

    const p = w.person('Sam', 'Rivera');
    w.db.prepare(
      `INSERT INTO facts (id, person_id, type, value, value_norm, sensitive, confidence, status, recorded_at, source, created_at, updated_at)
       VALUES ('f-1', ?, 'other', 'private thing', 'private thing', 1, 0.9, 'confirmed', ?, 'test', ?, ?)`,
    ).run(p, at(0), at(0), at(0));
    const seq = w.db.prepare(`SELECT seq FROM facts WHERE id = 'f-1'`).pluck().get() as number;
    askMock.askForImessage.mockResolvedValue(askAnswer('Sam¹', { citations: [{ ref: `F${seq.toString(36)}`, kind: 'fact', label: 'private', href: null, at: null }] }));
    w.say('? tell me about Sam', at(2));
    await w.run({ now: at(3) });
    expect(w.lastReply()).toBe(`${BOT_MARKER} That answer touches something personal · see it at yeackbot.com/ask`);

    askMock.askForImessage.mockRejectedValue(new Error('boom'));
    w.say('? anything', at(4));
    await w.run({ now: at(5) });
    expect(w.lastReply()).toBe(`${BOT_MARKER} Ask hit a problem · try yeackbot.com/ask`);
  });
});

describe('commands: tapbacks and the job', () => {
  it('a tapback on the brief is recorded once as "seen" feedback, never as done; no reply', async () => {
    const { w, messageId, digestId } = briefWorld();
    w.db.prepare(
      `INSERT INTO message_reactions (source_reaction_id, message_id, actor_identity_id, is_from_me, type, emoji, removed, at)
       VALUES ('r-1', ?, NULL, 1, 'love', NULL, 0, ?)`,
    ).run(messageId, at(2));
    await w.run({ now: at(3) });
    await w.run({ now: at(4) });
    expect(w.db.prepare(`SELECT action, subject_type, subject_id, channel FROM feedback`).all()).toEqual([
      { action: 'seen', subject_type: 'digest', subject_id: digestId, channel: 'imessage' },
    ]);
    expect(fb.apply).not.toHaveBeenCalled();
    expect(w.outbound.sent).toHaveLength(0);
  });

  it('job "commands" runs every 10 s and skips when there is nothing to do', async () => {
    const { w } = briefWorld();
    const [job] = commandsJobs({ services: w.services });
    expect(job).toMatchObject({ name: 'commands', schedule: { kind: 'interval', everyMs: 10_000 } });
    const ctx = { db: w.db, jobRunId: 1, trigger: 'schedule' as const, now: () => at(1), log: undefined as never, signal: new AbortController().signal };
    expect(await job!.run(ctx)).toEqual({ status: 'skipped' });
    w.say('done 1', at(1));
    const out = await job!.run(ctx);
    expect(out).toMatchObject({ stats: { pending: 1, handled: 1, replies: 1 } });
  });
});
