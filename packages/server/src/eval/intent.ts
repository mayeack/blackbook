/**
 * Intent evals: synthetic self-thread notes (invented people; a synthetic Instagram-style profile screenshot in
 * eval/fixtures) and what the intent parser must say about each. `yb eval intent` sends them through the real
 * 'intent' route (Haiku 5.5, images included) on a scratch in-memory database, so nothing touches the data DB; a
 * run is ~6 small calls (≈ $0.001) and prints its cost. Tests grade the same cases offline with the fake client.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../config';
import { parseIntent, type IntentDeps, type IntentOutput, type IntentResult, type LogFactCat } from '../commands/intent';
import type { PersonLite } from '../commands/people';
import type { LlmImage } from '../llm/types';
import type { PreferenceKind } from '../pipeline/circles/preferences';

export const INTENT_FIXTURES = path.join(PROJECT_ROOT, 'packages/server/src/eval/fixtures');

/** Who an expectation is about: a candidate's id, or 'IMG' for the person in the screenshot. */
type Who = string;

export interface IntentEvalCase {
  id: string;
  text: string;
  /** Candidates the local name index would offer (synthetic). */
  people: { id: string; first: string; last: string | null }[];
  /** A PNG under eval/fixtures sent with the note. */
  image?: string;
  expect: {
    intent: IntentOutput['intent'];
    /** The username the model must read off the screenshot (normalized). */
    handle?: string;
    /** Exactly these preferences. */
    preferences?: { who: Who; kind: PreferenceKind }[];
    /** At least these facts: one of `cats`, value containing `contains` (case-insensitive). */
    facts?: { who: Who; cats: LogFactCat[]; contains: string }[];
    /** At least these people in log.people. */
    people?: Who[];
  };
}

const SAM = { id: 'eval-sam', first: 'Sam', last: 'Rivera' };

export const INTENT_EVAL_CASES: readonly IntentEvalCase[] = [
  {
    id: 'screenshot-party-preference',
    text: 'Yb prioritize inviting this person to parties, is a great DJ',
    image: 'intent-profile-screenshot.png',
    people: [],
    expect: {
      intent: 'set_preference',
      handle: 'yb.eval.rowan',
      preferences: [{ who: 'IMG', kind: 'party_invites' }],
      facts: [{ who: 'IMG', cats: ['interest', 'activity_pref', 'role', 'job', 'other'], contains: 'dj' }],
    },
  },
  {
    id: 'named-party-preference',
    text: 'yb always invite Sam to my parties',
    people: [SAM],
    expect: { intent: 'set_preference', preferences: [{ who: SAM.id, kind: 'party_invites' }] },
  },
  {
    id: 'screenshot-fact-only',
    text: 'yb this person is moving to Denver next month',
    image: 'intent-profile-screenshot.png',
    people: [],
    expect: { intent: 'add_fact', handle: 'yb.eval.rowan', preferences: [], facts: [{ who: 'IMG', cats: ['location_next', 'travel_plan', 'location_current', 'home_location'], contains: 'denver' }] },
  },
  {
    id: 'fact-is-not-a-preference',
    text: 'yb Sam moved to Denver',
    people: [SAM],
    expect: { intent: 'add_fact', preferences: [], facts: [{ who: SAM.id, cats: ['location_current', 'home_location', 'location_next'], contains: 'denver' }] },
  },
  {
    id: 'coffee-log',
    text: 'yb coffee with Sam yesterday',
    people: [SAM],
    expect: { intent: 'log_interaction', people: [SAM.id], preferences: [] },
  },
  { id: 'note-to-self', text: 'buy oat milk, batteries, tape', people: [], expect: { intent: 'note' } },
];

const whoOf = (s: { personId: string | null; image: boolean }): Who | null => (s.image ? 'IMG' : s.personId);

/** Why `r` fails `c` ([] = pass). */
export function gradeIntent(c: IntentEvalCase, r: IntentResult | null): string[] {
  if (!r) return ['no answer'];
  const out: string[] = [];
  const e = c.expect;
  if (r.intent !== e.intent) out.push(`intent ${r.intent} ≠ ${e.intent}`);
  if (e.handle !== undefined && r.image?.handle !== e.handle) out.push(`handle ${r.image?.handle ?? 'null'} ≠ ${e.handle}`);
  if (!c.image && r.image) out.push('image without a screenshot');
  if (e.preferences) {
    const got = r.preferences.map((p) => `${whoOf(p)}:${p.kind}`).sort();
    const want = e.preferences.map((p) => `${p.who}:${p.kind}`).sort();
    if (got.join() !== want.join()) out.push(`preferences [${got.join(', ')}] ≠ [${want.join(', ')}]`);
  }
  for (const f of e.facts ?? []) {
    const hit = (r.log?.facts ?? []).some((x) => whoOf(x) === f.who && f.cats.includes(x.cat) && x.value.toLowerCase().includes(f.contains.toLowerCase()));
    if (!hit) out.push(`no ${f.cats[0]} fact "${f.contains}" about ${f.who}`);
  }
  for (const p of e.people ?? []) if (!(r.log?.people ?? []).some((x) => whoOf(x) === p)) out.push(`${p} not in log.people`);
  return out;
}

export function loadFixtureImage(name: string): LlmImage {
  const file = path.join(INTENT_FIXTURES, path.basename(name));
  return { mediaType: 'image/png', data: fs.readFileSync(file).toString('base64') };
}

export interface IntentEvalResult {
  id: string;
  pass: boolean;
  failures: string[];
}

const lite = (p: IntentEvalCase['people'][number]): PersonLite => ({
  id: p.id,
  first: p.first,
  last: p.last,
  nickname: null,
  display: [p.first, p.last].filter(Boolean).join(' '),
  company: null,
  priority: false,
  lastAt: null,
});

/** Runs the cases one by one (sequential: the intent route sends no cache marker, so nothing is lost). */
export async function runIntentEval(deps: IntentDeps, o: { now: number; cases?: readonly IntentEvalCase[]; image?: (name: string) => LlmImage }): Promise<IntentEvalResult[]> {
  const out: IntentEvalResult[] = [];
  for (const c of o.cases ?? INTENT_EVAL_CASES) {
    const images = c.image ? [(o.image ?? loadFixtureImage)(c.image)] : [];
    // Addressed like the executor decides it: a "yb" prefix.
    const addressed = /^\s*yb\b/i.test(c.text);
    const r = await parseIntent(deps, { commandId: `eval-${c.id}`, text: c.text, sentAt: o.now, candidates: c.people.map(lite), addressed, images });
    const failures = gradeIntent(c, r);
    out.push({ id: c.id, pass: failures.length === 0, failures });
  }
  return out;
}
