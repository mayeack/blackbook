/**
 * Golden-set sampling from the local database: stratified, snapshotted, idempotent top-ups, hidden people and
 * the owner's own "not the same" never sampled. Synthetic data only; nothing reaches the network.
 */
import { describe, expect, it } from 'vitest';
import { renderContext, renderItem } from '../../src/eval/render';
import { sampleSet } from '../../src/eval/sample';
import { allocate, interleave, quoteGrounded, rng, shuffle } from '../../src/eval/util';
import { itemsOf, setCounts } from '../../src/eval/store';
import type { ExtractionPayload, IdentityPayload, ReplyPayload } from '../../src/eval/types';
import { buildEvalWorld, NOW } from './world';

describe('stratified allocation', () => {
  it('splits by weight, caps at what a stratum has, and hands the shortfall to the others', () => {
    const q = allocate(10, [
      { key: 'a', weight: 0.6, available: 100 },
      { key: 'b', weight: 0.3, available: 100 },
      { key: 'c', weight: 0.1, available: 100 },
    ]);
    expect([...q.values()]).toEqual([6, 3, 1]);
    const short = allocate(10, [
      { key: 'a', weight: 0.6, available: 2 },
      { key: 'b', weight: 0.4, available: 100 },
    ]);
    expect(Object.fromEntries(short)).toEqual({ a: 2, b: 8 });
    expect([...allocate(5, [{ key: 'a', weight: 1, available: 3 }]).values()]).toEqual([3]);
  });

  it('seeded shuffles are deterministic; interleave mixes strata', () => {
    expect(shuffle([1, 2, 3, 4, 5, 6], rng(42))).toEqual(shuffle([1, 2, 3, 4, 5, 6], rng(42)));
    expect(shuffle([1, 2, 3, 4, 5, 6], rng(42))).not.toEqual(shuffle([1, 2, 3, 4, 5, 6], rng(7)));
    expect(interleave([[1, 2, 3], [10], [20, 21]])).toEqual([1, 10, 20, 2, 21, 3]);
  });

  it('the groundedness check is verbatim after normalization (no fuzzy pass)', () => {
    expect(quoteGrounded('I took the job at “Lumen Labs”', 'big news, I took the job at "Lumen Labs" and more')).toBe(true);
    expect(quoteGrounded('  Took the JOB at  Lumen Labs!', 'big news, I took the job at Lumen Labs')).toBe(true);
    expect(quoteGrounded('I took a job at Lumen', 'I took the job at Lumen Labs')).toBe(false);
    expect(quoteGrounded('ok', 'ok')).toBe(false);
  });
});

describe('G1 extraction windows', () => {
  it('samples applied and triage-skipped windows with their lines as sent and what was applied', async () => {
    const w = await buildEvalWorld();
    const out = await sampleSet(w.db, 'extraction', { now: NOW, seed: 1 });
    expect(out).toMatchObject({ set: 'extraction', added: 4, pool: 4, total: 4, target: 200 });
    const items = itemsOf(w.db, 'extraction');
    const byWindow = new Map(items.map((i) => [(i.payload as ExtractionPayload).windowId, i]));
    // Strata: source | chat | signal.
    expect(byWindow.get(w.dmWindow)!.stratum).toBe('imessage|dm|commitment');
    expect(byWindow.get(w.groupWindow)!.stratum).toBe('imessage|group|relation');
    expect(byWindow.get(w.emptyWindow)!.stratum).toBe('whatsapp|dm|nothing');
    expect(byWindow.get(w.triagedWindow)!.stratum).toBe('imessage|dm|nothing');

    const dm = byWindow.get(w.dmWindow)!;
    const p = dm.payload as ExtractionPayload;
    expect(p.status).toBe('applied');
    expect(p.userText).toMatch(/^mode=steady/);
    expect(p.lines.filter((l) => l.role === 'new').map((l) => l.msgId)).toContain(w.msgs.m4);
    expect(dm.promptVersion).toMatch(/^[0-9a-f]{8}$/);
    const kinds = dm.predictions.map((x) => `${x.kind}:${x.m.cat}:${x.m.applied}`).sort();
    expect(kinds).toEqual(['commitment:send:true', 'due_date:due_date:true', 'fact:employer:true', 'fact:interest:false', 'fact:location_next:true', 'needs_reply:needs_reply:true']);
    const due = dm.predictions.find((x) => x.kind === 'due_date')!;
    expect(due.label).toBe('Due 2026-10-23');
    // Evidence quotes as sent, for the groundedness check.
    const employer = dm.predictions.find((x) => x.m.cat === 'employer')!;
    expect(employer.m.evidence).toEqual([{ msgId: w.msgs.m1, quote: 'I took the job at Lumen Labs' }]);
    expect(employer.m.key).toBe(`fact|${w.sam}|employer|lumen labs`);

    const triaged = byWindow.get(w.triagedWindow)!;
    expect((triaged.payload as ExtractionPayload).status).toBe('triaged_out');
    expect(triaged.predictions).toEqual([]);
    expect(triaged.title).toContain('skipped by triage');

    // Rendering: real lines (masked), authors, context flags; predictions without metric metadata.
    const r = renderContext(w.db);
    const dto = renderItem(r, dm);
    expect(dto.lines.map((l) => l.author)).toEqual(['Sam R.', 'You', 'Sam R.', 'Sam R.']);
    expect(dto.lines[0]!.ref).toBe(`m:${w.msgs.m1}`);
    expect(dto.title).toMatch(/^iMessage · DM with Sam R\. · Oct 15$/);
    expect(dto.predictions.every((x) => !('m' in x))).toBe(true);
  });

  it('top-ups never duplicate; a window a hidden person wrote in is never sampled', async () => {
    const w = await buildEvalWorld();
    w.db.prepare('UPDATE people SET is_hidden = 1 WHERE id = ?').run(w.dana);
    const a = await sampleSet(w.db, 'extraction', { now: NOW, seed: 3 });
    expect(a.added).toBe(3);
    expect(itemsOf(w.db, 'extraction').some((i) => (i.payload as ExtractionPayload).windowId === w.emptyWindow)).toBe(false);
    const b = await sampleSet(w.db, 'extraction', { now: NOW + 1, seed: 4 });
    expect(b.added).toBe(0);
    expect(setCounts(w.db).find((c) => c.set === 'extraction')).toMatchObject({ total: 3, labeled: 0 });
  });
});

describe('G2 identity pairs', () => {
  it('bands, first-week merges, twins; skips dismissed and hidden pairs', async () => {
    const w = await buildEvalWorld();
    const out = await sampleSet(w.db, 'identity', { now: NOW, seed: 1 });
    const items = itemsOf(w.db, 'identity');
    const byPair = new Map(items.map((i) => [new Set([(i.payload as IdentityPayload).a, (i.payload as IdentityPayload).b]), i]));
    const find = (a: string, b: string) => [...byPair.entries()].find(([k]) => k.has(a) && k.has(b))?.[1];
    expect(find(w.pairs.mergedA, w.pairs.mergedB)).toMatchObject({ stratum: 'first_week', predictions: [{ kind: 'merge', label: 'Same person' }] });
    expect(find(w.pairs.possibleA, w.pairs.possibleB)).toMatchObject({ stratum: 'possible', predictions: [{ kind: 'possible', label: 'Same person' }] });
    expect(find(w.pairs.lowA, w.pairs.lowB)).toMatchObject({ stratum: 'low', predictions: [{ kind: 'separate', label: 'Different people' }] });
    expect(find(w.pairs.twinA, w.pairs.twinB)).toMatchObject({ stratum: 'twin', predictions: [{ kind: 'separate' }] });
    expect(find(w.pairs.dismissedA, w.pairs.dismissedB)).toBeUndefined();
    expect(find(w.pairs.hiddenA, w.pairs.hiddenB)).toBeUndefined();
    expect(out.added).toBe(items.length);

    // Both sides render from the original records (the merged one too), identifiers masked.
    const merged = find(w.pairs.mergedA, w.pairs.mergedB)!;
    const dto = renderItem(renderContext(w.db), merged);
    expect(dto.title).toBe('Avery Q. ↔ Avery Q.');
    const text = dto.lines.map((l) => l.text).join('\n');
    expect(text).toContain('phone ••0111');
    expect(text).not.toContain('+12125550111');
    expect(text).not.toContain('avery.q@example.com');
    expect(dto.lines.filter((l) => l.author === 'A').length).toBeGreaterThan(0);
    expect(dto.lines.filter((l) => l.author === 'B').length).toBeGreaterThan(0);
  });
});

describe('G3 reply debt', () => {
  it('freezes live debts and inbound-last conversations without one at the sampling time', async () => {
    const w = await buildEvalWorld();
    await sampleSet(w.db, 'reply_debt', { now: NOW, seed: 1 });
    const items = itemsOf(w.db, 'reply_debt');
    const pos = items.find((i) => (i.payload as ReplyPayload).debtId === w.debtId)!;
    expect(pos).toMatchObject({ stratum: 'pos|direct|imessage', frozenAt: NOW, predictions: [{ kind: 'needs_reply', label: 'Needs your reply', refs: [`m:${w.msgs.m4}`] }] });
    expect(pos.predictions[0]!.detail).toContain('confirmed by Claude');
    const neg = items.find((i) => (i.payload as ReplyPayload).conversationId === w.jordanDm)!;
    expect(neg).toMatchObject({ stratum: 'neg|direct|imessage', predictions: [{ kind: 'no_reply' }] });
    // Lines stop at the freeze: a reply sent afterwards never shows.
    w.msg(w.jordanDm, null, NOW + 60_000, 'sounds good');
    const dto = renderItem(renderContext(w.db), neg);
    expect(dto.lines.map((l) => [l.author, l.context])).toEqual([
      ['You', true],
      ['Jordan V.', false],
    ]);
    // The group chat ends with Priya just after the extraction run (not old enough to owe a reply) → not sampled;
    // the whatsapp DM ends with me → not a negative case either.
    expect(items.some((i) => (i.payload as ReplyPayload).conversationId === w.whatsapp)).toBe(false);
  });
});

describe('G4 Ask', () => {
  it('one item per distinct question with the people (ranked) and the citations kept', async () => {
    const w = await buildEvalWorld();
    const out = await sampleSet(w.db, 'ask', { now: NOW, seed: 1 });
    expect(out.added).toBe(2);
    const web = itemsOf(w.db, 'ask').find((i) => i.stratum === 'web')!;
    expect(web.predictions.map((p) => [p.kind, p.m.rank ?? null])).toEqual([
      ['person', 1],
      ['person', 2],
      ['citation', null],
    ]);
    expect(web.promptVersion).toBe('abcd1234');
    const dto = renderItem(renderContext(w.db), web);
    expect(dto.lines.map((l) => l.author)).toEqual(['You', 'Yeackbot']);
    // A second sample never re-adds the same question.
    expect((await sampleSet(w.db, 'ask', { now: NOW + 1 })).added).toBe(0);
  });
});
