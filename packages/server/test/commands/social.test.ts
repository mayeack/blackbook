/**
 * Social intents over a synthetic self thread, read LOCAL FIRST: "Yb I don't know who Jake M is, deprioritize him"
 * (on 2026-10-21 it came back "Prioritized for party invites": the schema had no way to say deprioritize, so the
 * model picked the only preference there was). The local model (a scripted LocalLlm) answers first; Claude only when
 * it is unsure, unavailable or turned off. Each action is journaled and `undo` reverts it. Invented people only.
 */
import { describe, expect, it } from 'vitest';
import { BOT_MARKER } from '@yb/shared/collector/v1';
import type { IntentOutput } from '../../src/commands/intent';
import { withBatch } from '../../src/journal/batch';
import type { LocalLlm, LocalOutcome, LocalParseRequest } from '../../src/llm/local';
import { addToPreference, applyPreference, preferredPeople, type PreferenceAction } from '../../src/pipeline/circles/preferences';
import { FakeLlmClient } from '../fakes/llm';
import { memDb, seedPerson, T0 } from '../helpers';
import { BRIEF_AT, commandsWorld, MIN, setSetting } from './world';

const at = (mins: number) => BRIEF_AT + mins * MIN;

/** A scripted local model: `answer` gets the user turn it was sent (null = the model isn't pulled). */
function fakeLocal(answer: (user: string) => IntentOutput | null): LocalLlm & { calls: string[] } {
  const calls: string[] = [];
  return {
    url: 'http://127.0.0.1:11434',
    calls,
    info: async (model) => ({ model, available: true, vision: false, thinking: true }),
    parse: async <T,>(req: LocalParseRequest<T>): Promise<LocalOutcome<T>> => {
      calls.push(req.user);
      const v = answer(req.user);
      if (!v) return { status: 'unavailable', reason: 'model_missing', detail: req.model };
      const value = req.schema.parse(v);
      const issues = req.validate?.(value) ?? [];
      return issues.length ? { status: 'invalid', issues, model: req.model, ms: 3 } : { status: 'ok', value, model: req.model, ms: 3 };
    },
  };
}

/** The token a candidate line gives `name` ("P1 = Jake Morales" locally, "P1 = Jake M." for Claude). */
const tokenOf = (user: string, name: string) => new RegExp(`^(P\\w+) = ${name}`, 'm').exec(user)?.[1] ?? null;

function prefAnswer(user: string, name: string, action: PreferenceAction, sure = true): IntentOutput {
  const ref = tokenOf(user, name);
  return {
    gist: `${action} ${name}`,
    intent: 'set_preference',
    sure,
    image: null,
    command: null,
    log: { people: [{ surface: name, ref }], kind: 'other', date: null, facts: [], note: null },
    preferences: [{ surface: name, ref, action }],
    reminder: null,
    question: null,
  };
}

const circle = (db: ReturnType<typeof memDb>, kind: Parameters<typeof preferredPeople>[1]) => [...preferredPeople(db, kind)].sort();
const priority = (db: ReturnType<typeof memDb>, id: string) => db.prepare('SELECT is_priority FROM people WHERE id = ?').pluck().get(id);

describe('social intents, local model first', () => {
  it('"I don\'t know who Jake M is, deprioritize him": read on this Mac, never sent to Claude; off Party invites, deprioritized; undo restores', async () => {
    const local = fakeLocal((u) => prefAnswer(u, 'Jake', 'deprioritize'));
    const llm = new FakeLlmClient();
    const w = commandsWorld({ llm, local });
    const jake = w.person('Jake', 'Morales', { is_priority: 1 });
    w.db.prepare(`INSERT INTO runs (id, kind, status, started_at) VALUES ('seed', 'user', 'ok', ?)`).run(at(-60));
    withBatch(w.db, { runId: 'seed', kind: 'circle', title: 'seed', actor: 'user' }, (t) => addToPreference(t, 'party_invites', [jake]), { now: at(-60) });

    const { commandId } = w.say("Yb I don't know who Jake M is, deprioritize him", at(0));
    await w.run({ now: at(1) });

    expect(local.calls).toHaveLength(1);
    expect(local.calls[0]).toMatch(/^P\w+ = Jake Morales$/m); // the full name: nothing leaves the Mac
    expect(local.calls[0]).toContain("### NOTE (untrusted, verbatim)\nI don't know who Jake M is, deprioritize him");
    expect(llm.calls).toHaveLength(0);
    expect(circle(w.db, 'party_invites')).toEqual([]);
    expect(circle(w.db, 'deprioritized')).toEqual([jake]);
    expect(priority(w.db, jake)).toBe(0);
    expect(w.lastReply()).toBe(`${BOT_MARKER} ✓ Deprioritized Jake M. and took them off Party invites.\n\n(Text "undo" to take that back.)`);
    expect(w.command(commandId)).toMatchObject({ status: 'handled', intent: 'set_preference' });
    expect(w.command(commandId).parsed).toMatchObject({ llm: true, engine: 'local', model: 'llama3.1:8b' });

    w.say('undo', at(2));
    await w.run({ now: at(3) });
    expect(w.lastReply()).toBe(`${BOT_MARKER} ✓ Undone: note for Jake M. + deprioritized, taken off Party invites`);
    expect(circle(w.db, 'party_invites')).toEqual([jake]);
    expect(circle(w.db, 'deprioritized')).toEqual([]);
    expect(priority(w.db, jake)).toBe(1);
  });

  it('the correction "No - DEPRIORITIZE Jake M" (no yb, after a bot text) is read for what it means', async () => {
    const local = fakeLocal((u) => prefAnswer(u, 'Jake', 'deprioritize'));
    const w = commandsWorld({ llm: new FakeLlmClient(), local });
    const jake = w.person('Jake', 'Morales');
    w.botSays('✓ Noted for Jake M.\nPrioritized for party invites.', at(-2));
    w.say('No - DEPRIORITIZE Jake M', at(0));
    await w.run({ now: at(1) });
    expect(local.calls[0]).toContain('### ADDRESSED\nno');
    expect(circle(w.db, 'deprioritized')).toEqual([jake]);
    expect(w.lastReply()).toBe(`${BOT_MARKER} ✓ Deprioritized Jake M.\n\n(Text "undo" to take that back.)`);
  });

  it('unsure locally → Claude decides (pseudonymized); not pulled → Claude; turned off → never asked', async () => {
    const claudeSays = (action: PreferenceAction) =>
      new FakeLlmClient({ responder: (call) => ({ json: prefAnswer(call.userText, 'Jake M\\.', action) }) });

    const unsure = fakeLocal((u) => prefAnswer(u, 'Jake', 'invite_first', false));
    const a = commandsWorld({ llm: claudeSays('deprioritize'), local: unsure });
    const jakeA = a.person('Jake', 'Morales');
    const cmdA = a.say('yb jake m. less', at(0));
    await a.run({ now: at(1) });
    expect(unsure.calls).toHaveLength(1);
    expect(a.llm.calls).toHaveLength(1);
    expect(a.llm.calls[0]!.userText).not.toContain('Morales');
    expect(circle(a.db, 'deprioritized')).toEqual([jakeA]);
    expect(circle(a.db, 'party_invites')).toEqual([]);
    expect(a.command(cmdA.commandId).parsed).toMatchObject({ engine: 'claude' });

    const missing = fakeLocal(() => null);
    const b = commandsWorld({ llm: claudeSays('mute'), local: missing });
    const jakeB = b.person('Jake', 'Morales');
    b.say('yb stop suggesting jake', at(0));
    await b.run({ now: at(1) });
    expect(missing.calls).toHaveLength(1);
    expect(b.llm.calls).toHaveLength(1);
    expect(circle(b.db, 'no_suggestions')).toEqual([jakeB]);

    const off = fakeLocal((u) => prefAnswer(u, 'Jake', 'prioritize'));
    const c = commandsWorld({ llm: claudeSays('mute'), local: off });
    setSetting(c.db, 'llm.local_enabled', false);
    c.person('Jake', 'Morales');
    c.say('yb stop suggesting jake', at(0));
    await c.run({ now: at(1) });
    expect(off.calls).toHaveLength(0);
    expect(c.llm.calls).toHaveLength(1);
  });

  it('without Claude (no key) an unsure local answer still stands; with no model at all the deterministic path answers', async () => {
    const unsure = fakeLocal((u) => prefAnswer(u, 'Jake', 'mute', false));
    const w = commandsWorld({ local: unsure }); // the default fake Claude is unconfigured
    const jake = w.person('Jake', 'Morales');
    w.say('yb maybe stop suggesting jake', at(0));
    await w.run({ now: at(1) });
    expect(circle(w.db, 'no_suggestions')).toEqual([jake]);
    expect(w.lastReply()).toBe(`${BOT_MARKER} ✓ I'll stop suggesting Jake M.\n\n(Text "undo" to take that back.)`);

    const none = commandsWorld({ local: fakeLocal(() => null) });
    none.person('Jake', 'Morales');
    none.say('yb stop suggesting jake', at(0));
    await none.run({ now: at(1) });
    expect(none.lastReply()).toBe(`${BOT_MARKER} Sorry, I didn't get that. Without the AI key I only understand commands, "log:" and "?" questions.`);
  });

  it('"remind me to call Priya on Friday": a reminder (his commitment, from the command) due that day; undo retracts it', async () => {
    const local = fakeLocal((u) => {
      const ref = tokenOf(u, 'Priya');
      return {
        gist: 'remind to call Priya Friday',
        intent: 'reminder',
        sure: true,
        image: null,
        command: null,
        log: { people: [{ surface: 'Priya', ref }], kind: 'other', date: null, facts: [], note: null },
        preferences: [],
        reminder: { what: 'call', kind: 'call', date: '2026-10-16' },
        question: null,
      };
    });
    const w = commandsWorld({ llm: new FakeLlmClient(), local });
    const priya = w.person('Priya', 'Nair');
    w.say('yb remind me to call Priya on Friday', at(0));
    await w.run({ now: at(1) });
    const k = w.db.prepare('SELECT person_id, owner, kind, what, due_precision, due_end, status, origin, confidence FROM commitments').get() as Record<string, unknown>;
    expect(k).toMatchObject({ person_id: priya, owner: 'me', kind: 'call', what: 'call', due_precision: 'date', status: 'open', origin: 'command', confidence: 1 });
    expect(new Date(k.due_end as number).toISOString()).toBe('2026-10-17T04:59:59.999Z'); // end of Oct 16 in Chicago
    expect(w.db.prepare('SELECT count(*) FROM interactions').pluck().get()).toBe(0);
    expect(w.lastReply()).toBe(`${BOT_MARKER} ✓ I'll remind you about Priya N. on Fri Oct 16: call.\n\n(Text "undo" to take that back.)`);

    w.say('undo', at(2));
    await w.run({ now: at(3) });
    expect(w.db.prepare('SELECT status FROM commitments').pluck().get()).toBe('retracted');
  });
});

describe('preference actions (journaled, undoable)', () => {
  const run = (db: ReturnType<typeof memDb>, action: PreferenceAction, ids: string[]) =>
    withBatch(db, { runId: 'r', kind: 'person_update', title: 't', actor: 'user' }, (t) => applyPreference(t, action, ids), { now: T0 });

  it('each action moves people between the reserved circles and sets the flags; the opposite action undoes it', () => {
    const db = memDb();
    db.prepare(`INSERT INTO runs (id, kind, status, started_at) VALUES ('r', 'command', 'running', ?)`).run(T0);
    const a = seedPerson(db, { first_name: 'Ada', last_name: 'Lark', display_name: 'Ada Lark', status: 'active' });

    expect(run(db, 'invite_first', [a]).result).toEqual({ changed: 1, removed: {} });
    expect(circle(db, 'party_invites')).toEqual([a]);
    expect(run(db, 'stop_inviting', [a]).result).toEqual({ changed: 1, removed: { party_invites: 1 } });
    expect([circle(db, 'party_invites'), circle(db, 'no_party_invites')]).toEqual([[], [a]]);
    expect(run(db, 'invite_first', [a]).result.removed).toEqual({ no_party_invites: 1 });

    expect(run(db, 'deprioritize', [a]).result.removed).toEqual({ party_invites: 1 });
    expect(circle(db, 'deprioritized')).toEqual([a]);
    run(db, 'mute', [a]);
    expect(circle(db, 'no_suggestions')).toEqual([a]);
    expect(run(db, 'prioritize', [a]).result).toEqual({ changed: 1, removed: { deprioritized: 1, no_suggestions: 1 } });
    expect([circle(db, 'deprioritized'), circle(db, 'no_suggestions'), priority(db, a)]).toEqual([[], [], 1]);
    run(db, 'mute', [a]);
    run(db, 'unmute', [a]);
    expect(circle(db, 'no_suggestions')).toEqual([]);
    // Nothing to change: no batch, nothing to undo.
    expect(run(db, 'unmute', [a])).toMatchObject({ changes: 0, result: { changed: 0 } });

    const { batchId } = run(db, 'hide', [a]);
    expect(db.prepare('SELECT is_hidden FROM people WHERE id = ?').pluck().get(a)).toBe(1);
    expect(db.prepare('SELECT title FROM change_batches WHERE id = ?').pluck().get(batchId)).toBe('t');
    expect(db.prepare(`SELECT count(*) FROM circles WHERE signature LIKE 'pref:%'`).pluck().get()).toBe(4);
  });
});
