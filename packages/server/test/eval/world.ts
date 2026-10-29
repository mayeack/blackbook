/**
 * A synthetic world for the eval tests, built on the extraction tests' chat world (invented names, phones in the
 * fictional 555-01xx range, example.com emails). The extraction windows go through the REAL pipeline
 * (submitSteady → fake batch → collect → validate → apply), so the golden snapshots read genuine rows; identity
 * pairs, reply debts, Ask turns, suggestions and agent batches are seeded directly.
 */
import { uuidv7 } from '@yb/shared';
import { rebuildPersonCanon } from '../../src/db/canon';
import type { DB } from '../../src/db/connection';
import { collect, submitSteady } from '../../src/extraction/run';
import { FakeLlmClient } from '../fakes/llm';
import { seedIdentity, seedPerson } from '../helpers';
import { buildXWorld, DAY, deps, extraction, fact, fakes, HOUR, lineOf, MIN, NOW, tokenOf, windowsOf, type XWorld } from '../extraction/world';

export { DAY, HOUR, MIN, NOW };

export interface EvalWorld extends XWorld {
  /** Applied DM window with facts, a commitment (with a due date) and a needs_reply verdict. */
  dmWindow: string;
  /** Applied group window with one relation. */
  groupWindow: string;
  /** Applied WhatsApp DM window that produced nothing. */
  emptyWindow: string;
  /** Window dropped by triage (never sent). */
  triagedWindow: string;
  msgs: { m1: number; m3: number; m4: number; g1: number };
  whatsapp: string;
  /** Owner-visible people for identity pairs. */
  pairs: { mergedA: string; mergedB: string; possibleA: string; possibleB: string; lowA: string; lowB: string; twinA: string; twinB: string; dismissedA: string; dismissedB: string; hiddenA: string; hiddenB: string };
  jordanDm: string;
  debtId: string;
  turns: { web: string; imessage: string };
  /** The extraction calls' fake (for asserting nothing new was sent). */
  llm: FakeLlmClient;
}

const insert = (db: DB, table: string, row: Record<string, unknown>) => {
  const cols = Object.keys(row);
  return db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => row[c]));
};

export async function buildEvalWorld(): Promise<EvalWorld> {
  const w = buildXWorld();
  const db = w.db;
  const t0 = NOW - 6 * HOUR;

  // ---- conversations for extraction
  const m1 = w.msg(w.dm, w.ids.sam, t0, 'big news, I took the job at Lumen Labs and I am moving to Denver on Nov 1');
  w.msg(w.dm, null, t0 + 2 * MIN, 'whoa congrats!! we need to celebrate before you go');
  const m3 = w.msg(w.dm, w.ids.sam, t0 + 3 * MIN, 'yes! dinner thursday? also I have been climbing a ton lately');
  const m4 = w.msg(w.dm, w.ids.sam, t0 + 4 * MIN, 'can you send me that list of Denver restaurants by Friday Oct 23?');
  const g1 = w.msg(w.group, w.ids.jordan, t0 + 10 * MIN, 'my roommate Priya just signed us up for the bouldering league');
  w.msg(w.group, w.ids.priya, t0 + 11 * MIN, 'it is going to be so much fun, first session is next week');
  const whatsapp = w.conversation('direct', [w.ids.dana]);
  db.prepare(`UPDATE conversations SET source = 'whatsapp' WHERE id = ?`).run(whatsapp);
  w.msg(whatsapp, w.ids.dana, t0 + 20 * MIN, 'the weather has been wild this week, so much rain');
  w.msg(whatsapp, null, t0 + 21 * MIN, 'same here, I barely left the apartment all weekend');
  const trivial = w.conversation('direct', [w.ids.priya]);
  w.msg(trivial, w.ids.priya, t0 + 30 * MIN, 'lol');
  w.msg(trivial, null, t0 + 31 * MIN, '👍');

  const f = fakes();
  await submitSteady(deps(w, f));
  const dmWindow = windowsOf(db, w.dm)[0]!.id;
  const groupWindow = windowsOf(db, w.group)[0]!.id;
  const emptyWindow = windowsOf(db, whatsapp)[0]!.id;
  const triagedWindow = windowsOf(db, trivial)[0]!.id;
  const P = tokenOf(db, dmWindow, w.sam);
  const L = (m: number) => lineOf(db, dmWindow, m);
  f.llm.on(`extract:${dmWindow}`, {
    json: extraction({
      facts: [
        fact(P, 'employer', 'Lumen Labs', [{ msg: L(m1), quote: 'I took the job at Lumen Labs' }], 0.92),
        fact(P, 'location_next', 'Denver', [{ msg: L(m1), quote: 'moving to Denver on Nov 1' }], 0.93, { valid_from: '2026-11-01' }),
        fact(P, 'interest', 'climbing', [{ msg: L(m3), quote: 'I have been climbing a ton lately' }], 0.9),
      ],
      commitments: [
        {
          owner: 'ME',
          with: [P],
          kind: 'send',
          what: 'send the Denver restaurant list',
          due: { kind: 'date', start: '2026-10-23', end: null },
          status: 'open',
          stakes: 'normal',
          closes: null,
          ev: [{ msg: L(m4), quote: 'can you send me that list of Denver restaurants by Friday Oct 23?' }],
          conf: 0.85,
        },
      ],
      needs_reply: { state: 'needs_reply', msg: L(m4), reason: 'request', urgency: 'normal', conf: 0.86 },
    }),
  });
  const J = tokenOf(db, groupWindow, w.jordan);
  const Pr = tokenOf(db, groupWindow, w.priya);
  const G = (m: number) => lineOf(db, groupWindow, m);
  f.llm.on(`extract:${groupWindow}`, {
    json: extraction({
      relations: [{ op: 'ADD', a: J, b: Pr, label: 'roommate', sensitive: false, ev: [{ msg: G(g1), quote: 'my roommate Priya' }], conf: 0.9 }],
    }),
  });
  await collect(deps(w, f, NOW + 10 * MIN));

  // ---- identity pairs
  const person = (first: string, last: string, extra: Record<string, unknown> = {}) => seedPerson(db, { first_name: first, last_name: last, display_name: `${first} ${last}`, ...extra });
  const pairs = {
    mergedA: person('Avery', 'Quinn'),
    mergedB: person('Avery', 'Q'),
    possibleA: person('Morgan', 'Ellis'),
    possibleB: person('Morgan', 'Elis'),
    lowA: person('Riley', 'Stone'),
    lowB: person('Riley', 'Stoner'),
    twinA: person('Casey', 'Morgan'),
    twinB: person('Casey', 'Morgan'),
    dismissedA: person('Jamie', 'Fox'),
    dismissedB: person('Jamie', 'Foxe'),
    hiddenA: person('Taylor', 'Reed'),
    hiddenB: person('Taylor', 'Reid', { is_hidden: 1 }),
  };
  seedIdentity(db, pairs.mergedA, 'phone', '+12125550111');
  seedIdentity(db, pairs.mergedB, 'email', 'avery.q@example.com');
  const runId = uuidv7(NOW);
  insert(db, 'runs', { id: runId, kind: 'nightly', started_at: NOW - DAY, status: 'ok' });
  const batchId = uuidv7(NOW);
  insert(db, 'change_batches', { id: batchId, run_id: runId, kind: 'merge', title: 'Merged two people', actor: 'agent', created_at: NOW - DAY });
  const pair = (a: string, b: string) => (a < b ? [a, b] : [b, a]) as [string, string];
  const cand = (a: string, b: string, p: number, status: string) => {
    const [x, y] = pair(a, b);
    insert(db, 'match_candidates', { a_id: x, b_id: y, score_bits: 10, p, families: JSON.stringify(['name', 'graph']), status, created_at: NOW - DAY, updated_at: NOW - DAY });
  };
  cand(pairs.mergedA, pairs.mergedB, 0.99, 'merged');
  cand(pairs.possibleA, pairs.possibleB, 0.85, 'possible_duplicate');
  cand(pairs.lowA, pairs.lowB, 0.5, 'separate');
  cand(pairs.dismissedA, pairs.dismissedB, 0.9, 'dismissed');
  cand(pairs.hiddenA, pairs.hiddenB, 0.88, 'possible_duplicate');
  insert(db, 'merges', { id: uuidv7(NOW), survivor_id: pairs.mergedA, merged_id: pairs.mergedB, method: 'probabilistic', score: 0.99, batch_id: batchId, created_at: NOW - DAY });
  db.prepare(`UPDATE people SET merged_into_id = ?, status = 'merged' WHERE id = ?`).run(pairs.mergedA, pairs.mergedB);
  rebuildPersonCanon(db);

  // ---- reply debt: Sam's DM owes a reply (open debt); Jordan's DM ends with Jordan, 10 h ago, no debt.
  const debtId = uuidv7(NOW);
  insert(db, 'reply_debts', {
    id: debtId,
    conversation_id: w.dm,
    person_id: w.sam,
    last_inbound_msg: m4,
    asked_at: t0 + 4 * MIN,
    reason: 'request',
    urgency: 'normal',
    classifier: 'llm',
    confidence: 0.86,
    status: 'open',
    debt_msg: m4,
    llm_state: 'needs_reply',
    created_at: NOW,
    updated_at: NOW,
  });
  const jordanDm = w.conversation('direct', [w.ids.jordan]);
  w.msg(jordanDm, null, NOW - 12 * HOUR, 'are you around this weekend?');
  w.msg(jordanDm, w.ids.jordan, NOW - 10 * HOUR, 'maybe! will let you know tomorrow');

  // ---- Ask turns
  const conv = uuidv7(NOW);
  insert(db, 'ask_conversations', { id: conv, title: 'Denver', channel: 'web', created_at: NOW - HOUR, updated_at: NOW - HOUR });
  const web = uuidv7(NOW);
  insert(db, 'ask_turns', {
    id: web,
    conversation_id: conv,
    seq: 1,
    channel: 'web',
    question: 'Who do I know moving to Denver?',
    answer: 'Sam Rivera is moving to Denver [m:x].',
    citations: JSON.stringify([{ ref: `m:${m1.toString(36)}`, kind: 'message', label: 'Sam · iMessage', href: null, at: t0 }]),
    people: JSON.stringify([
      { id: w.sam, displayName: 'Sam Rivera', firstName: 'Sam', state: null },
      { id: w.jordan, displayName: 'Jordan Vale', firstName: 'Jordan', state: null },
    ]),
    violations: 1,
    status: 'done',
    prompt_version: 'abcd1234',
    created_at: NOW - HOUR,
    finished_at: NOW - HOUR + MIN,
  });
  const conv2 = uuidv7(NOW);
  insert(db, 'ask_conversations', { id: conv2, title: 'Climbing', channel: 'imessage', created_at: NOW - HOUR, updated_at: NOW - HOUR });
  const im = uuidv7(NOW);
  insert(db, 'ask_turns', {
    id: im,
    conversation_id: conv2,
    seq: 1,
    channel: 'imessage',
    question: 'who climbs?',
    answer: 'Nobody I could find.',
    citations: '[]',
    people: '[]',
    violations: 0,
    status: 'degraded',
    created_at: NOW - HOUR,
    finished_at: NOW - HOUR + MIN,
  });

  // ---- online signals: four delivered suggestions (done, dismissed, wrong, ignored) and agent batches
  for (const [i, status] of (['done', 'dismissed', 'wrong', 'delivered'] as const).entries()) {
    insert(db, 'suggestions', {
      id: uuidv7(NOW),
      kind: 'fading',
      person_id: w.sam,
      dedupe_key: `fading:test${i}`,
      score: 1,
      signals: '{}',
      status,
      delivered_at: NOW - 5 * DAY,
      created_at: NOW - 5 * DAY,
      updated_at: NOW - 5 * DAY,
    });
  }
  return {
    ...w,
    dmWindow,
    groupWindow,
    emptyWindow,
    triagedWindow,
    msgs: { m1, m3, m4, g1 },
    whatsapp,
    pairs,
    jordanDm,
    debtId,
    turns: { web, imessage: im },
    llm: f.llm,
  };
}
