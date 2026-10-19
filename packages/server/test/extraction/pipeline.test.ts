/**
 * End to end with the fake LLM client and egress: nightly submit → collect → validate → apply, on synthetic
 * windows only. Nothing here reaches the network (the suite-wide egress guard is active).
 */
import { describe, expect, it } from 'vitest';
import { undoBatch } from '../../src/journal/undo';
import { KNOWLEDGE_SYSTEM, OBLIGATIONS_SYSTEM, STEADY_MAX_TOKENS } from '../../src/extraction/prompt';
import type { FakeCall } from '../fakes/llm';
import { buildEnv } from '../../src/extraction/env';
import { collect, renderWindowSpecs, submitSteady, WINDOW_PROMPT_BUDGET } from '../../src/extraction/run';
import { PROMPT_TOKEN_LIMIT } from '../../src/llm/models';
import { DEFAULT_MODEL, SONNET_5_5 } from '../../src/llm/models';
import { DAY, HOUR, MIN, NOW, buildXWorld, deps, extraction, fact, fakes, lineOf, packetOf, tokenOf, windowsOf } from './world';

const count = (db: import('../../src/db/connection').DB, sql: string, ...p: unknown[]) => db.prepare(sql).pluck().get(...p) as number;

function dmWorld() {
  const w = buildXWorld();
  const t0 = NOW - 6 * HOUR;
  const m1 = w.msg(w.dm, w.ids.sam, t0, 'big news, I took the job at Lumen Labs and I am moving to Denver on Nov 1');
  const m2 = w.msg(w.dm, null, t0 + 2 * MIN, 'whoa congrats!! we need to celebrate before you go');
  const m3 = w.msg(w.dm, w.ids.sam, t0 + 3 * MIN, 'yes! dinner thursday? also I have been climbing a ton lately');
  const m4 = w.msg(w.dm, w.ids.sam, t0 + 4 * MIN, 'can you send me that list of Denver restaurants? my number is 212-555-0109');
  return { w, m1, m2, m3, m4 };
}

describe('steady extraction: submit', () => {
  it('the prompt-size guard: a window whose prompt would pass the budget is split before sending, never sent whole', async () => {
    expect(WINDOW_PROMPT_BUDGET).toBeLessThan(PROMPT_TOKEN_LIMIT);
    const { w } = dmWorld();
    const f = fakes();
    await submitSteady(deps(w, f));
    const win = windowsOf(w.db, w.dm)[0]!.id;
    const env = buildEnv(w.db, NOW);
    const whole = renderWindowSpecs(env, f.egress, win, 'steady');
    expect(whole).toEqual([{ windowId: win, tokens: expect.any(Number) }]);
    const budget = whole[0]!.tokens - 1;
    const parts = renderWindowSpecs(env, f.egress, win, 'steady', budget);
    expect(windowsOf(w.db, w.dm).find((x) => x.id === win)!.status).toBe('split');
    for (const p of parts) expect(p.tokens).toBeLessThanOrEqual(budget);
    // Every message stays covered exactly once — by the children, never by the split parent.
    expect(count(w.db, 'SELECT count(*) FROM extraction_coverage WHERE window_id = ?', win)).toBe(0);
    expect(count(w.db, 'SELECT count(DISTINCT message_id) FROM extraction_coverage')).toBe(count(w.db, 'SELECT count(*) FROM extraction_coverage'));
    expect(count(w.db, 'SELECT count(*) FROM extraction_coverage')).toBe(4);
  });

  it('builds one pseudonymized window per conversation and submits one batch (Haiku, no fallbacks, effort low, thinking off)', async () => {
    const { w } = dmWorld();
    const f = fakes();
    const rep = await submitSteady(deps(w, f));
    expect(rep.status).toBe('ok');
    expect(rep.counts).toMatchObject({ windows: 1, submitted: 1, batches: 1 });
    // One window, two requests in the same batch: knowledge, then obligations (same user turn, same route).
    const calls = f.llm.calls.filter((c) => c.method === 'batch');
    expect(calls).toHaveLength(2);
    const [call, obligations] = calls as [FakeCall, FakeCall];
    for (const c of calls) {
      expect(c).toMatchObject({ kind: 'extract', route: 'extract_steady', model: DEFAULT_MODEL, effort: 'low', thinking: 'disabled', maxTokens: STEADY_MAX_TOKENS, fallbacks: false });
    }
    expect(call.customId).toMatch(/^x[0-9a-f]{8}-[0-9a-f]{32}-0$/);
    expect(obligations.customId).toBe(call.customId!.replace(/-0$/, '_o-0'));
    expect(call.system).toBe(KNOWLEDGE_SYSTEM);
    expect(obligations.system).toBe(OBLIGATIONS_SYSTEM);
    expect(obligations.userText).toBe(call.userText);
    expect(count(w.db, 'SELECT count(*) FROM extraction_items')).toBe(1); // the window keeps one item
    // The user turn: header, cards, line format; the phone number never leaves.
    expect(call.userText).toMatch(/^mode=steady as_of=2026-10-16 tz=America\/Chicago chat=dm members=2/);
    expect(call.userText).toMatch(/\nPEOPLE:\nP1 Sam\n/);
    expect(call.userText).toMatch(/\[m:1\|2026-10-15 21:30\|P1→ME\] big news/);
    expect(call.userText).toMatch(/\[m:2\|2026-10-15 21:32\|ME→P1\] whoa/);
    expect(call.userText).not.toMatch(/212-555-0109/);
    expect(call.userText).toContain('<phone>');
    // System prompt is the byte-stable one.
    expect(call.system).toContain('You are the extraction stage');
    const [win] = windowsOf(w.db, w.dm);
    expect(win).toMatchObject({ status: 'submitted', mode: 'steady', wave: 1 });
    expect(count(w.db, 'SELECT count(*) FROM extraction_coverage WHERE window_id = ?', win!.id)).toBe(4);
  });

  it('degrades gracefully: no key → nothing built, nothing sent', async () => {
    const { w } = dmWorld();
    const f = fakes({ configured: false });
    const rep = await submitSteady(deps(w, f));
    expect(rep).toMatchObject({ status: 'skipped', reason: 'no_key' });
    expect(count(w.db, 'SELECT count(*) FROM windows')).toBe(0);
    expect(f.llm.calls).toHaveLength(0);
  });

  it('budget hit at submit → windows carried over (their messages are given back for tomorrow)', async () => {
    const { w } = dmWorld();
    const f = fakes({ budget: { steady: 0.0001, backfill: null } });
    f.llm.addSpend('steady', 0.00005);
    const rep = await submitSteady(deps(w, f));
    expect(rep.status).toBe('skipped');
    expect(windowsOf(w.db, w.dm).map((x) => x.status)).toEqual(['carried_over']);
    expect(count(w.db, 'SELECT count(*) FROM extraction_coverage')).toBe(0);
    // Next night with budget: the same messages are windowed again (same bounds → the row is reused).
    const g = fakes();
    await submitSteady(deps(w, g, NOW + DAY));
    expect(windowsOf(w.db, w.dm).map((x) => x.status)).toEqual(['submitted']);
  });

  it('triage drops trivial windows without a model call; excluded and hidden people never reach the model', async () => {
    const w = buildXWorld();
    w.msg(w.dm, w.ids.sam, NOW - HOUR, 'lol');
    w.msg(w.dm, null, NOW - HOUR + MIN, '👍');
    const hiddenConv = w.conversation('direct', [w.ids.priya]);
    w.msg(hiddenConv, w.ids.priya, NOW - HOUR, 'are you coming to the climbing gym on saturday');
    w.db.prepare('UPDATE people SET is_hidden = 1 WHERE id = ?').run(w.priya);
    const excluded = w.conversation('direct', [w.ids.jordan]);
    w.msg(excluded, w.ids.jordan, NOW - HOUR, 'I am thinking about adopting a dog next month');
    w.db.prepare(`INSERT INTO settings (key, value, created_at, updated_at) VALUES ('llm.excluded_conversation_ids', ?, 0, 0)`).run(JSON.stringify([excluded]));
    const f = fakes();
    const rep = await submitSteady(deps(w, f));
    expect(rep.counts).toMatchObject({ triaged_trivial: 1, skipped_counterpart: 1, skipped_excluded: 1 });
    expect(f.llm.calls).toHaveLength(0);
    expect(windowsOf(w.db, w.dm).map((x) => x.status)).toEqual(['triaged_out']);
    expect(windowsOf(w.db, hiddenConv)).toEqual([]);
  });

  it('large groups are extracted only when ME takes part', async () => {
    const w = buildXWorld();
    const big = w.conversation('group', [w.ids.jordan, w.ids.priya], 'Neighborhood', 40);
    w.msg(big, w.ids.jordan, NOW - 2 * HOUR, 'the farmers market moved to the parking lot behind the library');
    w.msg(big, w.ids.priya, NOW - 2 * HOUR + MIN, 'thanks for the heads up, see everyone there on sunday');
    const big2 = w.conversation('group', [w.ids.jordan, w.ids.priya], 'Block party', 40);
    w.msg(big2, w.ids.jordan, NOW - 2 * HOUR, 'Robin are you bringing the folding tables again this year');
    const f = fakes();
    const rep = await submitSteady(deps(w, f));
    expect(rep.counts.triaged_large_group).toBe(1);
    expect(windowsOf(w.db, big).map((x) => x.status)).toEqual(['triaged_out']);
    expect(windowsOf(w.db, big2).map((x) => x.status)).toEqual(['submitted']);
  });
});

describe('steady extraction: collect → validate → apply', () => {
  async function submitted() {
    const s = dmWorld();
    const f = fakes();
    await submitSteady(deps(s.w, f));
    const win = windowsOf(s.w.db, s.w.dm)[0]!.id;
    return { ...s, f, win, P: tokenOf(s.w.db, win, s.w.sam), L: (m: number) => lineOf(s.w.db, win, m) };
  }

  it('applies facts, commitments, needs_reply and the summary in one undoable journal batch', async () => {
    const { w, f, win, P, L, m1, m3, m4 } = await submitted();
    f.llm.on(
      `extract:${win}`,
      {
        json: extraction({
          summary: `${P} is moving to Denver for a new job; ME owes ${P} a restaurant list.`,
          facts: [
            fact(P, 'employer', 'Lumen Labs', [{ msg: L(m1), quote: 'I took the job at Lumen Labs' }], 0.92),
            fact(P, 'location_next', 'Denver', [{ msg: L(m1), quote: 'moving to Denver on Nov 1' }], 0.93, { valid_from: '2026-11-01' }),
            // one message only: an interest stays an invisible candidate
            fact(P, 'interest', 'climbing', [{ msg: L(m3), quote: 'I have been climbing a ton lately' }], 0.9),
            // a quote that isn't in the message is dropped
            fact(P, 'pet', 'dog named Biscuit', [{ msg: L(m3), quote: 'my dog Biscuit' }], 0.95),
            // life events are never facts
            fact(P, 'other', 'birthday on Nov 3', [{ msg: L(m1), quote: 'big news' }], 0.95),
          ],
          commitments: [
            {
              owner: 'ME',
              with: [P],
              kind: 'send',
              what: 'send the Denver restaurant list',
              due: { kind: 'none', start: null, end: null },
              status: 'open',
              closes: null,
              ev: [{ msg: L(m4), quote: 'can you send me that list of Denver restaurants?' }],
              conf: 0.85,
            },
          ],
          needs_reply: { state: 'needs_reply', msg: L(m4), reason: 'request', urgency: 'normal', conf: 0.86 },
          topics: ['New Job', 'moving to denver'],
        }),
      },
    );
    const rep = await collect(deps(w, f, NOW + 10 * MIN));
    expect(rep.status).toBe('ok');
    expect(rep.counts).toMatchObject({ applied: 1, factsAdded: 2, candidates: 1, commitments: 1, needsReply: 1, dropped_ev_quote: 1, dropped_fact_excluded: 1 });
    const facts = w.db.prepare(`SELECT type, value, status, prompt_version, valid_from, support FROM facts WHERE person_id = ? ORDER BY type`).all(w.sam) as {
      type: string;
      value: string;
      status: string;
      prompt_version: string;
      valid_from: number | null;
    }[];
    expect(facts.map((x) => [x.type, x.value, x.status])).toEqual([
      ['employer', 'Lumen Labs', 'confirmed'],
      ['interest', 'climbing', 'candidate'],
      ['location_next', 'Denver', 'confirmed'],
    ]);
    expect(facts.every((x) => /^[0-9a-f]{8}$/.test(x.prompt_version))).toBe(true);
    expect(facts.find((x) => x.type === 'location_next')!.valid_from).toBe(Date.UTC(2026, 10, 1, 5));
    expect(count(w.db, `SELECT count(*) FROM evidence WHERE subject_type = 'fact'`)).toBe(3);
    // B2's hooks ran in the same batch.
    const k = w.db.prepare(`SELECT owner, kind, what, origin, prompt_version FROM commitments`).get() as Record<string, string>;
    expect(k).toMatchObject({ owner: 'me', kind: 'send', what: 'send the Denver restaurant list', origin: 'llm' });
    expect(k.prompt_version).toMatch(/^[0-9a-f]{8}$/);
    expect(w.db.prepare('SELECT state, msg_id FROM reply_verdicts').get()).toEqual({ state: 'needs_reply', msg_id: m4 });
    // Summary (tokenized: it is the next window's input), topics, watermark, window status.
    const conv = w.db.prepare('SELECT summary, summary_through_msg, extract_cursor_msg FROM conversations WHERE id = ?').get(w.dm) as Record<string, unknown>;
    expect(conv.summary).toContain(`${P} is moving to Denver`);
    expect(conv.extract_cursor_msg).toBe(m4);
    expect(w.db.prepare('SELECT topic FROM conversation_topics ORDER BY topic').pluck().all()).toEqual(['moving to denver', 'new job']);
    expect(windowsOf(w.db, w.dm)[0]!.status).toBe('applied');
    // One journal batch for the window: undo takes everything back.
    const batch = w.db.prepare(`SELECT id, kind, title, subject_person_id FROM change_batches WHERE kind = 'extraction'`).get() as {
      id: string;
      title: string;
      subject_person_id: string;
    };
    expect(batch.subject_person_id).toBe(w.sam);
    expect(batch.title).toBe('Read a conversation: 2 new facts, 1 promise, 1 reply check');
    undoBatch(w.db, batch.id, { actor: 'user', now: NOW + HOUR });
    expect(w.db.prepare(`SELECT DISTINCT status FROM facts`).pluck().all()).toEqual(['rejected']);
    expect(w.db.prepare(`SELECT status FROM commitments`).pluck().get()).toBe('retracted');
    // Retry of the same window never happens: the messages stay covered.
    const again = await submitSteady(deps(w, f, NOW + DAY));
    expect(again.counts.windows ?? 0).toBe(0);
  });

  it('a second supporting message on another day confirms an interest; NOOP adds support', async () => {
    const { w, f, win, P, L, m3 } = await submitted();
    f.llm.on(`extract:${win}`, { json: extraction({ facts: [fact(P, 'interest', 'climbing', [{ msg: L(m3), quote: 'climbing a ton lately' }], 0.88)] }) });
    await collect(deps(w, f, NOW + 10 * MIN));
    expect(w.db.prepare(`SELECT status, support FROM facts WHERE type = 'interest'`).get()).toEqual({ status: 'candidate', support: 1 });
    // Next day: "bouldering" folds into climbing (synonym map) and promotes it.
    const m5 = w.msg(w.dm, w.ids.sam, NOW + DAY - 2 * HOUR, 'went bouldering again tonight, my forearms are toast');
    const g = f;
    await submitSteady(deps(w, g, NOW + DAY));
    const win2 = windowsOf(w.db, w.dm)[1]!.id;
    const P2 = tokenOf(w.db, win2, w.sam);
    g.llm.on(`extract:${win2}`, { json: extraction({ facts: [fact(P2, 'interest', 'bouldering', [{ msg: lineOf(w.db, win2, m5), quote: 'went bouldering again tonight' }], 0.85)] }) });
    await collect(deps(w, g, NOW + DAY + 10 * MIN));
    expect(w.db.prepare(`SELECT value, status, support FROM facts WHERE type = 'interest'`).all()).toEqual([{ value: 'climbing', status: 'confirmed', support: 2 }]);
  });

  it('UPDATE closes the old value; the card offers F refs and the model targets them', async () => {
    const { w, f, win, P, L, m1 } = await submitted();
    f.llm.on(`extract:${win}`, { json: extraction({ facts: [fact(P, 'location_current', 'Austin', [{ msg: L(m1), quote: 'big news' }], 0.95)] }) });
    await collect(deps(w, f, NOW + 10 * MIN));
    const m6 = w.msg(w.dm, w.ids.sam, NOW + DAY - HOUR, 'officially a Denver resident now, the boxes are everywhere');
    const g = f;
    await submitSteady(deps(w, g, NOW + DAY));
    const win2 = windowsOf(w.db, w.dm)[1]!.id;
    const pk = packetOf(w.db, win2);
    const fRef = Object.keys(pk.facts)[0]!;
    expect(g.llm.calls.filter((c) => c.method === 'batch').at(-1)!.userText).toContain(`${fRef} location_current: Austin`);
    g.llm.on(`extract:${win2}`, {
      json: extraction({
        facts: [
          fact(tokenOf(w.db, win2, w.sam), 'location_current', 'Denver', [{ msg: lineOf(w.db, win2, m6), quote: 'officially a Denver resident now' }], 0.93, {
            op: 'UPDATE',
            target: fRef,
          }),
        ],
      }),
    });
    await collect(deps(w, g, NOW + DAY + 10 * MIN));
    const rows = w.db.prepare(`SELECT value, status, valid_to IS NOT NULL AS closed, superseded_by IS NOT NULL AS sup FROM facts ORDER BY created_at`).all();
    expect(rows).toEqual([
      { value: 'Austin', status: 'invalidated', closed: 1, sup: 1 },
      { value: 'Denver', status: 'confirmed', closed: 0, sup: 0 },
    ]);
  });

  it('fact_blocks and rejected facts are never re-added', async () => {
    const { w, f, win, P, L, m3 } = await submitted();
    w.db.prepare(`INSERT INTO fact_blocks (person_id, type, value_norm, created_at) VALUES (?, 'interest', 'climbing', 0)`).run(w.sam);
    f.llm.on(`extract:${win}`, { json: extraction({ facts: [fact(P, 'interest', 'Climbing', [{ msg: L(m3), quote: 'climbing a ton' }], 0.95)] }) });
    const rep = await collect(deps(w, f, NOW + 10 * MIN));
    expect(rep.counts.factsBlocked).toBe(1);
    expect(count(w.db, 'SELECT count(*) FROM facts')).toBe(0);
  });

  it('refusal in the batch (Haiku: no server-side fallback) → recorded and skipped: window refused, watermark advanced, nothing re-sent', async () => {
    const { w, f, win } = await submitted();
    f.llm.on(`extract:${win}`, { refusal: 'cyber' }, { json: extraction() });
    const rep = await collect(deps(w, f, NOW + 10 * MIN));
    expect(rep.counts).toMatchObject({ batch_refusals: 1, refused: 1 });
    expect(rep.counts.refusal_rerun_ok).toBeUndefined();
    expect(f.llm.calls.filter((c) => c.method === 'parse')).toHaveLength(0);
    expect(f.llm.calls.filter((c) => c.method === 'batch')).toHaveLength(2); // the window's two requests, once
    expect(windowsOf(w.db, w.dm)[0]!.status).toBe('refused');
    expect(count(w.db, 'SELECT count(*) FROM extraction_coverage WHERE window_id = ?', win)).toBe(4);
  });

  it('a Sonnet 5.5 override re-runs a refused window once synchronously WITH fallbacks; still refused → refused', async () => {
    const overrides = { extract_steady: { model: SONNET_5_5 } } as const;
    const s1 = dmWorld();
    const f = fakes({ overrides });
    await submitSteady(deps(s1.w, f));
    const win = windowsOf(s1.w.db, s1.w.dm)[0]!.id;
    f.llm.on(`extract:${win}`, { refusal: 'cyber' }, { json: extraction() });
    const rep = await collect(deps(s1.w, f, NOW + 10 * MIN));
    expect(rep.counts).toMatchObject({ batch_refusals: 1, refusal_rerun_ok: 1 });
    // Both of the window's requests, one after the other.
    const sync = f.llm.calls.filter((c) => c.method === 'parse');
    expect(sync.map((c) => c.system)).toEqual([KNOWLEDGE_SYSTEM, OBLIGATIONS_SYSTEM]);
    for (const c of sync) expect(c).toMatchObject({ route: 'extract_steady', model: SONNET_5_5, fallbacks: true, effort: 'low', subjectRef: win });
    expect(windowsOf(s1.w.db, s1.w.dm)[0]!.status).toBe('applied');

    const s2 = dmWorld();
    const g = fakes({ overrides });
    await submitSteady(deps(s2.w, g));
    const win2 = windowsOf(s2.w.db, s2.w.dm)[0]!.id;
    g.llm.on(`extract:${win2}`, { refusal: 'cyber' });
    const rep2 = await collect(deps(s2.w, g, NOW + 10 * MIN));
    expect(rep2.counts.refused).toBe(1);
    expect(windowsOf(s2.w.db, s2.w.dm)[0]!.status).toBe('refused');
    expect(count(s2.w.db, 'SELECT count(*) FROM extraction_coverage WHERE window_id = ?', win2)).toBe(4);
  });

  it('a Sonnet 5.5 override does NOT re-run a decline the fallback can not rescue (general_harms): refused, nothing re-sent', async () => {
    const { w } = dmWorld();
    const f = fakes({ overrides: { extract_steady: { model: SONNET_5_5 } } });
    await submitSteady(deps(w, f));
    const win = windowsOf(w.db, w.dm)[0]!.id;
    f.llm.on(`extract:${win}`, { refusal: 'general_harms' }, { json: extraction() });
    const rep = await collect(deps(w, f, NOW + 10 * MIN));
    expect(rep.counts).toMatchObject({ batch_refusals: 1, refused: 1 });
    expect(f.llm.calls.filter((c) => c.method === 'parse')).toHaveLength(0);
    expect(windowsOf(w.db, w.dm)[0]!.status).toBe('refused');
  });

  it('max_tokens → requeued once at ×2, then split at the largest gap', async () => {
    const { w, f, win } = await submitted();
    f.llm.on(`extract:${win}`, { maxTokens: true });
    const rep = await collect(deps(w, f, NOW + 10 * MIN));
    expect(rep.counts).toMatchObject({ requeued_max_tokens: 1, resubmitted: 1 });
    // The re-queue sends both requests again at ×2.
    const second = f.llm.calls.filter((c) => c.method === 'batch' && /-1$/.test(c.customId!));
    expect(second.map((c) => c.customId!.replace(/^.*?(_o)?-1$/, '$1'))).toEqual(['', '_o']);
    for (const c of second) expect(c.maxTokens).toBe(STEADY_MAX_TOKENS * 2);
    const rep2 = await collect(deps(w, f, NOW + 20 * MIN));
    expect(rep2.counts.split).toBe(1);
    const ws = windowsOf(w.db, w.dm);
    expect(ws.map((x) => x.status).sort()).toEqual(['split', 'submitted', 'submitted']);
  });

  it('schema-invalid output is retried once, then dead-lettered; invalid_request dead-letters and alerts', async () => {
    const { w, f, win } = await submitted();
    f.llm.on(`extract:${win}`, { text: '{"summary": 3}' });
    await collect(deps(w, f, NOW + 10 * MIN));
    const rep = await collect(deps(w, f, NOW + 20 * MIN));
    expect(rep.counts.dead_letter_schema_invalid).toBe(1);
    expect(windowsOf(w.db, w.dm)[0]!.status).toBe('dead_letter');

    const s2 = dmWorld();
    const g = fakes();
    await submitSteady(deps(s2.w, g));
    const win2 = windowsOf(s2.w.db, s2.w.dm)[0]!.id;
    g.llm.on(`extract:${win2}`, { batchError: 'invalid_request' });
    await collect(deps(s2.w, g, NOW + 10 * MIN));
    expect(windowsOf(s2.w.db, s2.w.dm)[0]!.status).toBe('dead_letter');
    expect(s2.w.db.prepare(`SELECT source FROM alerts`).pluck().get()).toBe('extraction:invalid_request');
  });

  it('errored/other before 06:00 is retried now; expired goes to the next night with attempt + 1', async () => {
    const { w, f, win } = await submitted();
    f.llm.on(`extract:${win}`, { batchError: 'other' }, { expired: true });
    const rep = await collect(deps(w, f, NOW + 10 * MIN)); // 03:40 local
    expect(rep.counts.requeued_errored).toBe(1);
    const rep2 = await collect(deps(w, f, NOW + 20 * MIN));
    expect(rep2.counts.retry_later_expired).toBe(1);
    expect(windowsOf(w.db, w.dm)[0]!.status).toBe('pending');
    await submitSteady(deps(w, f, NOW + DAY));
    expect(f.llm.calls.filter((c) => c.method === 'batch').at(-1)!.customId).toMatch(/-2$/);
  });
});

describe('group windows: mentions, relations, self-identification, waves', () => {
  it('holds facts about unresolved mentions; resolves mentionables; records relations and self-ids', async () => {
    const w = buildXWorld();
    const g1 = w.msg(w.group, w.ids.jordan, NOW - 3 * HOUR, 'field is booked for 10, bring both jerseys');
    const g2 = w.msg(w.group, w.ids.priya, NOW - 3 * HOUR + MIN, 'my roommate Dana wants to join, she just moved to Brooklyn');
    const g3 = w.msg(w.group, w.ids.priya, NOW - 3 * HOUR + 2 * MIN, 'and my cousin is visiting from Lisbon, he is obsessed with surfing');
    const g4 = w.msg(w.group, w.ids.jordan, NOW - 3 * HOUR + 3 * MIN, 'hey all it is Jordan btw, new number');
    const f = fakes();
    await submitSteady(deps(w, f));
    const win = windowsOf(w.db, w.group)[0]!.id;
    const text = f.llm.calls[0]!.userText;
    expect(text).toMatch(/chat=group members=3/);
    expect(text).toMatch(/\nTITLE: Climbing crew\n/);
    expect(text).toMatch(/\nMENTIONABLES:\nP\w+ Dana K\./);
    const J = tokenOf(w.db, win, w.jordan);
    const R = tokenOf(w.db, win, w.priya);
    const D = tokenOf(w.db, win, w.dana);
    const L = (m: number) => lineOf(w.db, win, m);
    expect(text).toMatch(new RegExp(`\\[${L(g1).replace(':', ':')}\\|[^\\]]+\\|${J}\\] field`));
    f.llm.on(`extract:${win}`, {
      json: extraction({
        facts: [
          fact(D, 'location_current', 'Brooklyn', [{ msg: L(g2), quote: 'she just moved to Brooklyn' }], 0.85),
          fact('M2', 'interest', 'surfing', [{ msg: L(g3), quote: 'he is obsessed with surfing' }], 0.9),
        ],
        mentions: [
          { id: 'M1', surface: 'Dana', msg: L(g2), resolved: D, candidates: [], descriptor: `${R}'s roommate` },
          { id: 'M2', surface: 'my cousin', msg: L(g3), resolved: null, candidates: [], descriptor: 'cousin' },
        ],
        relations: [{ op: 'ADD', a: R, b: D, label: 'roommate', sensitive: false, ev: [{ msg: L(g2), quote: 'my roommate Dana' }], conf: 0.9 }],
        self_id: [{ ref: J, name: 'Jordan', context: null, basis: 'new_number', ev: [{ msg: L(g4), quote: 'it is Jordan btw, new number' }], conf: 0.9 }],
      }),
    });
    const rep = await collect(deps(w, f, NOW + 10 * MIN));
    expect(rep.counts).toMatchObject({ factsAdded: 1, pendingHeld: 1, relations: 1, selfIds: 1 });
    expect(w.db.prepare(`SELECT value, status FROM facts WHERE person_id = ?`).get(w.dana)).toEqual({ value: 'Brooklyn', status: 'tentative' });
    expect(w.db.prepare(`SELECT surface, status FROM pending_mention_facts`).get()).toEqual({ surface: 'my cousin', status: 'pending' });
    const [a, b] = [w.priya, w.dana].sort();
    expect(w.db.prepare(`SELECT a_id, b_id, label, origin, status FROM edge_labels`).get()).toEqual({ a_id: a, b_id: b, label: 'roommate', origin: 'llm', status: 'active' });
    expect(w.db.prepare(`SELECT identity_id, name_raw, source, descriptor FROM alias_obs`).get()).toEqual({
      identity_id: w.ids.jordan,
      name_raw: 'Jordan',
      source: 'self_id',
      descriptor: 'new_number',
    });
  });

  it('overflow beyond the 4k budget goes to wave 2 the same night (≤4 waves)', async () => {
    const w = buildXWorld();
    const long = 'we talked through the whole itinerary for the ski weekend again, lodging, rentals, who drives, the works. ';
    // Two sessions of ~2.5k tokens each (gap 3 h): the second overflows into wave 2.
    for (let i = 0; i < 40; i++) w.msg(w.dm, i % 2 ? null : w.ids.sam, NOW - 10 * HOUR + i * MIN, long + long);
    for (let i = 0; i < 40; i++) w.msg(w.dm, i % 2 ? null : w.ids.sam, NOW - 5 * HOUR + i * MIN, long + long);
    const f = fakes();
    await submitSteady(deps(w, f));
    expect(windowsOf(w.db, w.dm).map((x) => [x.status, x.wave])).toEqual([['submitted', 1]]);
    const rep = await collect(deps(w, f, NOW + 10 * MIN));
    expect(rep.counts.applied).toBe(1);
    expect(rep.counts.wave_submitted).toBe(1);
    expect(windowsOf(w.db, w.dm).map((x) => [x.status, x.wave])).toEqual([
      ['applied', 1],
      ['submitted', 2],
    ]);
    // After the wave cutoff (06:30 local) no further waves start.
    expect(count(w.db, `SELECT count(*) FROM extraction_coverage`)).toBe(80);
  });
});

describe('across nights', () => {
  it('a held mention fact applies when a later window resolves the same name; K refs close commitments', async () => {
    const w = buildXWorld();
    const g1 = w.msg(w.group, w.ids.priya, NOW - 3 * HOUR, 'my cousin is visiting from Lisbon, he is obsessed with surfing');
    const d1 = w.msg(w.dm, w.ids.sam, NOW - 3 * HOUR, 'can you send me the trail map from last weekend?');
    const f = fakes();
    await submitSteady(deps(w, f));
    const [gw] = windowsOf(w.db, w.group);
    const [dw] = windowsOf(w.db, w.dm);
    f.llm.on(`extract:${gw!.id}`, {
      json: extraction({
        facts: [fact('M1', 'interest', 'surfing', [{ msg: lineOf(w.db, gw!.id, g1), quote: 'he is obsessed with surfing' }], 0.9)],
        mentions: [{ id: 'M1', surface: 'my cousin', msg: lineOf(w.db, gw!.id, g1), resolved: null, candidates: [], descriptor: 'cousin' }],
      }),
    });
    const S = tokenOf(w.db, dw!.id, w.sam);
    f.llm.on(`extract:${dw!.id}`, {
      json: extraction({
        commitments: [
          {
            owner: 'ME',
            with: [S],
            kind: 'send',
            what: 'send the trail map',
            due: { kind: 'none', start: null, end: null },
            status: 'open',
            closes: null,
            ev: [{ msg: lineOf(w.db, dw!.id, d1), quote: 'send me the trail map' }],
            conf: 0.9,
          },
        ],
      }),
    });
    await collect(deps(w, f, NOW + 10 * MIN));
    expect(w.db.prepare(`SELECT status FROM pending_mention_facts`).pluck().get()).toBe('pending');
    expect(w.db.prepare(`SELECT status FROM commitments`).pluck().get()).toBe('open');

    // Next night: Priya names the cousin (Dana is a mentionable); Sam got the map.
    const g2 = w.msg(w.group, w.ids.priya, NOW + DAY - 2 * HOUR, 'my cousin Dana says hi to everyone from the beach again');
    const d2 = w.msg(w.dm, w.ids.sam, NOW + DAY - 2 * HOUR, 'got the trail map, thank you so much for sending it');
    await submitSteady(deps(w, f, NOW + DAY));
    const gw2 = windowsOf(w.db, w.group)[1]!;
    const dw2 = windowsOf(w.db, w.dm)[1]!;
    const dmText = f.llm.calls.find((c) => c.subjectRef === dw2.id)!.userText;
    expect(dmText).toMatch(/K1 send "send the trail map"/);
    const D = tokenOf(w.db, gw2.id, w.dana);
    f.llm.on(`extract:${gw2.id}`, {
      json: extraction({ mentions: [{ id: 'M1', surface: 'my cousin', msg: lineOf(w.db, gw2.id, g2), resolved: D, candidates: [], descriptor: null }] }),
    });
    f.llm.on(`extract:${dw2.id}`, {
      json: extraction({
        commitments: [
          {
            owner: 'ME',
            with: [tokenOf(w.db, dw2.id, w.sam)],
            kind: 'send',
            what: 'send the trail map',
            due: { kind: 'none', start: null, end: null },
            status: 'done',
            closes: 'K1',
            ev: [{ msg: lineOf(w.db, dw2.id, d2), quote: 'got the trail map' }],
            conf: 0.9,
          },
        ],
      }),
    });
    const rep = await collect(deps(w, f, NOW + DAY + 10 * MIN));
    expect(rep.counts).toMatchObject({ pendingApplied: 1, commitmentsClosed: 1 });
    expect(w.db.prepare(`SELECT status FROM pending_mention_facts`).pluck().get()).toBe('applied');
    expect(w.db.prepare(`SELECT value, status FROM facts WHERE person_id = ?`).get(w.dana)).toEqual({ value: 'surfing', status: 'candidate' });
    expect(w.db.prepare(`SELECT status, closed_reason FROM commitments`).get()).toEqual({ status: 'done', closed_reason: 'said_done' });
    // Held facts expire after 30 days.
    w.db.prepare(`INSERT INTO pending_mention_facts (surface, candidates, fact, status, expires_at, created_at, updated_at) VALUES ('x', '[]', '{}', 'pending', ?, 0, 0)`).run(NOW);
    const later = await collect(deps(w, f, NOW + 40 * DAY));
    expect(later.counts.pending_expired).toBe(1);
  });
});
