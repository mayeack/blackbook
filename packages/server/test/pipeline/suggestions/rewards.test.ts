import { describe, expect, it } from 'vitest';
import { generators as defaultGenerators } from '../../../src/pipeline/suggestions/generators';
import { effectiveOutcome, personState, readArm } from '../../../src/pipeline/suggestions/learner';
import { applySuggestionFeedback } from '../../../src/pipeline/suggestions/feedback';
import { attributeRewards, firstAction, recordImpressions, shownAt, wasActive } from '../../../src/pipeline/suggestions/rewards';
import { runSuggestionsStage } from '../../../src/pipeline/suggestions/stage';
import type { DB } from '../../../src/db/connection';
import { DAY, fadingFriend, friend, HOUR, interaction, message, replyDebt, setSetting, stats, suggestionRow, suggestionsDb, T0 } from './world';

/** Ranks at T0 and (unless `seen` is false) the owner opens Today right away: that impression starts the windows. */
async function shown(db: DB, seen = true) {
  const r = await runSuggestionsStage(db, { now: T0, seed: 3, generators: defaultGenerators, wildcardSources: [] });
  if (seen) recordImpressions(db, r.selectedIds, { now: T0, channel: 'web' });
  const byKind = (k: string) => r.selectedIds.find((id) => suggestionRow(db, id).kind === k)!;
  return { r, byKind };
}

function world() {
  const db = suggestionsDb();
  setSetting(db, 'learner.enabled', false);
  const sam = friend(db, 'Avery', 'Quill');
  stats(db, sam.id, { tie: 60 });
  replyDebt(db, sam, T0 - 30 * HOUR);
  const fading = fadingFriend(db, 'Bram', 'Ostrow');
  return { db, sam, fading };
}

describe('implicit rewards', () => {
  it('an outbound message within the window = acted (reward 1), the person’s ignore streak resets', async () => {
    const { db, sam } = world();
    const { byKind } = await shown(db);
    const id = byKind('reply_debt');
    message(db, sam.dm, T0 + 5 * HOUR, null, 'sorry, yes saturday works');
    const out = await attributeRewards(db, { now: T0 + 6 * HOUR });
    expect(out.stats).toMatchObject({ acted: 1, counterfactual: 0 });
    expect(suggestionRow(db, id)).toMatchObject({ status: 'done', acted_at: T0 + 5 * HOUR, decided_at: T0 + 6 * HOUR });
    expect(effectiveOutcome(db, id)).toEqual({ source: 'implicit', reward: 1, weight: 1 });
    expect(readArm(db, 'kind:reply_debt', T0 + 6 * HOUR)).toMatchObject({ alpha: 3, beta: 2 });
    expect(db.prepare(`SELECT channel FROM feedback WHERE suggestion_id = ? AND action = 'acted'`).pluck().get(id)).toBe('system');
    // decided rows aren't looked at again (only the still-open fading item is)
    expect((await attributeRewards(db, { now: T0 + 7 * HOUR })).stats).toMatchObject({ checked: 1, acted: 0 });
  });

  it('counterfactual guard: already messaging them in the 24 h before delivery → done, but no credit', async () => {
    const { db, sam } = world();
    message(db, sam.dm, T0 - 2 * HOUR, null, 'running late');
    const { byKind } = await shown(db);
    const id = byKind('reply_debt');
    message(db, sam.dm, T0 + 2 * HOUR, null, 'here now');
    expect(wasActive(db, [sam.id], T0 - DAY, T0)).toBe(true);
    const out = await attributeRewards(db, { now: T0 + 3 * HOUR });
    expect(out.stats).toMatchObject({ acted: 0, counterfactual: 1 });
    expect(suggestionRow(db, id).status).toBe('done');
    expect(effectiveOutcome(db, id)).toBeNull();
    expect(JSON.parse(suggestionRow(db, id).rank_details as string)).toMatchObject({ credit: 'counterfactual' });
  });

  it('logs, calls and occasions count; inbound messages, bot rows and messages before delivery don’t', () => {
    const { db, sam } = world();
    message(db, sam.dm, T0 + HOUR, sam.phoneId, 'ping');
    db.prepare(`UPDATE messages SET is_bot = 1 WHERE id = ?`).run(message(db, sam.dm, T0 + 2 * HOUR, null, 'bot row'));
    message(db, sam.dm, T0 - HOUR, null, 'before');
    expect(firstAction(db, [sam.id], T0, T0 + DAY)).toBeNull();
    interaction(db, sam.id, 'call', T0 + 3 * HOUR);
    expect(firstAction(db, [sam.id], T0, T0 + DAY)).toEqual({ at: T0 + 3 * HOUR, via: 'interaction' });
  });

  it('window end with nothing: ignored (0, w 0.5) and an ignore cooldown; an opened item keeps its 0.3', async () => {
    const { db, sam, fading } = world();
    const { byKind } = await shown(db);
    const fadingId = byKind('fading');
    const debtId = byKind('reply_debt');
    await applySuggestionFeedback(db, debtId, { action: 'open' }, { channel: 'web', now: T0 + HOUR });
    // reply debt window 72 h, fading 7 d
    let out = await attributeRewards(db, { now: T0 + 4 * DAY });
    expect(out.stats).toMatchObject({ ignored: 0, open: 1 });
    expect(suggestionRow(db, debtId).status).toBe('ignored');
    expect(effectiveOutcome(db, debtId)).toMatchObject({ source: 'open', reward: 0.3 });
    expect(personState(db, sam.id).consecutiveIgnores).toBe(0);
    expect(suggestionRow(db, fadingId).status).toBe('selected');
    out = await attributeRewards(db, { now: T0 + 8 * DAY });
    expect(out.stats.ignored).toBe(1);
    expect(suggestionRow(db, fadingId)).toMatchObject({ status: 'ignored', decided_at: T0 + 8 * DAY });
    expect(effectiveOutcome(db, fadingId)).toEqual({ source: 'ignored', reward: 0, weight: 0.5 });
    expect(personState(db, fading.id)).toMatchObject({ consecutiveIgnores: 1, cooldownUntil: T0 + 22 * DAY });
    const arm = readArm(db, 'kind:fading', T0 + 8 * DAY);
    expect(arm.beta).toBeCloseTo(2.5, 6);
  });

  it('explicit feedback decides the row; snoozed items are left for later', async () => {
    const { db } = world();
    const { byKind } = await shown(db);
    await applySuggestionFeedback(db, byKind('fading'), { action: 'snooze', until: T0 + 14 * DAY }, { channel: 'web', now: T0 + HOUR });
    await applySuggestionFeedback(db, byKind('reply_debt'), { action: 'done' }, { channel: 'web', now: T0 + HOUR });
    const out = await attributeRewards(db, { now: T0 + 9 * DAY });
    expect(out.stats).toMatchObject({ checked: 0 });
    expect(suggestionRow(db, byKind('fading')).status).toBe('snoozed');
  });

  it('the window starts at this showing: a send time from an earlier showing is ignored; no impression = not shown', () => {
    expect(shownAt({ delivered_at: T0 + HOUR, digest_sent_at: null, selected_at: T0 })).toBe(T0 + HOUR);
    expect(shownAt({ delivered_at: T0 - 2 * DAY, digest_sent_at: null, selected_at: T0 })).toBeNull();
    expect(shownAt({ delivered_at: null, digest_sent_at: T0 + 2 * HOUR, selected_at: T0 })).toBe(T0 + 2 * HOUR);
    expect(shownAt({ delivered_at: null, digest_sent_at: null, digest_push_sent_at: T0 + 3 * HOUR, selected_at: T0 })).toBe(T0 + 3 * HOUR);
    expect(shownAt({ delivered_at: null, digest_sent_at: null, web_seen_at: T0 + 5 * HOUR, selected_at: T0 })).toBe(T0 + 5 * HOUR);
    expect(shownAt({ delivered_at: null, digest_sent_at: null, selected_at: T0 })).toBeNull();
  });

  it('items nobody saw teach nothing: no ignored outcome, no ignore streak; they go back to the pool', async () => {
    const { db, sam, fading } = world();
    const { byKind } = await shown(db, false);
    const fadingId = byKind('fading');
    const debtId = byKind('reply_debt');
    let out = await attributeRewards(db, { now: T0 + 4 * DAY });
    expect(out.stats).toMatchObject({ ignored: 0, unseen: 1 });
    expect(suggestionRow(db, debtId)).toMatchObject({ status: 'candidate', decided_at: T0 + 4 * DAY });
    expect(effectiveOutcome(db, debtId)).toBeNull();
    expect(personState(db, sam.id).consecutiveIgnores).toBe(0);
    out = await attributeRewards(db, { now: T0 + 8 * DAY });
    expect(out.stats).toMatchObject({ ignored: 0, unseen: 1 });
    expect(personState(db, fading.id)).toMatchObject({ consecutiveIgnores: 0, cooldownUntil: null });
    expect(readArm(db, 'kind:fading', T0 + 8 * DAY)).toMatchObject({ alpha: 2, beta: 2 });
    expect(suggestionRow(db, fadingId).status).toBe('candidate');
    // a repeat view of the same showing records one impression only
    expect(recordImpressions(db, [fadingId], { now: T0, channel: 'web' })).toBe(0);
  });
});
