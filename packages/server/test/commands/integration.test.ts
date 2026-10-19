/**
 * The executor against the REAL neighbouring modules (no mocks): the suggestions feedback entry point
 * (applySuggestionFeedback / whyThis / undoSuggestionFeedback) and the Ask engine's iMessage path. Assertions stay
 * at the contract level (statuses, the reply's shape), not those modules' internals. No AI key: the LLM paths
 * take their documented fallbacks.
 */
import { describe, expect, it } from 'vitest';
import { BOT_MARKER } from '@yb/shared/collector/v1';
import { FakeLlmClient } from '../fakes/llm';
import { BRIEF_AT, commandsWorld, MIN } from './world';

const at = (mins: number) => BRIEF_AT + mins * MIN;

function world() {
  const w = commandsWorld();
  const sam = w.person('Sam', 'Rivera');
  const priya = w.person('Priya', 'Shah');
  const d = w.digest([{ personId: sam }, { personId: priya, kind: 'cooling' }]);
  return { w, sam, priya, ...d };
}

describe('commands × suggestions feedback (real module)', () => {
  it('done → undo round-trips the suggestion; the reward is withdrawn', async () => {
    const { w, suggestionIds } = world();
    w.say('done 2', at(1));
    await w.run({ now: at(2) });
    expect(w.lastReply()).toBe(`${BOT_MARKER} ✓ Nice, marked Priya S. done.\n\n(Text "undo" to take that back.)`);
    expect(w.suggestionStatus(suggestionIds[1]!)).toBe('done');
    const effective = () => w.db.prepare(`SELECT count(*) FROM suggestion_outcomes WHERE suggestion_id = ? AND source = 'explicit' AND effective = 1`).pluck().get(suggestionIds[1]!);
    expect(effective()).toBe(1);
    w.say('undo', at(3));
    await w.run({ now: at(4) });
    expect(w.lastReply()).toBe(`${BOT_MARKER} ✓ Undone: 2 done (Priya S.)`);
    expect(w.suggestionStatus(suggestionIds[1]!)).toBe('delivered');
    expect(effective()).toBe(0);
  });

  it('skip and snooze go through; why explains; draft without the key says so', async () => {
    const { w, suggestionIds } = world();
    w.say('skip 1 · snooze 2 2w', at(1));
    await w.run({ now: at(2) });
    expect(w.lastReply()).toBe(`${BOT_MARKER} ✓ Skipped Sam R. I'll suggest things like that a bit less.\n✓ Snoozed Priya S. until Wed Oct 28.\n\n(Text "undo" to take that back.)`);
    expect(w.suggestionStatus(suggestionIds[0]!)).toBe('dismissed');
    expect(w.suggestionStatus(suggestionIds[1]!)).toBe('snoozed');
    w.say('why 1', at(3));
    await w.run({ now: at(4) });
    expect(w.lastReply()!.startsWith(`${BOT_MARKER} Why I suggested Sam R.:\n`)).toBe(true);
    expect(w.lastReply()!.endsWith('yeackbot.com/today')).toBe(true);
    w.say('draft 2', at(5));
    await w.run({ now: at(6) });
    expect(w.lastReply()).toBe(`${BOT_MARKER} I need the AI key to write drafts.`);
  });
});

describe('commands × Ask (real engine, no AI key)', () => {
  it('nothing found → "I need the AI key"; something found → the retrieval-only answer, ≤600 chars', async () => {
    const w = commandsWorld();
    w.say('? who do I know in Austin', at(0));
    await w.run({ now: at(1) });
    expect(w.lastReply()).toBe(`${BOT_MARKER} I need the AI key to answer questions. You can still search at yeackbot.com/ask`);

    const sam = w.person('Sam', 'Rivera');
    w.db.prepare(
      `INSERT INTO facts (id, person_id, type, value, value_norm, confidence, status, recorded_at, source, created_at, updated_at)
       VALUES ('f-austin', ?, 'location_current', 'Austin', 'austin', 0.9, 'confirmed', ?, 'test', ?, ?)`,
    ).run(sam, at(0), at(0), at(0));
    w.say('? who do I know in Austin', at(2));
    await w.run({ now: at(3) });
    const r = w.lastReply()!;
    expect(r.startsWith(BOT_MARKER)).toBe(true);
    expect(r.length).toBeLessThanOrEqual(600);
    expect(r).toContain('Sam R.');
    expect(w.outbound.sent.at(-1)).toMatchObject({ purpose: 'answer' });
  });
});

describe('commands × egress (real pseudonymizer)', () => {
  it('the intent packet carries tokens and first names only; the parsed ref maps back to the person', async () => {
    const llm = new FakeLlmClient({
      responder: (call) => {
        const token = /^(P[0-9a-z]+) = Sam R\.$/m.exec(call.userText)?.[1] ?? 'none';
        return {
          json: {
            intent: 'log_interaction',
            command: null,
            question: null,
            log: { people: [{ surface: 'Sam', ref: token }], kind: 'drinks', date: null, facts: [{ ref: token, cat: 'interest', value: 'bouldering' }], note: null },
          },
        };
      },
    });
    const w = commandsWorld({ llm, realEgress: true });
    const sam = w.person('Sam', 'Rivera');
    w.say('log: drinks with Sam Rivera, call him at (512) 555-0100, he got into bouldering', at(0));
    await w.run({ now: at(1) });
    expect(llm.calls).toHaveLength(1);
    const sent = llm.calls[0]!.userText;
    expect(sent).toMatch(/^P[0-9a-z]+ = Sam R\.$/m);
    expect(sent).not.toContain('Rivera');
    expect(sent).not.toContain('555-0100');
    expect(w.db.prepare(`SELECT value, source FROM facts WHERE person_id = ?`).get(sam)).toEqual({ value: 'bouldering', source: 'user_log' });
    expect(w.lastReply()).toBe(`${BOT_MARKER} ✓ Logged drinks with Sam R. today.\nNoted: “bouldering”\n\n(Text "undo" to take that back.)`);
  });
});
