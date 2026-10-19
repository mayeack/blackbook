/**
 * The two-way texting executor end to end over a synthetic self thread. The suggestion feedback entry point and
 * the Ask engine are other builders' modules: they are mocked here at their contract (applySuggestionFeedback /
 * whyThis / undoSuggestionFeedback, askForImessage) so these tests pin the executor's behaviour, not theirs
 * (commands/integration.test.ts runs the real ones).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SuggestionFeedback, SuggestionFeedbackResult, WhyThis } from '@yb/shared';
import { BOT_MARKER } from '@yb/shared/collector/v1';
import { MAX_OUTBOUND_PER_HOUR } from '../../src/delivery/types';
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
    expect(w.replies()).toEqual([`${BOT_MARKER} ✓ Nice, marked Priya S. done.\n\n(Text "undo" to take that back.)`]);
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
      `${BOT_MARKER} ✓ Nice, marked Priya S. done.\n\n(Text "undo" to take that back.)`,
      `${BOT_MARKER} ✓ Nice, marked Sam R. done.\n✓ Snoozed Jordan L. until Wed Oct 28.\n\n(Text "undo" to take that back.)`,
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
      `${BOT_MARKER} There's no #7 in that brief (it had 1–3).`,
      `${BOT_MARKER} Which one? Reply "done 1", or reply to that suggestion's text with just "done".`,
      `${BOT_MARKER} ✓ Nice, marked Sam R. done.\n\n(Text "undo" to take that back.)`,
      `${BOT_MARKER} #1 was already done.`,
      `${BOT_MARKER} I didn't understand "banana". Try "snooze 2 2w" or "snooze 2 friday".`,
    ]);
  });

  it('one text per suggestion: "done", "skip this one", "why" as a reply to a text act on that item', async () => {
    const { w, suggestionIds, itemMessageIds } = briefWorld();
    w.say('done', at(1), { replyTo: itemMessageIds[2] });
    w.say('skip this one', at(2), { replyTo: itemMessageIds[0] });
    // The self thread echoes every bot text as a second row with its own GUID: replying to the echo works too.
    const original = w.db.prepare('SELECT conversation_id, sent_at, text FROM messages WHERE id = ?').get(itemMessageIds[1]) as { conversation_id: string; sent_at: number; text: string };
    const echo = Number(
      w.db
        .prepare(
          `INSERT INTO messages (source, source_msg_id, conversation_id, sender_identity_id, is_from_me, sent_at, kind, text, is_bot, ingested_at, updated_at)
           VALUES ('imessage', 'TEST-ECHO-1', ?, NULL, 0, ?, 'text', ?, 1, ?, ?)`,
        )
        .run(original.conversation_id, original.sent_at + 500, original.text, original.sent_at, original.sent_at).lastInsertRowid,
    );
    w.say('snooze 2w', at(3), { replyTo: echo });
    await w.run({ now: at(5) });
    expect(w.suggestionStatus(suggestionIds[2]!)).toBe('done');
    expect(w.suggestionStatus(suggestionIds[0]!)).toBe('dismissed');
    expect(w.suggestionStatus(suggestionIds[1]!)).toBe('snoozed');
    expect(w.replies()).toEqual([
      `${BOT_MARKER} ✓ Nice, marked Jordan L. done.\n\n(Text "undo" to take that back.)`,
      `${BOT_MARKER} ✓ Skipped Sam R. I'll suggest things like that a bit less.\n\n(Text "undo" to take that back.)`,
      `${BOT_MARKER} ✓ Snoozed Priya S. until Wed Oct 28.\n\n(Text "undo" to take that back.)`,
    ]);
  });

  it('"why" with no number explains the suggestion it replies to; on its own it is free text', async () => {
    const { w, itemMessageIds } = briefWorld();
    const alone = w.say('why', at(1));
    w.say('why', at(2), { replyTo: itemMessageIds[1] });
    await w.run({ now: at(3) });
    expect(w.command(alone.commandId)).toMatchObject({ status: 'ignored', response_outbound_id: null });
    expect(w.replies()).toEqual([`${BOT_MARKER} #2 is a "reply owed" suggestion about Priya S.\nMore at yeackbot.com/today`]);
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
    expect(w.lastReply()).toBe(`${BOT_MARKER} ✓ Skipped #1. I'll suggest things like that a bit less.\n\n(Text "undo" to take that back.)`);
    expect(w.suggestionStatus(suggestionIds[0]!)).toBe('dismissed');
  });

  it('feedback not built yet → a pointer to the web, nothing pretends to have happened', async () => {
    const { w } = briefWorld();
    fb.apply.mockImplementation(() => {
      throw new HttpError(501, 'NOT_IMPLEMENTED', 'not yet');
    });
    const { commandId } = w.say('done 2', at(1));
    await w.run({ now: at(2) });
    expect(w.lastReply()).toBe(`${BOT_MARKER} Feedback by text isn't available yet. You can do it at yeackbot.com/today`);
    expect(w.db.prepare('SELECT effect FROM command_effects WHERE command_id = ?').pluck().get(commandId)).toBe('none');
  });
});

describe('commands: one text per suggestion — replies bind to the right thing', () => {
  it('notes-to-self that start with "wrong", "snooze" or "skip" stay notes, even with one suggestion open', async () => {
    const w = commandsWorld();
    const p = w.person('Rowan', 'Ellis');
    const { suggestionIds } = w.digest([{ personId: p }]);
    const notes = ['wrong number lol', 'Wrong size shoes, return them', 'snooze button is broken', 'skip', 'snooze 2w', 'wrong'];
    const ids = notes.map((t, k) => w.say(t, at(60 * 13 + k)).commandId); // 13 h after the brief: past the free-text window
    await w.run({ now: at(60 * 13 + 10) });
    for (const id of ids) expect(w.command(id)).toMatchObject({ status: 'ignored', response_outbound_id: null });
    expect(fb.apply).not.toHaveBeenCalled();
    expect(w.suggestionStatus(suggestionIds[0]!)).toBe('delivered');
  });

  it('a bare verb replying to a text that carries no suggestion never acts on one', async () => {
    const w = commandsWorld();
    const p = w.person('Rowan', 'Ellis');
    const { digestId, suggestionIds } = w.digest([{ personId: p }]);
    const heads = w.botSays("Heads up: WhatsApp hasn't synced in 4 days. Open WhatsApp on your phone to wake it up.", at(1), digestId, null);
    const answer = w.botSays('Rowan E. works at a bakery in Austin.', at(2));
    w.say('done', at(3), { replyTo: heads });
    const wrong = w.say('wrong, they moved to Denver', at(4), { replyTo: answer });
    await w.run({ now: at(5) });
    expect(fb.apply).not.toHaveBeenCalled();
    expect(w.suggestionStatus(suggestionIds[0]!)).toBe('delivered');
    expect(w.replies()[0]).toBe(`${BOT_MARKER} Which one? Reply "done 1", or reply to that suggestion's text with just "done".`);
    // Without the AI key the correction can't be understood, so it says so instead of marking anything wrong.
    expect(w.command(wrong.commandId).status).toBe('handled');
    expect(w.replies()[1]).toContain("Sorry, I didn't get that.");
  });

  it('while a brief is still going out, replies bind to it (not to yesterday\'s)', async () => {
    const w = commandsWorld();
    const a = w.person('Alex', 'Moreno');
    const b = w.person('Blair', 'Novak');
    const yesterday = w.digest([{ personId: a }, { personId: a, kind: 'cooling' }], BRIEF_AT - DAY, '2026-10-13');
    const today = w.digest([{ personId: b }, { personId: b, kind: 'cooling' }]);
    // Its first texts are out, the rest are still on their way: no sent_at / status yet.
    w.db.prepare(`UPDATE digests SET status = 'ready', sent_at = NULL WHERE id = ?`).run(today.digestId);
    w.say('done 1', at(1));
    w.say('done', at(2), { replyTo: today.itemMessageIds[1] });
    await w.run({ now: at(3) });
    expect(w.suggestionStatus(today.suggestionIds[0]!)).toBe('done');
    expect(w.suggestionStatus(today.suggestionIds[1]!)).toBe('done');
    expect(w.suggestionStatus(yesterday.suggestionIds[0]!)).toBe('delivered');
    expect(w.suggestionStatus(yesterday.suggestionIds[1]!)).toBe('delivered');
  });

  it('"2" replying to the "Which Sam?" question (its echo, right after the brief) answers it, not brief item 2', async () => {
    const { w, suggestionIds } = briefWorld();
    const samK = w.person('Sam', 'Kowalski');
    const log = w.say('log: drinks with Sam', at(1));
    await w.run({ now: at(2) });
    const question = w.outbound.sent.at(-1)!.text;
    const conv = w.db.prepare(`SELECT id FROM conversations WHERE kind = 'self'`).pluck().get() as string;
    // The self-thread echo of the question: its own GUID, is_bot, minutes after the brief.
    const echo = Number(
      w.db
        .prepare(
          `INSERT INTO messages (source, source_msg_id, conversation_id, sender_identity_id, is_from_me, sent_at, kind, text, is_bot, ingested_at, updated_at)
           VALUES ('imessage', 'TEST-ECHO-Q', ?, NULL, 0, ?, 'text', ?, 1, ?, ?)`,
        )
        .run(conv, at(2), question, at(2), at(2)).lastInsertRowid,
    );
    const options = JSON.parse(w.db.prepare(`SELECT options FROM command_clarifications WHERE status = 'open'`).pluck().get() as string) as { personId: string }[];
    const k = options.findIndex((o) => o.personId === samK) + 1;
    w.say(String(k), at(3), { replyTo: echo });
    await w.run({ now: at(4) });
    expect(w.command(log.commandId).status).toBe('handled');
    expect(w.db.prepare(`SELECT count(*) FROM interactions WHERE person_id = ?`).pluck().get(samK)).toBe(1);
    expect(w.suggestionStatus(suggestionIds[k - 1]!)).toBe('delivered');
  });

  it('a number-less note processed late is dropped silently (no "seen late" reply)', async () => {
    const { w } = briefWorld();
    const ids = ['wrong number lol', 'skip', 'snooze button is broken'].map((t, k) => w.say(t, at(60 + k)).commandId);
    await w.run({ now: at(60) + 7 * HOUR });
    for (const id of ids) expect(w.command(id)).toMatchObject({ status: 'ignored', response_outbound_id: null });
    expect(w.outbound.sent).toHaveLength(0);
  });

  it('"snooze one week" replying to a suggestion snoozes it for a week', async () => {
    const { w, suggestionIds, itemMessageIds } = briefWorld();
    w.say('snooze one week', at(1), { replyTo: itemMessageIds[1] });
    await w.run({ now: at(2) });
    expect(w.suggestionStatus(suggestionIds[1]!)).toBe('snoozed');
    const call = fb.apply.mock.calls.find((c) => (c[2] as SuggestionFeedback).action === 'snooze')!;
    expect((call[2] as { until: number }).until).toBe(at(1) + 7 * DAY);
  });

  it('"skip it" replying to a suggestion skips it; an open "Which Sam?" question stays open', async () => {
    const { w, suggestionIds, itemMessageIds } = briefWorld();
    w.person('Sam', 'Kowalski');
    const log = w.say('log: drinks with Sam', at(1));
    await w.run({ now: at(2) });
    expect(w.command(log.commandId).status).toBe('clarifying');
    w.say('skip it', at(3), { replyTo: itemMessageIds[2] });
    await w.run({ now: at(4) });
    expect(w.suggestionStatus(suggestionIds[2]!)).toBe('dismissed');
    expect(w.command(log.commandId).status).toBe('clarifying');
    expect(w.db.prepare(`SELECT status FROM command_clarifications`).pluck().get()).toBe('open');
  });

  it('"more" passes over a suggestion it can no longer show, and a reply to its text acts on it', async () => {
    const { w } = briefWorld();
    const hidden = w.person('Kit', 'Arden', { is_hidden: 1 });
    const cleo = w.person('Cleo', 'Marsh');
    const intro = w.suggestion({ personId: cleo, kind: 'intro', score: 0.9 });
    w.db.prepare('UPDATE suggestions SET related_person_id = ? WHERE id = ?').run(hidden, intro);
    const p = w.person('Emery', 'Vale');
    const extra = w.suggestion({ personId: p, kind: 'dormant', score: 0.4 });
    w.say('more', at(1));
    await w.run({ now: at(2) });
    const reply = w.outbound.sent.at(-1)!;
    expect(reply.text).toMatch(/^\u{1F168} 4\. Reconnect with Emery V\.\?/u);
    expect(reply.text).not.toMatch(/Kit|Arden|Cleo/);
    expect(reply.options).toMatchObject({ digestOrdinal: 4 });
    // The bot's own row for that reply, as the iMessage ingest would store it:
    const guid = (w.db.prepare('SELECT message_guids FROM outbound_messages WHERE id = ?').pluck().get(reply.outboundId) as string).slice(2, -2);
    const conv = w.db.prepare(`SELECT id FROM conversations WHERE kind = 'self'`).pluck().get() as string;
    const row = Number(
      w.db
        .prepare(
          `INSERT INTO messages (source, source_msg_id, conversation_id, sender_identity_id, is_from_me, sent_at, kind, text, is_bot, ingested_at, updated_at)
           VALUES ('imessage', ?, ?, NULL, 1, ?, 'text', ?, 1, ?, ?)`,
        )
        .run(guid, conv, at(2), reply.text, at(2), at(2)).lastInsertRowid,
    );
    w.say('done', at(3), { replyTo: row });
    await w.run({ now: at(4) });
    expect(w.suggestionStatus(extra)).toBe('done');
    expect(w.suggestionStatus(intro)).toBe('candidate');
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
    // Without the LLM, plain notes in the window stay silent (only explicitly addressed text gets "Sorry, I didn't get that").
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
    expect(w.lastReply()).toContain("Sorry, I didn't get that.");
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
    expect(w.replies()).toEqual([`${BOT_MARKER} I only just saw your text from 8:01 AM, so I didn't act on it.\nSend it again if you still want it.`]);
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
    for (let i = 0; i < MAX_OUTBOUND_PER_HOUR; i++) w.botSays(`answer ${i}`, at(10 + i));
    const c = w.say('done 1', at(10 + MAX_OUTBOUND_PER_HOUR));
    await w.run({ now: at(11 + MAX_OUTBOUND_PER_HOUR) });
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
    expect(w.lastReply()).toBe(`${BOT_MARKER} Something went wrong with a command. You can check it at yeackbot.com/today`);
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
    expect(w.lastReply()).toBe(`${BOT_MARKER} ✓ Logged coffee with Sam R. yesterday.\n\n(Text "undo" to take that back.)`);
    const batch = w.db.prepare(`SELECT kind, actor, subject_person_id, run_id FROM change_batches WHERE kind = 'text_log'`).get() as Record<string, string>;
    expect(batch).toMatchObject({ kind: 'text_log', actor: 'user', subject_person_id: sam });
    expect(w.db.prepare('SELECT kind FROM runs WHERE id = ?').pluck().get(batch.run_id)).toBe('command');
    expect(w.command(commandId).batch_id).not.toBeNull();

    w.say('undo', at(2));
    await w.run({ now: at(3) });
    expect(w.lastReply()).toBe(`${BOT_MARKER} ✓ Undone: log for Sam R. (coffee yesterday)`);
    expect(w.db.prepare('SELECT retracted_at FROM interactions WHERE person_id = ?').pluck().get(sam)).toBe(at(3));
    expect(w.db.prepare('SELECT status FROM notes WHERE person_id = ?').pluck().get(sam)).toBe('retracted');
    w.say('undo', at(4));
    await w.run({ now: at(5) });
    expect(w.lastReply()).toBe(`${BOT_MARKER} That's already undone, and there's nothing else I can undo by text.`);
  });

  it('two people named Sam → "Which Sam did you mean? 1. Sam R. 2. Sam K.", then "2" logs Sam K. (not done 2)', async () => {
    const { w, suggestionIds } = briefWorld();
    const samK = w.person('Sam', 'Kowalski');
    const c = w.say('log: drinks with Sam', at(5));
    await w.run({ now: at(6) });
    expect(w.lastReply()).toMatch(/^🅨 Which Sam did you mean\?\n1\. Sam [RK]\.\n2\. Sam [RK]\.\nReply 1 or 2\.$/u);
    expect(w.command(c.commandId).status).toBe('clarifying');
    const options = JSON.parse(w.db.prepare(`SELECT options FROM command_clarifications WHERE status = 'open'`).pluck().get() as string) as { personId: string }[];
    const k = options.findIndex((o) => o.personId === samK) + 1;
    w.say(String(k), at(7));
    await w.run({ now: at(8) });
    expect(w.db.prepare(`SELECT count(*) FROM interactions WHERE person_id = ? AND kind = 'text_log'`).pluck().get(samK)).toBe(1);
    expect(w.lastReply()).toBe(`${BOT_MARKER} ✓ Logged drinks with Sam K. today.\n\n(Text "undo" to take that back.)`);
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
    expect(w.lastReply()).toMatch(/^🅨 Which Sam did you mean\?\n1\. Sam [RK]\.\n2\. Sam [RK]\.\nReply 1 or 2\.$/u);
    w.say(pick(samR), at(2));
    await w.run({ now: at(3) });
    expect(w.lastReply()).toMatch(/^🅨 Which Alex did you mean\?\n1\. Alex [MN]\.\n2\. Alex [MN]\.\nReply 1 or 2\.$/u);
    expect(w.command(c.commandId).status).toBe('clarifying');
    w.say(pick(alexN), at(4));
    await w.run({ now: at(5) });
    expect(w.lastReply()).toBe(`${BOT_MARKER} ✓ Logged a meal with Sam R. and Alex N. today.\n\n(Text "undo" to take that back.)`);
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
    expect(w.lastReply()).toBe(`${BOT_MARKER} ✓ OK, I dropped that log.`);
    expect(w.db.prepare('SELECT count(*) FROM interactions').pluck().get()).toBe(0);
  });

  it('nobody recognizable → a hint, no effect; hidden people are never matched', async () => {
    const w = commandsWorld();
    w.person('Morgan', 'Hale', { is_hidden: 1 });
    w.say('log: coffee with Morgan', at(0));
    await w.run({ now: at(1) });
    expect(w.lastReply()).toBe(`${BOT_MARKER} Who was that with? Try "log: coffee with Sam R."`);
    expect(w.db.prepare('SELECT count(*) FROM interactions').pluck().get()).toBe(0);
  });

  it('with the AI key: the intent parser (effort low, pseudonymized) adds facts at 0.95 from user_log', async () => {
    const llm = new FakeLlmClient({
      responder: (call) => {
        const token = /^(P\w+) = Sam R\.$/m.exec(call.userText)?.[1] ?? 'P?';
        return {
          json: {
            intent: 'log_interaction',
            image: null,
            command: null,
            question: null,
            log: { people: [{ surface: 'Sam', ref: token }], kind: 'meal', date: '2026-10-14', facts: [{ ref: token, cat: 'location_next', value: 'moving to Denver' }], note: 'dinner' },
            preferences: [],
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
    expect(w.lastReply()).toBe(`${BOT_MARKER} ✓ Logged a meal with Sam R. today.\nNoted: “moving to Denver”\n\n(Text "undo" to take that back.)`);
  });

  it('with the AI key, free text in the window is classified: notes stay silent, questions go to Ask', async () => {
    const llm = new FakeLlmClient()
      .on('intent', { json: { intent: 'note', image: null, command: null, log: null, preferences: [], question: null } }, { json: { intent: 'question', image: null, command: null, log: null, preferences: [], question: 'Who lives in Austin?' } });
    const w = commandsWorld({ llm });
    w.botSays('✓ done', at(0));
    const note = w.say('remember to water plants', at(1));
    w.say('anyone around Austin', at(2));
    await w.run({ now: at(3) });
    expect(llm.calls[0]!.userText).toContain('### ADDRESSED\nno');
    expect(w.command(note.commandId)).toMatchObject({ status: 'ignored', response_outbound_id: null });
    expect(askMock.askForImessage.mock.calls[0]![0]).toBe('Who lives in Austin?');
  });

  it('text addressed to the bot is never dropped as a note: yb and inline replies get "Sorry, I didn\'t get that"', async () => {
    const llm = new FakeLlmClient().on('intent', { json: { intent: 'note', image: null, command: null, log: null, preferences: [], question: null } });
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
    expect(w.lastReply()).toBe(`${BOT_MARKER} Sorry, I didn't get that. Text "help" to see what I can do.`);
  });

  it('people excluded from the AI are never sent: the text is logged deterministically', async () => {
    const llm = new FakeLlmClient().on('intent', { json: { intent: 'note', image: null, command: null, log: null, preferences: [], question: null } });
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
    expect(w.lastReply()).toBe(`${BOT_MARKER} ✓ Logged a call with Sam R. today.\n\n(Text "undo" to take that back.)`);
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
    expect(w.lastReply()).toBe(`${BOT_MARKER} ✓ Undone: 2 done (Priya S.)`);
    w.say('undo 3', at(5));
    await w.run({ now: at(6) });
    expect(w.lastReply()).toBe(`${BOT_MARKER} I can only undo your last command by text. Everything else is at yeackbot.com/today`);
  });

  it('pause 2w writes digest.paused_until (journaled); undo and resume clear it', async () => {
    const { w } = briefWorld();
    w.say('pause 2w', at(1));
    await w.run({ now: at(2) });
    const paused = () => JSON.parse((w.db.prepare(`SELECT value FROM settings WHERE key = 'digest.paused_until'`).pluck().get() as string | undefined) ?? 'null');
    expect(paused()).toBe(at(1) + 14 * DAY);
    expect(w.lastReply()).toBe(`${BOT_MARKER} ✓ Paused your brief until Wed Oct 28. (It's also turned off in Settings.)\nText "resume" to start it again.\n\n(Text "undo" to take that back.)`);
    expect(w.db.prepare(`SELECT count(*) FROM change_batches WHERE kind = 'setting'`).pluck().get()).toBe(1);
    w.say('undo', at(3));
    await w.run({ now: at(4) });
    expect(paused()).toBeNull();
    w.say('pause', at(5));
    w.say('resume', at(6));
    await w.run({ now: at(7) });
    expect(paused()).toBeNull();
    expect(w.lastReply()).toBe(`${BOT_MARKER} ✓ Unpaused. Turn the brief on in Settings to get it.\n\n(Text "undo" to take that back.)`);
  });

  it('why N: the learned explanation, or a fallback while the module is not built', async () => {
    const { w, suggestionIds } = briefWorld();
    w.say('why 1', at(1));
    await w.run({ now: at(2) });
    expect(w.lastReply()).toBe(`${BOT_MARKER} #1 is a "quiet a while" suggestion about Sam R.\nMore at yeackbot.com/today`);
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
    expect(w.lastReply()).toBe(`${BOT_MARKER} Why I suggested Sam R.:\nQuiet 41 days; you usually talk every 9.\n\n• Quiet: 41 days\n\nWhat I've learned: Fading overall ×1.3\n\nMore at yeackbot.com/today`);
  });

  it('draft N: needs the AI key; with it, two drafts (shown to self only)', async () => {
    const off = briefWorld();
    off.w.say('draft 1', at(1));
    await off.w.run({ now: at(2) });
    expect(off.w.lastReply()).toBe(`${BOT_MARKER} I need the AI key to write drafts.`);

    const llm = new FakeLlmClient().on('command', { json: { openers: ['Hey Sam, been too long. Coffee this week?', 'Sam! How did the move go?'] } });
    const on = briefWorld({ llm });
    on.w.say('draft 1', at(1));
    await on.w.run({ now: at(2) });
    expect(llm.calls[0]).toMatchObject({ kind: 'command', effort: 'low' });
    expect(on.w.lastReply()).toBe(
      `${BOT_MARKER} Something you could send Sam R.:\n\n“Hey Sam, been too long. Coffee this week?”\n\nOr:\n\n“Sam! How did the move go?”\n\nCopy it over yourself. I never text anyone but you.`,
    );
    expect(on.w.outbound.sent).toHaveLength(1); // the drafts went to self, never to Sam
  });

  it('more: the next suggestion, one per text, continues the numbering and binds like brief items', async () => {
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
    expect(w.lastReply()).toBe(`${BOT_MARKER} 4. Reconnect with Emery V.?\nYou used to be close, but it's been a long time.\n\nReply "done 4", "skip 4", or "more" for another.`);
    w.say('done 4', at(3));
    await w.run({ now: at(4) });
    expect(w.suggestionStatus(extra)).toBe('done');
    w.say('more', at(5));
    await w.run({ now: at(6) });
    expect(w.lastReply()).toBe(`${BOT_MARKER} That's all I've got for now. Everything's at yeackbot.com/today`);
  });

  it('help and status', async () => {
    const { w } = briefWorld();
    w.say('help', at(1));
    w.say('status', at(2));
    await w.run({ now: at(3) });
    expect(w.replies()[0]).toContain("Here's what you can text me:\n");
    expect(w.replies()[0]).toContain('\n• done 2: you did it\n');
    expect(w.replies()[1]).toBe(`${BOT_MARKER} Your brief is off. You can turn it on in Settings.\nThe last one went out Wed Oct 14.\nAI features are off (no key or budget).`);
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

  it('? without the AI key and nothing found → "I need the AI key"; an answer citing a sensitive fact is withheld', async () => {
    const w = commandsWorld();
    w.say('? who do I know in Austin', at(0));
    await w.run({ now: at(1) });
    expect(w.lastReply()).toBe(`${BOT_MARKER} I need the AI key to answer questions. You can still search at yeackbot.com/ask`);

    const p = w.person('Sam', 'Rivera');
    w.db.prepare(
      `INSERT INTO facts (id, person_id, type, value, value_norm, sensitive, confidence, status, recorded_at, source, created_at, updated_at)
       VALUES ('f-1', ?, 'other', 'private thing', 'private thing', 1, 0.9, 'confirmed', ?, 'test', ?, ?)`,
    ).run(p, at(0), at(0), at(0));
    const seq = w.db.prepare(`SELECT seq FROM facts WHERE id = 'f-1'`).pluck().get() as number;
    askMock.askForImessage.mockResolvedValue(askAnswer('Sam¹', { citations: [{ ref: `F${seq.toString(36)}`, kind: 'fact', label: 'private', href: null, at: null }] }));
    w.say('? tell me about Sam', at(2));
    await w.run({ now: at(3) });
    expect(w.lastReply()).toBe(`${BOT_MARKER} That answer touches something personal, so it's only in the app: yeackbot.com/ask`);

    askMock.askForImessage.mockRejectedValue(new Error('boom'));
    w.say('? anything', at(4));
    await w.run({ now: at(5) });
    expect(w.lastReply()).toBe(`${BOT_MARKER} I hit a problem answering that. Try yeackbot.com/ask`);
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
