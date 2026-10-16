import { describe, expect, it } from 'vitest';
import { uuidv7 } from '@yb/shared';
import { undoBatch } from '../../../src/journal/undo';
import { applySuggestionFeedback, undoSuggestionFeedback, validateOpeners, whyThis } from '../../../src/pipeline/suggestions/feedback';
import { generators as defaultGenerators } from '../../../src/pipeline/suggestions/generators';
import { effectiveOutcome, personState, readArm } from '../../../src/pipeline/suggestions/learner';
import { runSuggestionsStage } from '../../../src/pipeline/suggestions/stage';
import { readSetting } from '../../../src/settings/registry';
import { servicesFor } from '../../../src/services';
import type { DB } from '../../../src/db/connection';
import { FakeEgress, FakeLlmClient } from '../../fakes/llm';
import { circle, commitment, DAY, fadingFriend, fixedGenerator, friend, HOUR, message, occasion, replyDebt, setSetting, stats, suggestionRow, suggestionsDb, T0 } from './world';

const web = (now = T0 + HOUR) => ({ channel: 'web' as const, now });

async function rank(db: DB, extra: Parameters<typeof runSuggestionsStage>[1] = {}) {
  const r = await runSuggestionsStage(db, { now: T0, seed: 5, generators: defaultGenerators, wildcardSources: [], ...extra });
  const byKind = (k: string) => r.selectedIds.find((id) => suggestionRow(db, id).kind === k)!;
  return { r, byKind };
}

function world() {
  const db = suggestionsDb();
  setSetting(db, 'learner.enabled', false);
  const sam = friend(db, 'Avery', 'Quill');
  stats(db, sam.id, { tie: 60 });
  const debt = replyDebt(db, sam, T0 - 30 * HOUR);
  const fading = fadingFriend(db, 'Bram', 'Ostrow');
  const cleo = friend(db, 'Cleo', 'Marsh');
  const promise = commitment(db, cleo.id);
  return { db, sam, debt, fading, cleo, promise };
}

describe('suggestion feedback', () => {
  it('done: reward 1, the reply debt closes through the journal (undoable), idempotent per command', async () => {
    const { db, sam, debt } = world();
    const { byKind } = await rank(db);
    const id = byKind('reply_debt');
    const res = await applySuggestionFeedback(db, id, { action: 'done' }, { channel: 'imessage', now: T0 + HOUR, inboundCommandId: 'cmd-1' });
    expect(res).toMatchObject({ suggestionId: id, status: 'done', why: null, openers: null });
    expect(res.batchId).not.toBeNull();
    expect(db.prepare('SELECT status, closed_reason FROM reply_debts WHERE id = ?').get(debt.id)).toEqual({ status: 'replied', closed_reason: 'done_command' });
    expect(db.prepare('SELECT kind, actor, title FROM change_batches WHERE id = ?').get(res.batchId)).toEqual({
      kind: 'reply_debt',
      actor: 'user',
      title: 'Closed a reply owed (you marked it done)',
    });
    expect(effectiveOutcome(db, id)).toEqual({ source: 'explicit', reward: 1, weight: 1 });
    expect(personState(db, sam.id).consecutiveIgnores).toBe(0);
    // replaying the same command changes nothing
    const again = await applySuggestionFeedback(db, id, { action: 'done' }, { channel: 'imessage', now: T0 + 2 * HOUR, inboundCommandId: 'cmd-1' });
    expect(again).toEqual(res);
    expect(db.prepare(`SELECT count(*) FROM feedback WHERE suggestion_id = ? AND action = 'done'`).pluck().get(id)).toBe(1);
    // the journal change is undoable from Today
    undoBatch(db, res.batchId!, { actor: 'user', now: T0 + 3 * HOUR });
    expect(db.prepare('SELECT status FROM reply_debts WHERE id = ?').pluck().get(debt.id)).toBe('open');
  });

  it('skip: reward 0 at 1.5, that (person, kind) rests 4× its cooldown; the 3rd fading skip mutes fading 90 days', async () => {
    const { db, fading } = world();
    const { byKind } = await rank(db);
    const id = byKind('fading');
    await applySuggestionFeedback(db, id, { action: 'skip' }, web());
    expect(suggestionRow(db, id)).toMatchObject({ status: 'dismissed', decided_at: T0 + HOUR });
    expect(effectiveOutcome(db, id)).toEqual({ source: 'explicit', reward: 0, weight: 1.5 });
    expect(db.prepare('SELECT until, reason FROM suggestion_cooldowns WHERE scope = ?').get(`pk:${fading.id}|fading`)).toEqual({
      until: T0 + HOUR + 56 * DAY,
      reason: 'dismissed',
    });
    // two more fading skips for the same person (new rows)
    for (let i = 0; i < 2; i++) {
      const sid = uuidv7();
      db.prepare(
        `INSERT INTO suggestions (id, kind, person_id, person_ids, dedupe_key, subject_key, score, signals, status, created_at, updated_at)
         VALUES (?, 'fading', ?, ?, ?, ?, 0.5, '{}', 'candidate', ?, ?)`,
      ).run(sid, fading.id, JSON.stringify([fading.id]), `fading:x${i}`, `x${i}`, T0, T0);
      await applySuggestionFeedback(db, sid, { action: 'skip' }, web(T0 + (i + 2) * HOUR));
    }
    expect(db.prepare('SELECT until, reason FROM suggestion_cooldowns WHERE scope = ?').get(`pk:${fading.id}|fading`)).toEqual({
      until: T0 + 3 * HOUR + 90 * DAY,
      reason: 'fading_mute',
    });
  });

  it('wrong: reward 0 at 2; a promise is retracted (journaled), cadence items rest 90 days, basis facts are rejected + blocked', async () => {
    const { db, fading, promise } = world();
    const { byKind } = await rank(db);
    const k = await applySuggestionFeedback(db, byKind('commitment_due'), { action: 'wrong', note: 'never said that' }, web());
    expect(k.status).toBe('wrong');
    expect(db.prepare('SELECT status, closed_reason FROM commitments WHERE id = ?').get(promise)).toEqual({ status: 'retracted', closed_reason: 'wrong' });
    expect(effectiveOutcome(db, byKind('commitment_due'))).toEqual({ source: 'explicit', reward: 0, weight: 2 });
    const f = await applySuggestionFeedback(db, byKind('fading'), { action: 'wrong' }, web());
    expect(f.batchId).toBeNull();
    expect(db.prepare('SELECT until FROM suggestion_cooldowns WHERE scope = ?').pluck().get(`pk:${fading.id}|fading`)).toBe(T0 + HOUR + 90 * DAY);

    // a generator that names its basis fact (e.g. travel → a location fact)
    const factId = uuidv7();
    db.prepare(
      `INSERT INTO facts (id, person_id, type, value, value_norm, confidence, status, recorded_at, source, created_at, updated_at)
       VALUES (?, ?, 'location_current', 'Springfield', 'springfield', 0.9, 'confirmed', ?, 'llm', ?, ?)`,
    ).run(factId, fading.id, T0, T0, T0);
    const travel = fixedGenerator('travel_overlap', () => [
      { kind: 'travel_overlap', personIds: [fading.id], subjectKey: 'trip-1', base: 0.9, evidenceIds: [`F${factId}`], expiresAt: null, payload: { basisFactIds: [factId] } },
    ]);
    const db2r = await runSuggestionsStage(db, { now: T0 + DAY, seed: 5, generators: [travel], wildcardSources: [] });
    const t = await applySuggestionFeedback(db, db2r.selectedIds[0]!, { action: 'wrong' }, web(T0 + DAY + HOUR));
    expect(db.prepare('SELECT status FROM facts WHERE id = ?').pluck().get(factId)).toBe('rejected');
    expect(db.prepare('SELECT count(*) FROM fact_blocks WHERE person_id = ? AND value_norm = ?').pluck().get(fading.id, 'springfield')).toBe(1);
    undoBatch(db, t.batchId!, { actor: 'user', now: T0 + 2 * DAY });
    expect(db.prepare('SELECT status FROM facts WHERE id = ?').pluck().get(factId)).toBe('confirmed');
  });

  it('wrong on a follow-up rejects the agent’s inferred attendance (never Partiful’s own rows)', async () => {
    const { db, fading } = world();
    const occ = occasion(db, T0 - DAY, [fading.id]);
    const gen = fixedGenerator('event_followup', () => [
      { kind: 'event_followup', personIds: [fading.id], subjectKey: occ, base: 0.9, evidenceIds: [`occ:${occ}`], expiresAt: null, links: { occasionId: occ }, payload: {} },
    ]);
    const r = await runSuggestionsStage(db, { now: T0, seed: 5, generators: [gen], wildcardSources: [] });
    await applySuggestionFeedback(db, r.selectedIds[0]!, { action: 'wrong' }, web());
    expect(db.prepare('SELECT status FROM event_attendees WHERE occasion_id = ?').pluck().get(occ)).toBe('rejected');
  });

  it('snooze: neutral, hidden until the date (its cooldown moves there); past dates are refused', async () => {
    const { db, fading } = world();
    const { byKind } = await rank(db);
    const id = byKind('fading');
    await expect(applySuggestionFeedback(db, id, { action: 'snooze', until: T0 - 1 }, web())).rejects.toMatchObject({ status: 400 });
    await applySuggestionFeedback(db, id, { action: 'snooze', until: T0 + 7 * DAY }, web());
    expect(suggestionRow(db, id)).toMatchObject({ status: 'snoozed', snoozed_until: T0 + 7 * DAY });
    expect(effectiveOutcome(db, id)).toBeNull();
    expect(db.prepare('SELECT until FROM suggestion_cooldowns WHERE scope = ?').pluck().get(`pk:${fading.id}|fading`)).toBe(T0 + 7 * DAY);
    // still snoozed on day 3; back on day 8 (same row)
    const d3 = await runSuggestionsStage(db, { now: T0 + 3 * DAY, seed: 5, generators: defaultGenerators, wildcardSources: [] });
    expect(d3.selectedIds).not.toContain(id);
    const d8 = await runSuggestionsStage(db, { now: T0 + 8 * DAY, seed: 5, generators: defaultGenerators, wildcardSources: [] });
    expect(d8.selectedIds).toContain(id);
  });

  it('why: summary, cadence signals, learned factors, adjustments and identifier-free evidence', async () => {
    const { db, fading } = world();
    message(db, fading.dm, T0 - 60 * DAY, fading.phoneId, 'call me at 212-555-0142 sometime');
    setSetting(db, 'learner.enabled', true);
    const { byKind } = await rank(db);
    const id = byKind('fading');
    const why = whyThis(db, id);
    expect(why.summary).toBe('Bram O. has been quiet 60 days, about 6× your usual ~10-day gap.');
    expect(why.signals).toEqual(expect.arrayContaining([{ label: 'Quiet for', value: '60 days' }, { label: 'Usually every', value: '~10 days' }]));
    expect(why.factors.map((f) => f.arm)).toEqual(['kind', 'bucket', 'person']);
    expect(why.factors[0]!.label).toBe('Fading overall');
    expect(why.adjustments).toEqual(expect.arrayContaining([{ label: 'Kind weight', value: '×0.8' }]));
    expect(why.evidence).toHaveLength(1);
    expect(why.evidence[0]!.quote).toBe('call me at <phone> sometime');
    expect(why.evidence[0]!.href).toBe(`/p/${fading.id}?m=${why.evidence[0]!.ref.slice(2)}`);
    const res = await applySuggestionFeedback(db, id, { action: 'why' }, web());
    expect(res.why?.suggestionId).toBe(id);
    expect(suggestionRow(db, id).status).toBe('selected');
  });

  it('draft: template openers without a key; Claude openers (effort low, via egress) when available; bad output falls back', async () => {
    const { db } = world();
    const { byKind } = await rank(db);
    const id = byKind('fading');
    const t = await applySuggestionFeedback(db, id, { action: 'draft' }, web());
    expect(t.openers).toEqual(["Hey Bram! It's been too long — how are you doing?", 'Thinking of you, Bram — want to catch up soon?']);

    const llm = new FakeLlmClient().on(`digest:draft:${id}`, { json: { openers: ['Bram! Long time — how is everything?', 'Free for a walk this week?'] } });
    const services = (d: DB) => ({ ...servicesFor(d), llm, egress: new FakeEgress() });
    const out = await applySuggestionFeedback(db, id, { action: 'draft' }, { ...web(), services });
    expect(out.openers).toEqual(['Bram! Long time — how is everything?', 'Free for a walk this week?']);
    expect(llm.calls[0]).toMatchObject({ method: 'parse', kind: 'digest', route: 'draft_openers', effort: 'low', fallbacks: false });
    expect(llm.calls[0]!.userText).toContain('friend 1 first name: Bram');
    expect(llm.calls[0]!.userText).not.toContain('Ostrow');
    expect(JSON.parse(suggestionRow(db, id).openers as string)).toHaveLength(4);

    const bad = new FakeLlmClient().on('digest', { json: { openers: ['visit www.example.com now'] } });
    const fallback = await applySuggestionFeedback(db, id, { action: 'draft' }, { ...web(), services: (d: DB) => ({ ...servicesFor(d), llm: bad, egress: new FakeEgress() }) });
    expect(fallback.openers).toEqual(t.openers);
    expect(validateOpeners({ openers: ['x'.repeat(161)] })).toContain('opener over 160 chars');
  });

  it('open: partial credit 0.3, never above a stronger outcome', async () => {
    const { db } = world();
    const { byKind } = await rank(db);
    const id = byKind('fading');
    await applySuggestionFeedback(db, id, { action: 'open' }, web());
    expect(effectiveOutcome(db, id)).toEqual({ source: 'open', reward: 0.3, weight: 1 });
    await applySuggestionFeedback(db, id, { action: 'done' }, web(T0 + 2 * HOUR));
    await applySuggestionFeedback(db, id, { action: 'open' }, web(T0 + 3 * HOUR));
    expect(effectiveOutcome(db, id)).toMatchObject({ source: 'explicit' });
    const a = readArm(db, 'kind:fading', T0 + 3 * HOUR);
    expect(a.alpha).toBeCloseTo(3, 2);
    expect(a.beta).toBeCloseTo(2, 2);
  });

  it('mute: kind → the learner.muted_kinds setting (journaled); person / person_kind → learner state; circle items have no person', async () => {
    const { db, sam } = world();
    const ppl = ['Dev', 'Eli', 'Fen'].map((n) => friend(db, n, 'Crew'));
    circle(db, 'Trail crew', ppl.map((p) => p.id));
    occasion(db, T0 - 60 * DAY, [ppl[0]!.id, ppl[1]!.id]);
    const { byKind } = await rank(db);
    const k = await applySuggestionFeedback(db, byKind('fading'), { action: 'mute', scope: 'kind' }, web());
    expect(readSetting(db, 'learner.muted_kinds')).toEqual(['fading']);
    expect(db.prepare('SELECT kind FROM change_batches WHERE id = ?').pluck().get(k.batchId)).toBe('setting');
    await applySuggestionFeedback(db, byKind('reply_debt'), { action: 'mute', scope: 'person_kind' }, web());
    expect(personState(db, sam.id)).toMatchObject({ muted: false, mutedKinds: ['reply_debt'] });
    const circleItem = db.prepare(`SELECT id FROM suggestions WHERE kind = 'circle_neglect'`).pluck().get() as string;
    await expect(applySuggestionFeedback(db, circleItem, { action: 'mute', scope: 'person' }, web())).rejects.toMatchObject({ status: 400 });
    await applySuggestionFeedback(db, circleItem, { action: 'mute', scope: 'kind' }, web());
    expect(readSetting(db, 'learner.muted_kinds')).toEqual(['fading', 'circle_neglect']);
  });

  it('404 for unknown suggestions and for items about someone now hidden', async () => {
    const { db, fading } = world();
    const { byKind } = await rank(db);
    await expect(applySuggestionFeedback(db, uuidv7(), { action: 'done' }, web())).rejects.toMatchObject({ status: 404 });
    db.prepare('UPDATE people SET is_hidden = 1 WHERE id = ?').run(fading.id);
    expect(() => whyThis(db, byKind('fading'))).toThrow(/not found/);
  });

  it('undoSuggestionFeedback reverts status, reward, cooldowns and the journal change', async () => {
    const { db, debt, fading } = world();
    const { byKind } = await rank(db);
    const id = byKind('reply_debt');
    await applySuggestionFeedback(db, id, { action: 'done' }, web());
    const fb = db.prepare(`SELECT id FROM feedback WHERE suggestion_id = ? AND action = 'done'`).pluck().get(id) as string;
    const u = undoSuggestionFeedback(db, fb, { now: T0 + 2 * HOUR, channel: 'imessage' });
    expect(u.batchId).not.toBeNull();
    expect(suggestionRow(db, id)).toMatchObject({ status: 'selected', acted_at: null, decided_at: null });
    expect(effectiveOutcome(db, id)).toBeNull();
    expect(readArm(db, 'kind:reply_debt', T0 + 2 * HOUR).n).toBeCloseTo(0, 6);
    expect(db.prepare('SELECT status FROM reply_debts WHERE id = ?').pluck().get(debt.id)).toBe('open');
    expect(() => undoSuggestionFeedback(db, fb, { now: T0 + 3 * HOUR, channel: 'imessage' })).toThrow(/already undone/);

    const f = byKind('fading');
    const before = db.prepare('SELECT until, reason FROM suggestion_cooldowns WHERE scope = ?').get(`pk:${fading.id}|fading`);
    await applySuggestionFeedback(db, f, { action: 'skip' }, web());
    const sk = db.prepare(`SELECT id FROM feedback WHERE suggestion_id = ? AND action = 'skip'`).pluck().get(f) as string;
    undoSuggestionFeedback(db, sk, { now: T0 + 2 * HOUR, channel: 'web' });
    expect(db.prepare('SELECT until, reason FROM suggestion_cooldowns WHERE scope = ?').get(`pk:${fading.id}|fading`)).toEqual(before);
  });
});
