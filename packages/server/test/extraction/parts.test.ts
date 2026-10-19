/**
 * A window read by two requests (knowledge + obligations) that still lives, fails and applies as one window; and the
 * one more try for windows the API refused as invalid under an older prompt (the one-request schema). Synthetic
 * world only (test/extraction/world.ts).
 */
import { describe, expect, it } from 'vitest';
import { joinBatchParts, isObligationsCustomId, mergedText, obligationsCustomId, windowCustomId } from '../../src/extraction/parts';
import { EXTRACTION_PROMPT_VERSION } from '../../src/extraction/prompt';
import { collect, submitSteady } from '../../src/extraction/run';
import { EMPTY_OBLIGATIONS, Extraction } from '../../src/extraction/schema';
import { needsObligations } from '../../src/extraction/validate';
import type { LlmBatchResult } from '../../src/llm/types';
import { ZERO_USAGE } from '../../src/llm/types';
import { DAY, HOUR, MIN, NOW, buildXWorld, deps, extraction, fact, fakes, lineOf, tokenOf, windowsOf } from './world';

const count = (db: import('../../src/db/connection').DB, sql: string, ...p: unknown[]) => db.prepare(sql).pluck().get(...p) as number;

const ok = (customId: string, json: unknown, stopReason: 'end_turn' | 'max_tokens' | 'refusal' = 'end_turn', refusalCategory: string | null = null): LlmBatchResult => ({
  customId,
  type: 'succeeded',
  stopReason,
  text: stopReason === 'refusal' ? null : JSON.stringify(json),
  refusalCategory,
  usage: { ...ZERO_USAGE, batch: true },
});

describe('a window’s two requests', () => {
  const K = 'x73a9fc73-window1-0';
  const O = obligationsCustomId(K);

  it('custom_ids: the obligations request is the window’s id with "_o" after the subject; results map back', () => {
    expect(O).toBe('x73a9fc73-window1_o-0');
    expect(isObligationsCustomId(O)).toBe(true);
    expect(isObligationsCustomId(K)).toBe(false);
    expect(windowCustomId(O)).toBe(K);
    expect(windowCustomId(K)).toBe(K);
    expect(obligationsCustomId('x73a9fc73-abc-12')).toBe('x73a9fc73-abc_o-12');
  });

  it('merge: each part contributes only its own keys; a window without an obligations request gets none', () => {
    const k = extraction({ summary: 'from knowledge', commitments: [{ bogus: true }] });
    const o = extraction({ summary: 'from obligations', needs_reply: { state: 'needs_reply', msg: 'm:2', reason: 'question', urgency: 'high', conf: 0.9 } });
    const joined = joinBatchParts(ok(K, k), ok(O, o), true);
    expect(joined).toMatchObject({ customId: K, type: 'succeeded', stopReason: 'end_turn' });
    const merged = Extraction.parse(JSON.parse((joined as { text: string }).text));
    expect(merged.summary).toBe('from knowledge');
    expect(merged.commitments).toEqual([]);
    expect(merged.needs_reply.state).toBe('needs_reply');
    const alone = Extraction.parse(JSON.parse((joinBatchParts(ok(K, k), null, false) as { text: string }).text));
    expect({ commitments: alone.commitments, needs_reply: alone.needs_reply }).toEqual(EMPTY_OBLIGATIONS);
    // An answer that is not a JSON object fails the merge (→ the window's schema-failure path).
    expect(mergedText(JSON.stringify(k), 'not json')).toBeNull();
    expect((joinBatchParts(ok(K, k), { ...ok(O, o), text: '[1]' } as LlmBatchResult, true) as { text: string | null }).text).toBeNull();
  });

  it('any failure of either part decides for the window: invalid_request > errored > canceled > expired > refusal > cut-off', () => {
    const k = ok(K, extraction());
    const o = ok(O, extraction());
    expect(joinBatchParts(k, { customId: O, type: 'errored', errorType: 'invalid_request', message: 'x' }, true)).toMatchObject({ customId: K, type: 'errored', errorType: 'invalid_request' });
    expect(joinBatchParts({ customId: K, type: 'errored', errorType: 'other', message: 'x' }, { customId: O, type: 'errored', errorType: 'invalid_request', message: 'x' }, true)).toMatchObject({ errorType: 'invalid_request' });
    expect(joinBatchParts(ok(K, {}, 'refusal', 'cyber'), { customId: O, type: 'expired' }, true)).toMatchObject({ customId: K, type: 'expired' });
    expect(joinBatchParts(k, { customId: O, type: 'canceled' }, true)).toMatchObject({ customId: K, type: 'canceled' });
    expect(joinBatchParts(k, ok(O, {}, 'refusal', 'bio'), true)).toMatchObject({ customId: K, type: 'succeeded', stopReason: 'refusal', refusalCategory: 'bio', text: null });
    expect(joinBatchParts(ok(K, {}, 'max_tokens'), o, true)).toMatchObject({ stopReason: 'max_tokens' });
    // The obligations result missing from the batch: the window is retried, never applied half.
    expect(joinBatchParts(k, null, true)).toMatchObject({ customId: K, type: 'errored', errorType: 'other' });
    // Not sent: its absence is fine and its keys come from nowhere.
    expect(joinBatchParts(k, null, false)).toMatchObject({ type: 'succeeded', stopReason: 'end_turn' });
  });

  it('obligations are requested unless they would be dropped (a historical window older than 30 days)', () => {
    const asOf = NOW;
    const line = (at: number) => ({ role: 'new', at }) as never;
    expect(needsObligations({ mode: 'steady', asOf, lines: [line(asOf - 400 * DAY)] })).toBe(true);
    expect(needsObligations({ mode: 'historical', asOf, lines: [line(asOf - 40 * DAY), line(asOf - 20 * DAY)] })).toBe(true);
    expect(needsObligations({ mode: 'historical', asOf, lines: [line(asOf - 40 * DAY), line(asOf - 31 * DAY)] })).toBe(false);
  });
});

function dmWorld() {
  const w = buildXWorld();
  const t0 = NOW - 6 * HOUR;
  const m1 = w.msg(w.dm, w.ids.sam, t0, 'big news, I took the job at Lumen Labs and I am moving to Denver on Nov 1');
  const m2 = w.msg(w.dm, null, t0 + 2 * MIN, 'whoa congrats!! we need to celebrate before you go');
  return { w, m1, m2 };
}

async function submitted() {
  const s = dmWorld();
  const f = fakes();
  await submitSteady(deps(s.w, f));
  const win = windowsOf(s.w.db, s.w.dm)[0]!.id;
  return { ...s, f, win, P: tokenOf(s.w.db, win, s.w.sam), L: (m: number) => lineOf(s.w.db, win, m) };
}

describe('a window’s two requests in the pipeline', () => {
  it('a refused obligations request refuses the window: nothing from the knowledge answer is applied', async () => {
    const { w, f, win, P, L, m1 } = await submitted();
    f.llm.on(`extract:${win}`, { json: extraction({ facts: [fact(P, 'employer', 'Lumen Labs', [{ msg: L(m1), quote: 'I took the job at Lumen Labs' }], 0.92)] }) });
    f.llm.on(`obligations:${win}`, { refusal: 'cyber' });
    const rep = await collect(deps(w, f, NOW + 10 * MIN));
    expect(rep.counts).toMatchObject({ batch_refusals: 1, refused: 1 });
    expect(rep.counts.applied).toBeUndefined();
    expect(count(w.db, 'SELECT count(*) FROM facts')).toBe(0);
    expect(windowsOf(w.db, w.dm)[0]!.status).toBe('refused');
  });

  it('an errored obligations request re-queues the window: both requests go out again at attempt 1, then it applies once', async () => {
    const { w, f, win, P, L, m1 } = await submitted();
    f.llm.on(`extract:${win}`, { json: extraction({ facts: [fact(P, 'employer', 'Lumen Labs', [{ msg: L(m1), quote: 'I took the job at Lumen Labs' }], 0.92)] }) });
    f.llm.on(`obligations:${win}`, { batchError: 'other' }, { json: extraction() });
    const rep = await collect(deps(w, f, NOW + 10 * MIN)); // 03:40 local: retried now
    expect(rep.counts).toMatchObject({ requeued_errored: 1, resubmitted: 1 });
    const retry = f.llm.calls.filter((c) => c.method === 'batch' && /-1$/.test(c.customId!));
    expect(retry.map((c) => isObligationsCustomId(c.customId!))).toEqual([false, true]);
    const rep2 = await collect(deps(w, f, NOW + 20 * MIN));
    expect(rep2.counts).toMatchObject({ applied: 1, factsAdded: 1 });
    expect(count(w.db, 'SELECT count(*) FROM extraction_items WHERE window_id = ?', win)).toBe(2); // attempts 0 and 1
    expect(count(w.db, `SELECT count(*) FROM change_batches WHERE kind = 'extraction'`)).toBe(1);
  });
});

describe('an obligations answer with a value outside an enum', () => {
  const commitment = (P: string, msg: string, over: Record<string, unknown> = {}) => ({
    owner: 'BOTH',
    with: [P],
    kind: 'meet',
    what: 'celebrate before the move',
    due: { kind: 'vague', start: null, end: null },
    status: 'open',
    closes: null,
    ev: [{ msg, quote: 'we need to celebrate before you go' }],
    conf: 0.85,
    ...over,
  });

  it('owner "P66" (a person token) drops that commitment only: the window applies its facts and its other commitment', async () => {
    const { w, f, win, P, L, m1, m2 } = await submitted();
    f.llm.on(`extract:${win}`, { json: extraction({ facts: [fact(P, 'employer', 'Lumen Labs', [{ msg: L(m1), quote: 'I took the job at Lumen Labs' }], 0.92)] }) });
    f.llm.on(`obligations:${win}`, { json: extraction({ commitments: [commitment(P, L(m2), { owner: 'P66' }), commitment(P, L(m2))] }) });
    const rep = await collect(deps(w, f, NOW + 10 * MIN));
    expect(rep.counts).toMatchObject({ applied: 1, factsAdded: 1, commitments: 1, dropped_commitment_bad_enum: 1 });
    expect(Object.keys(rep.counts).filter((k) => /schema_invalid|dead_letter|requeued/.test(k))).toEqual([]);
    expect(w.db.prepare('SELECT type, value FROM facts').all()).toEqual([{ type: 'employer', value: 'Lumen Labs' }]);
    expect(w.db.prepare('SELECT person_id, owner, kind FROM commitments').all()).toEqual([{ person_id: w.sam, owner: 'both', kind: 'meet' }]);
    expect(windowsOf(w.db, w.dm)[0]!.status).toBe('applied');
    expect(count(w.db, `SELECT count(*) FROM extraction_items WHERE window_id = ? AND outcome = 'ok'`, win)).toBe(1);
  });

  it('a structural error in the same answer still fails the whole window (schema_invalid, retried)', async () => {
    const { w, f, win, P, L, m1, m2 } = await submitted();
    f.llm.on(`extract:${win}`, { json: extraction({ facts: [fact(P, 'employer', 'Lumen Labs', [{ msg: L(m1), quote: 'I took the job at Lumen Labs' }], 0.92)] }) });
    const { kind: _, ...kindless } = commitment(P, L(m2));
    f.llm.on(`obligations:${win}`, { json: extraction({ commitments: [commitment(P, L(m2), { owner: 'P66' }), kindless] }) });
    const rep = await collect(deps(w, f, NOW + 10 * MIN));
    expect(rep.counts).toMatchObject({ requeued_schema_invalid: 1 });
    expect(rep.counts.applied).toBeUndefined();
    expect(count(w.db, 'SELECT count(*) FROM facts')).toBe(0);
  });
});

describe('windows the API refused under an older prompt', () => {
  async function deadLettered() {
    const { w, f, win } = await submitted();
    f.llm.on(`extract:${win}`, { batchError: 'invalid_request' }, { json: extraction() });
    await collect(deps(w, f, NOW + 10 * MIN));
    expect(windowsOf(w.db, w.dm)[0]!.status).toBe('dead_letter');
    return { w, f, win };
  }

  it('go back to pending once and are sent under the current prompt version at the next nightly submit', async () => {
    const { w, f, win } = await deadLettered();
    // As if it had been refused under the one-request prompt (7e37e334).
    w.db.prepare(`UPDATE extraction_items SET prompt_version = '7e37e334' WHERE window_id = ?`).run(win);
    const rep = await submitSteady(deps(w, f, NOW + DAY));
    expect(rep.counts).toMatchObject({ revived_invalid_request: 1, submitted: 1 });
    expect(windowsOf(w.db, w.dm).map((x) => [x.id, x.status])).toEqual([[win, 'submitted']]);
    const resent = f.llm.calls.filter((c) => c.method === 'batch').slice(-2);
    for (const c of resent) expect(c.customId).toMatch(new RegExp(`^x${EXTRACTION_PROMPT_VERSION}-.*-1$`));
    expect((await collect(deps(w, f, NOW + DAY + 10 * MIN))).counts.applied).toBe(1);
  });

  it('a window refused as invalid under the current version stays dead (no retry loop)', async () => {
    const { w, f } = await deadLettered();
    const rep = await submitSteady(deps(w, f, NOW + DAY));
    expect(rep.counts.revived_invalid_request).toBeUndefined();
    expect(windowsOf(w.db, w.dm)[0]!.status).toBe('dead_letter');
  });
});
