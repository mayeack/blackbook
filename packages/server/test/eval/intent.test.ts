/**
 * The intent eval cases, graded offline: an answer built from each case's expectations passes (so every case is
 * satisfiable under the schema and the code-side bounds), wrong answers fail for the right reasons, and the CLI
 * runs them on a scratch database. The live run (`yb eval intent`) is the same code against Claude.
 */
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IMAGE_REF, type IntentOutput } from '../../src/commands/intent';
import { evalCommand } from '../../src/eval/cli';
import { gradeIntent, INTENT_EVAL_CASES, INTENT_FIXTURES, loadFixtureImage, runIntentEval, type IntentEvalCase } from '../../src/eval/intent';
import { createEgress } from '../../src/llm/egress';
import type { DataPaths } from '../../src/config';
import { FakeLlmClient, type FakeCall } from '../fakes/llm';
import { memDb, T0 } from '../helpers';

/** The answer a perfect parser gives for `c` (refs by the tokens the packet showed). */
function idealAnswer(c: IntentEvalCase, call: FakeCall): IntentOutput {
  const token = (who: string) => {
    if (who === 'IMG') return IMAGE_REF;
    const p = c.people.find((x) => x.id === who)!;
    return new RegExp(`^(P\\w+) = ${p.first} ${p.last![0]}\\.$`, 'm').exec(call.userText)![1]!;
  };
  const e = c.expect;
  const people = [...new Set([...(e.people ?? []), ...(e.facts ?? []).map((f) => f.who), ...(e.preferences ?? []).map((p) => p.who), ...(e.reminder?.who ?? [])])];
  const logged = e.intent === 'log_interaction' || e.intent === 'add_fact' || e.intent === 'set_preference' || e.intent === 'reminder';
  return {
    gist: 'g',
    sure: true,
    intent: e.intent,
    image: e.handle ? { handle: e.handle, name: 'Rowan Testperson' } : null,
    command: null,
    log: logged
      ? {
          people: people.map((w) => ({ surface: w === 'IMG' ? 'this person' : 'Sam', ref: token(w) })),
          kind: e.intent === 'log_interaction' ? 'coffee' : 'other',
          date: null,
          facts: (e.facts ?? []).map((f) => ({ ref: token(f.who), cat: f.cats[0]!, value: `a ${f.contains} thing` })),
          note: null,
        }
      : null,
    preferences: (e.preferences ?? []).map((p) => ({ surface: 'them', ref: token(p.who), action: p.action })),
    reminder: e.reminder ? { what: `${e.reminder.contains} them`, kind: e.reminder.kinds[0]!, date: null } : null,
    question: null,
  };
}

const perfect = () =>
  new FakeLlmClient({
    responder: (call) => {
      const c = INTENT_EVAL_CASES.find((x) => call.subjectRef === `cmd:eval-${x.id}`)!;
      return { json: idealAnswer(c, call) };
    },
  });

describe('intent eval cases', () => {
  it('the screenshot fixture exists and is a PNG; the headline case sends it', () => {
    const img = loadFixtureImage('intent-profile-screenshot.png');
    expect(img.mediaType).toBe('image/png');
    expect(Buffer.from(img.data, 'base64').subarray(1, 4).toString()).toBe('PNG');
    expect(fs.readdirSync(INTENT_FIXTURES)).toContain('intent-profile-screenshot.png');
    expect(INTENT_EVAL_CASES.find((c) => c.id === 'screenshot-party-preference')).toMatchObject({
      text: 'Yb prioritize inviting this person to parties, is a great DJ',
      image: 'intent-profile-screenshot.png',
    });
  });

  it('a perfect answer passes every case, with the screenshot attached where the case has one', async () => {
    const db = memDb();
    const llm = perfect();
    const results = await runIntentEval({ llm, egress: createEgress(db), timeZone: 'UTC' }, { now: T0 });
    expect(results.filter((r) => !r.pass)).toEqual([]);
    expect(llm.calls.map((c) => c.images)).toEqual(INTENT_EVAL_CASES.map((c) => (c.image ? 1 : 0)));
  });

  it('grades the misses: wrong intent, the handle, a missing preference, a stray image', () => {
    const c = INTENT_EVAL_CASES[0]!;
    const base = {
      intent: 'set_preference' as const,
      gist: 'g',
      sure: true,
      command: null,
      question: null,
      requestId: 'r',
      engine: 'claude' as const,
      model: 'm',
      reminder: null,
      log: null,
      image: { handle: 'yb.eval.rowan', name: null },
      preferences: [],
    };
    expect(gradeIntent(c, null)).toEqual(['no answer']);
    const miss = gradeIntent(c, { ...base, intent: 'add_fact', image: { handle: 'someone.else', name: null } });
    expect(miss).toEqual(expect.arrayContaining(['intent add_fact ≠ set_preference', 'handle someone.else ≠ yb.eval.rowan', 'preferences [] ≠ [IMG:invite_first]']));
    expect(gradeIntent(INTENT_EVAL_CASES.find((x) => x.id === 'note-to-self')!, { ...base, intent: 'note', preferences: [] })).toContain('image without a screenshot');
  });

  it('`yb eval intent` runs on a scratch database (the data dir is never opened) and exits 0 when all pass', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const paths = { dbPath: '/nonexistent/yb-eval/yeackbot.db' } as unknown as DataPaths;
    const code = await evalCommand(['intent'], paths, { out: (s) => out.push(s), err: (s) => err.push(s) }, { llm: () => perfect(), now: () => T0 });
    expect(err).toEqual([]);
    expect(code).toBe(0);
    expect(out.slice(0, -1).every((l) => l.startsWith('✓ '))).toBe(true);
    expect(out.at(-1)).toMatch(new RegExp(`^${INTENT_EVAL_CASES.length}/${INTENT_EVAL_CASES.length} passed · \\$`));
    const none = await evalCommand(['intent'], paths, { out: () => {}, err: (s) => err.push(s) }, { llm: () => new FakeLlmClient({ configured: false }) });
    expect(none).toBe(1);
    expect(err.at(-1)).toMatch(/nothing was sent/);
  });
});
