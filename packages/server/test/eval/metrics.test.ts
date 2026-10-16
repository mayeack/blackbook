/**
 * Labels → metrics: per-field precision / recall, due dates, groundedness, schema validity, refusals, identity
 * pairwise precision + duplicate recall, reply-debt P/R, Ask recall@10 + citation validity, online rates.
 * Every expected number below is worked out by hand from the synthetic world.
 */
import { describe, expect, it } from 'vitest';
import { EvalReport, uuidv7, type EvalMetric } from '@yb/shared';
import type { DB } from '../../src/db/connection';
import { saveLabel } from '../../src/eval/labels';
import { buildReport, missingKind } from '../../src/eval/metrics';
import { sampleSet } from '../../src/eval/sample';
import { itemsOf } from '../../src/eval/store';
import type { ExtractionPayload, IdentityPayload, Item, ReplyPayload } from '../../src/eval/types';
import { HttpError } from '../../src/http/errors';
import { buildEvalWorld, HOUR, NOW, type EvalWorld } from './world';

const metricOf = (r: EvalReport, set: string, name: string): EvalMetric => {
  const m = (set === 'online' ? r.online : r.sets.find((s) => s.set === set)!.metrics).find((x) => x.name === name);
  if (!m) throw new Error(`no metric ${set}/${name}`);
  return m;
};

const pred = (it: Item, test: (p: Item['predictions'][number]) => boolean) => {
  const p = it.predictions.find(test);
  if (!p) throw new Error('no such prediction');
  return p.id;
};

async function labeledWorld(): Promise<{ w: EvalWorld; db: DB }> {
  const w = await buildEvalWorld();
  const db = w.db;
  for (const set of ['extraction', 'identity', 'reply_debt', 'ask'] as const) await sampleSet(db, set, { now: NOW, seed: 1 });
  const ex = (windowId: string) => itemsOf(db, 'extraction').find((i) => (i.payload as ExtractionPayload).windowId === windowId)!;

  const dm = ex(w.dmWindow);
  saveLabel(db, {
    itemId: dm.id,
    verdicts: [
      { predictionId: pred(dm, (p) => p.m.cat === 'employer'), verdict: 'correct' },
      { predictionId: pred(dm, (p) => p.m.cat === 'location_next'), verdict: 'correct' },
      { predictionId: pred(dm, (p) => p.m.cat === 'interest'), verdict: 'correct' }, // a correct but invisible candidate
      { predictionId: pred(dm, (p) => p.kind === 'commitment'), verdict: 'correct' },
      { predictionId: pred(dm, (p) => p.kind === 'due_date'), verdict: 'incorrect' },
      { predictionId: pred(dm, (p) => p.kind === 'needs_reply'), verdict: 'correct' },
    ],
    missing: ['commitment: dinner on Thursday'],
  });
  const group = ex(w.groupWindow);
  saveLabel(db, { itemId: group.id, verdicts: [{ predictionId: pred(group, (p) => p.kind === 'relation'), verdict: 'incorrect' }], missing: [] });
  saveLabel(db, { itemId: ex(w.emptyWindow).id, verdicts: [], missing: [] });

  const pair = (a: string, b: string) => itemsOf(db, 'identity').find((i) => new Set([(i.payload as IdentityPayload).a, (i.payload as IdentityPayload).b]).has(a) && new Set([(i.payload as IdentityPayload).a, (i.payload as IdentityPayload).b]).has(b))!;
  const judge = (it: Item, verdict: 'correct' | 'incorrect') => saveLabel(db, { itemId: it.id, verdicts: [{ predictionId: 'pair', verdict }], missing: [] });
  judge(pair(w.pairs.mergedA, w.pairs.mergedB), 'correct'); // merged, really the same
  judge(pair(w.pairs.possibleA, w.pairs.possibleB), 'incorrect'); // flagged, actually different
  judge(pair(w.pairs.lowA, w.pairs.lowB), 'incorrect'); // kept apart, actually the same (a missed duplicate)
  judge(pair(w.pairs.twinA, w.pairs.twinB), 'correct'); // different people

  const rd = itemsOf(db, 'reply_debt');
  const pos = rd.find((i) => (i.payload as ReplyPayload).debtId === w.debtId)!;
  const neg = rd.find((i) => (i.payload as ReplyPayload).conversationId === w.jordanDm)!;
  saveLabel(db, { itemId: pos.id, verdicts: [{ predictionId: 'reply', verdict: 'correct' }], missing: [] });
  saveLabel(db, { itemId: neg.id, verdicts: [{ predictionId: 'reply', verdict: 'incorrect' }], missing: [] }); // a missed debt

  const web = itemsOf(db, 'ask').find((i) => i.stratum === 'web')!;
  saveLabel(db, { itemId: web.id, verdicts: [{ predictionId: `p:${w.jordan}`, verdict: 'incorrect' }], missing: [], expectedPersonIds: [w.sam, w.dana] });

  // LLM ledger: 3 parsed, 1 schema-invalid (a shadow replay's request never counts).
  const req = (status: string, runId: string | null = null) =>
    db
      .prepare(
        `INSERT INTO llm_requests (custom_id, kind, subject_ref, prompt_version, model, input_hash, status, run_id, created_at) VALUES (?, 'extract', 'w', 'v1', 'claude-haiku-5-5', 'h', ?, ?, ?)`,
      )
      .run(`x${uuidv7().replace(/-/g, '').slice(0, 20)}`, status, runId, NOW);
  req('applied');
  req('applied');
  req('succeeded');
  req('schema_invalid');
  db.prepare(`INSERT INTO eval_shadow_runs (id, prompt_version, effort, system_source, since_at, through_at, status, started_at) VALUES ('shadowrun', 'v2', 'low', 'code', 0, 0, 'stopped', ?)`).run(NOW);
  req('schema_invalid', 'shadowrun');
  return { w, db };
}

describe('the eval report', () => {
  it('scores the labeled golden sets against the targets', async () => {
    const { db } = await labeledWorld();
    const r = buildReport(db, { now: NOW + HOUR });
    expect(EvalReport.safeParse(r).success).toBe(true);
    const ex = (n: string) => metricOf(r, 'extraction', n);
    expect(r.sets.find((s) => s.set === 'extraction')!.labeled).toBe(3);
    // applied claims: employer ✓, location_next ✓, commitment ✓, needs_reply ✓, relation ✗
    expect(ex('precision')).toMatchObject({ value: 0.8, n: 5, target: 0.9, pass: false });
    expect(ex('precision.facts')).toMatchObject({ value: 1, n: 2, pass: true });
    expect(ex('precision.fact.employer')).toMatchObject({ value: 1, n: 1 });
    expect(ex('precision.interest')).toMatchObject({ value: null, n: 0, pass: null }); // the interest is only a candidate
    expect(ex('precision.candidate')).toMatchObject({ value: 1, n: 1, pass: null });
    expect(ex('precision.commitment')).toMatchObject({ value: 1, n: 1, target: 0.85, pass: true });
    expect(ex('precision.needs_reply')).toMatchObject({ value: 1, n: 1 });
    expect(ex('precision.relation')).toMatchObject({ value: 0, n: 1, pass: false });
    // recall = 4 true shown ÷ (4 + 1 hidden-but-true candidate + 1 missing)
    expect(ex('recall')).toMatchObject({ value: 0.6667, n: 6, target: 0.7, pass: false });
    expect(ex('recall.fact')).toMatchObject({ value: 0.6667, n: 3 });
    expect(ex('recall.commitment')).toMatchObject({ value: 0.5, n: 2 });
    expect(ex('due_date_±1d')).toMatchObject({ value: 0, n: 1, pass: false });
    // every applied claim's quote is verbatim in its cited NEW line as sent (employer, location, commitment, relation)
    expect(ex('groundedness')).toMatchObject({ value: 1, n: 4, pass: true });
    expect(ex('schema_valid')).toMatchObject({ value: 0.75, n: 4, pass: false });
    expect(ex('refusal_rate')).toMatchObject({ value: 0, n: 3, higherIsBetter: false, pass: true });

    const id = (n: string) => metricOf(r, 'identity', n);
    expect(id('identity.auto_merge_precision')).toMatchObject({ value: 1, n: 1, target: 0.995, pass: true });
    expect(id('identity.duplicate_recall')).toMatchObject({ value: 0.5, n: 2, pass: false });
    expect(id('identity.review_precision')).toMatchObject({ value: 0, n: 1, pass: null });

    expect(metricOf(r, 'reply_debt', 'reply_debt.precision')).toMatchObject({ value: 1, n: 1, pass: true });
    expect(metricOf(r, 'reply_debt', 'reply_debt.recall')).toMatchObject({ value: 0.5, n: 2, pass: false });
    expect(metricOf(r, 'reply_debt', 'reply_debt.precision.llm')).toMatchObject({ value: 1, n: 1 });

    // Ask: expected {Sam, Dana}, the answer named Sam (and Jordan) → 0.5; one kept citation + one stripped → 0.5
    expect(metricOf(r, 'ask', 'ask.recall@10')).toMatchObject({ value: 0.5, n: 1, target: 0.8, pass: false });
    expect(metricOf(r, 'ask', 'ask.citation_validity')).toMatchObject({ value: 0.5, n: 2, target: 1, pass: false });

    // online: 4 delivered suggestions (done, dismissed, wrong, ignored); no agent change undone
    expect(metricOf(r, 'online', 'digest_action_rate')).toMatchObject({ value: 0.25, n: 4, pass: false });
    expect(metricOf(r, 'online', 'dismiss_rate')).toMatchObject({ value: 0.25, pass: true });
    expect(metricOf(r, 'online', 'wrong_rate')).toMatchObject({ value: 0.25, pass: false });
    expect(metricOf(r, 'online', 'agent_undo_rate')).toMatchObject({ value: 0, pass: true });
    expect(metricOf(r, 'online', 'merge_undo_rate')).toMatchObject({ value: 0, n: 1, pass: true });
    expect(r.promptVersions).toContain('abcd1234');
    expect(r.promptVersions).toContain('v2');
    // Counts and rates only: no names, values or message text anywhere in the report.
    const text = JSON.stringify(r);
    for (const s of ['Sam', 'Rivera', 'Lumen', 'Denver', 'Avery', 'roommate', '555']) expect(text).not.toContain(s);
  });

  it('an empty database reports no data (null values, pass null), never an error', async () => {
    const { memDb } = await import('../helpers');
    const r = buildReport(memDb(), { now: NOW });
    expect(EvalReport.safeParse(r).success).toBe(true);
    for (const s of r.sets) for (const m of s.metrics) expect(m.value === null ? m.pass : 'x').toBe(m.value === null ? null : 'x');
  });

  it('an undone merge and a wrong citation move the right numbers', async () => {
    const { w, db } = await labeledWorld();
    db.prepare('UPDATE merges SET undone_at = ?').run(NOW);
    const web = itemsOf(db, 'ask').find((i) => i.stratum === 'web')!;
    saveLabel(db, { itemId: web.id, verdicts: [{ predictionId: 'c:0', verdict: 'incorrect' }], missing: [], expectedPersonIds: [w.sam] });
    const r = buildReport(db, { now: NOW + HOUR });
    expect(metricOf(r, 'online', 'merge_undo_rate')).toMatchObject({ value: 1, pass: false });
    expect(metricOf(r, 'ask', 'ask.citation_validity')).toMatchObject({ value: 0, n: 2 });
    expect(metricOf(r, 'ask', 'ask.recall@10')).toMatchObject({ value: 1, n: 1 });
  });
});

describe('labels', () => {
  it('validate prediction ids, expected people and replace on relabel', async () => {
    const w = await buildEvalWorld();
    await sampleSet(w.db, 'extraction', { now: NOW });
    await sampleSet(w.db, 'ask', { now: NOW });
    const it = itemsOf(w.db, 'extraction')[0]!;
    expect(() => saveLabel(w.db, { itemId: it.id, verdicts: [{ predictionId: 'nope', verdict: 'correct' }], missing: [] })).toThrow(HttpError);
    expect(() => saveLabel(w.db, { itemId: it.id, verdicts: [], missing: [], expectedPersonIds: [w.sam] })).toThrow(/Ask questions only/);
    expect(() => saveLabel(w.db, { itemId: 'missing', verdicts: [], missing: [] })).toThrow(/not found/);
    const ask = itemsOf(w.db, 'ask')[0]!;
    w.db.prepare('UPDATE people SET is_hidden = 1 WHERE id = ?').run(w.dana);
    expect(() => saveLabel(w.db, { itemId: ask.id, verdicts: [], missing: [], expectedPersonIds: [w.dana] })).toThrow(/unknown or hidden/);
    saveLabel(w.db, { itemId: it.id, verdicts: [], missing: ['interest: pottery', 'interest: pottery'], note: '  first pass  ' }, NOW);
    saveLabel(w.db, { itemId: it.id, verdicts: [], missing: [] }, NOW + 1);
    const again = itemsOf(w.db, 'extraction').find((x) => x.id === it.id)!;
    expect(again.label).toEqual({ verdicts: [], missing: [], note: null, labeledAt: NOW + 1 });
  });

  it('missing items may be tagged by kind', () => {
    expect(missingKind('interest: pottery')).toBe('fact');
    expect(missingKind('Location current: Austin')).toBe('fact');
    expect(missingKind('commitment: dinner')).toBe('commitment');
    expect(missingKind('reply: she asked about Saturday')).toBe('needs_reply');
    expect(missingKind('relation: they are cousins')).toBe('relation');
    expect(missingKind('she likes pottery')).toBeNull();
  });
});
