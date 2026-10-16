/**
 * prompt_version comparison: replay recent + golden windows through the FAKE LLM into shadow rows. Nothing is
 * applied, excluded conversations are never sent, the spend cap stops a run, the diff and the promotion gate are
 * computed from labels, and spot-check items land in the labeling queue. No live LLM calls.
 */
import { describe, expect, it } from 'vitest';
import type { DB } from '../../src/db/connection';
import { saveLabel } from '../../src/eval/labels';
import { sampleSet } from '../../src/eval/sample';
import { planShadow, runShadow } from '../../src/eval/shadow';
import { shadowItems } from '../../src/eval/shadowStore';
import { itemsOf } from '../../src/eval/store';
import type { ExtractionPayload } from '../../src/eval/types';
import { EXTRACTION_PROMPT_VERSION } from '../../src/extraction';
import { EXTRACTION_SYSTEM, STEADY_MAX_TOKENS } from '../../src/extraction/prompt';
import { FakeLlmClient } from '../fakes/llm';
import { extraction, fact, lineOf, tokenOf } from '../extraction/world';
import { buildEvalWorld, HOUR, NOW, type EvalWorld } from './world';

const T = NOW + HOUR;
const snapshot = (db: DB) =>
  ['facts', 'commitments', 'edge_labels', 'reply_verdicts', 'windows', 'evidence', 'reply_debts'].map((t) => db.prepare(`SELECT count(*) FROM ${t}`).pluck().get() as number);

/** The candidate prompt keeps the employer, drops the move, adds the climbing interest, keeps the promise and the reply. */
function scriptedLlm(w: EvalWorld, o: ConstructorParameters<typeof FakeLlmClient>[0] = {}): FakeLlmClient {
  const P = tokenOf(w.db, w.dmWindow, w.sam);
  const L = (m: number) => lineOf(w.db, w.dmWindow, m);
  const llm = new FakeLlmClient({ responder: () => ({ json: extraction() }), ...o });
  llm.on(`extract:${w.dmWindow}`, {
    json: extraction({
      facts: [
        fact(P, 'employer', 'Lumen Labs', [{ msg: L(w.msgs.m1), quote: 'I took the job at Lumen Labs' }], 0.9),
        fact(P, 'interest', 'climbing', [{ msg: L(w.msgs.m3), quote: 'I have been climbing a ton lately' }], 0.88),
      ],
      commitments: [
        {
          owner: 'ME',
          with: [P],
          kind: 'send',
          what: 'send Denver restaurant list',
          due: { kind: 'none', start: null, end: null },
          status: 'open',
          closes: null,
          ev: [{ msg: L(w.msgs.m4), quote: 'can you send me that list of Denver restaurants' }],
          conf: 0.8,
        },
      ],
      needs_reply: { state: 'needs_reply', msg: L(w.msgs.m4), reason: 'request', urgency: 'normal', conf: 0.8 },
    }),
  });
  return llm;
}

describe('shadow replay', () => {
  it('plans read-only: which windows, what version, what it would cost', async () => {
    const w = await buildEvalWorld();
    const p = planShadow({ db: w.db, now: T });
    expect(p).toMatchObject({ promptVersion: EXTRACTION_PROMPT_VERSION, effort: 'low', systemSource: 'code', sameAsCurrent: true, windows: 3, golden: 0, recent: 3, excluded: 0 });
    expect(p.estimateUsd).toBeGreaterThan(0);
    const medium = planShadow({ db: w.db, now: T, effort: 'medium' });
    expect(medium.promptVersion).not.toBe(EXTRACTION_PROMPT_VERSION);
    expect(medium.sameAsCurrent).toBe(false);
    expect(planShadow({ db: w.db, now: T, system: { text: `${EXTRACTION_SYSTEM}\nBe terse.`, source: 'file' } })).toMatchObject({ systemSource: 'file', sameAsCurrent: false });
  });

  it('without an API key nothing is sent and nothing is written', async () => {
    const w = await buildEvalWorld();
    const llm = new FakeLlmClient({ configured: false });
    const out = await runShadow({ db: w.db, llm, now: T });
    expect(out).toMatchObject({ status: 'unavailable', reason: 'no_key' });
    expect(llm.calls).toHaveLength(0);
    expect(w.db.prepare('SELECT count(*) FROM eval_shadow_runs').pluck().get()).toBe(0);
  });

  it('replays into shadow rows only: diff, golden gate, spot-check items; nothing applied', async () => {
    const w = await buildEvalWorld();
    await sampleSet(w.db, 'extraction', { now: NOW, seed: 1 });
    const dmItem = itemsOf(w.db, 'extraction').find((i) => (i.payload as ExtractionPayload).windowId === w.dmWindow)!;
    const id = (cat: string) => dmItem.predictions.find((p) => p.m.cat === cat)!.id;
    saveLabel(w.db, {
      itemId: dmItem.id,
      verdicts: [
        { predictionId: id('employer'), verdict: 'correct' },
        { predictionId: id('location_next'), verdict: 'incorrect' },
        { predictionId: dmItem.predictions.find((p) => p.kind === 'commitment')!.id, verdict: 'correct' },
        { predictionId: dmItem.predictions.find((p) => p.kind === 'needs_reply')!.id, verdict: 'correct' },
      ],
      missing: [],
    });
    // The WhatsApp window still has its model output in the ledger: that becomes its baseline.
    w.db
      .prepare(
        `INSERT INTO llm_requests (custom_id, kind, subject_ref, prompt_version, model, input_hash, status, output, created_at)
         VALUES ('xold-1', 'extract', ?, 'oldver01', 'claude-haiku-5-5', 'h', 'applied', ?, ?)`,
      )
      .run(w.emptyWindow, JSON.stringify(extraction()), NOW);
    const before = snapshot(w.db);
    const llm = scriptedLlm(w);
    const out = await runShadow({ db: w.db, llm, now: T, concurrency: 1 });
    expect(out.status).toBe('done');
    if (out.status === 'unavailable') throw new Error('unreachable');
    // Exactly the stored pseudonymized turns went out, synchronously on the eval_shadow route (Haiku, no fallbacks),
    // at the candidate's effort.
    expect(llm.calls.map((c) => c.subjectRef).sort()).toEqual([w.dmWindow, w.groupWindow, w.emptyWindow].sort());
    for (const c of llm.calls) {
      expect(c).toMatchObject({ method: 'parse', kind: 'extract', route: 'eval_shadow', effort: 'low', fallbacks: false, maxTokens: STEADY_MAX_TOKENS });
      expect(c.system).toBe(EXTRACTION_SYSTEM);
      expect(c.userText).toBe(w.db.prepare('SELECT user_text FROM extraction_packets WHERE window_id = ?').pluck().get(c.subjectRef));
      expect(c.userText).not.toMatch(/555-01|example\.com/);
    }
    // Nothing applied anywhere.
    expect(snapshot(w.db)).toEqual(before);

    const s = out.summary;
    expect(s).toMatchObject({ promptVersion: EXTRACTION_PROMPT_VERSION, windows: 3, byStatus: { ok: 3 }, agree: 3, added: 1, removed: 2 });
    expect(s.byBucket['fact:interest']).toEqual({ agree: 0, added: 1, removed: 0 });
    expect(s.byBucket['fact:location_next']).toEqual({ agree: 0, added: 0, removed: 1 });
    expect(s.byBucket.relation).toEqual({ agree: 0, added: 0, removed: 1 });
    expect(s.byBucket.commitment).toEqual({ agree: 1, added: 0, removed: 0 });
    // Golden window: the replay keeps the labeled-correct claims → no precision drop; the new interest is unlabeled.
    expect(s.golden['fact:employer']).toMatchObject({ baseline: 1, shadow: 1, n: 1 });
    expect(s.golden['fact:location_next']).toMatchObject({ baseline: 0, shadow: null, n: 0 });
    expect(s.golden['fact:interest']).toMatchObject({ unlabeled: 1 });
    expect(s.maxPrecisionDrop).toBe(0);
    const rows = new Map(shadowItems(w.db, out.runId).map((r) => [r.windowId, r]));
    expect(rows.get(w.emptyWindow)).toMatchObject({ baselineSource: 'output', baselineVersion: 'oldver01', status: 'ok' });
    expect(rows.get(w.dmWindow)).toMatchObject({ baselineSource: 'applied', goldenItemId: dmItem.id });

    // Spot-check: the two diff windows are now eval items for the owner to label.
    const spot = itemsOf(w.db, 'extraction', { origin: 'shadow' });
    expect(spot.map((i) => (i.payload as ExtractionPayload).windowId).sort()).toEqual([w.dmWindow, w.groupWindow].sort());
    const dmSpot = spot.find((i) => (i.payload as ExtractionPayload).windowId === w.dmWindow)!;
    expect(dmSpot.promptVersion).toBe(EXTRACTION_PROMPT_VERSION);
    expect(dmSpot.predictions.map((p) => p.m.shadow).sort()).toEqual(['added', 'kept', 'kept', 'kept', 'removed']);
    const added = dmSpot.predictions.find((p) => p.m.shadow === 'added')!;
    saveLabel(w.db, { itemId: dmSpot.id, verdicts: [{ predictionId: added.id, verdict: 'correct' }], missing: [] });
    const { buildReport } = await import('../../src/eval/metrics');
    const r = buildReport(w.db, { now: T });
    const m = (n: string) => r.sets.find((x) => x.set === 'extraction')!.metrics.find((x) => x.name === `shadow[${EXTRACTION_PROMPT_VERSION}].${n}`)!;
    expect(m('agreement')).toMatchObject({ value: 0.5, n: 6, pass: null });
    expect(m('precision_drop_max')).toMatchObject({ value: 0, pass: true });
    expect(m('spot_check')).toMatchObject({ value: 0.5, n: 1, pass: false });
    expect(m('precision.added')).toMatchObject({ value: 1, n: 1 });
    // Golden-set metrics ignore spot-check items.
    expect(r.sets.find((x) => x.set === 'extraction')!.labeled).toBe(1);
  });

  it('skips windows the owner excluded from Claude; the spend cap stops a run early', async () => {
    const w = await buildEvalWorld();
    w.db.prepare(`INSERT INTO settings (key, value, created_at, updated_at) VALUES ('llm.excluded_conversation_ids', ?, 0, 0)`).run(JSON.stringify([w.group]));
    const llm = scriptedLlm(w);
    const out = await runShadow({ db: w.db, llm, now: T, concurrency: 1, maxUsd: 0.0003 });
    expect(llm.calls.some((c) => c.subjectRef === w.groupWindow)).toBe(false);
    if (out.status === 'unavailable') throw new Error('unexpected');
    expect(out.plan.excluded).toBe(1);
    expect(out.stopReason).toBe('max_usd');
    expect(out.status).toBe('partial');
    expect(llm.calls.length).toBe(2); // 2 × $0.0002 (Haiku: 1k in + 200 out) crosses the $0.0003 cap
    const statuses = shadowItems(w.db, out.runId).map((r) => r.status).sort();
    expect(statuses).toEqual(['excluded', 'ok', 'ok']);
  });

  it('a window naming someone hidden since it was built is never re-sent', async () => {
    const w = await buildEvalWorld();
    w.db.prepare('UPDATE people SET is_hidden = 1 WHERE id = ?').run(w.dana);
    const llm = scriptedLlm(w);
    const out = await runShadow({ db: w.db, llm, now: T, concurrency: 1 });
    if (out.status === 'unavailable') throw new Error('unexpected');
    expect(out.plan).toMatchObject({ windows: 2, excluded: 1 });
    expect(llm.calls.map((c) => c.subjectRef)).not.toContain(w.emptyWindow);
  });

  it('a refusal or an unusable answer is recorded, never applied', async () => {
    const w = await buildEvalWorld();
    const llm = new FakeLlmClient({ responder: () => ({ json: extraction() }) });
    llm.on(`extract:${w.dmWindow}`, { refusal: 'cyber' });
    llm.on(`extract:${w.groupWindow}`, { text: 'not json' });
    const out = await runShadow({ db: w.db, llm, now: T, concurrency: 2, spotCheck: 0 });
    if (out.status === 'unavailable') throw new Error('unexpected');
    expect(out.summary.byStatus).toEqual({ ok: 1, refused: 1, invalid: 1 });
    expect(itemsOf(w.db, 'extraction', { origin: 'shadow' })).toHaveLength(0);
  });
});
