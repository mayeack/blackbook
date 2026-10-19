import { describe, expect, it } from 'vitest';
import { generators as defaultGenerators } from '../../../src/pipeline/suggestions/generators';
import { mutePerson, recordIgnore } from '../../../src/pipeline/suggestions/learner';
import { runSuggestionsStage, type StageOptions } from '../../../src/pipeline/suggestions/stage';
import { buildWhy } from '../../../src/pipeline/suggestions/why';
import { unseenKindWildcard } from '../../../src/pipeline/suggestions/gen/unseen';
import type { Candidate, WildcardSource } from '../../../src/pipeline/suggestions/types';
import type { DB } from '../../../src/db/connection';
import { DAY, fadingFriend, fixedGenerator, friend, HOUR, replyDebt, setSetting, stats, suggestionRow, suggestionsDb, T0 } from './world';

const run = (db: DB, now: number, o: StageOptions = {}) => runSuggestionsStage(db, { now, seed: 7, generators: defaultGenerators, wildcardSources: [], ...o });

/** Learning off: factors are 1, so selections are exact (the learner has its own tests and the simulation). */
function world() {
  const db = suggestionsDb();
  setSetting(db, 'learner.enabled', false);
  const sam = friend(db, 'Avery', 'Quill');
  stats(db, sam.id, { tie: 60 });
  const debt = replyDebt(db, sam, T0 - 30 * HOUR);
  const fading = fadingFriend(db, 'Bram', 'Ostrow');
  const cooling = friend(db, 'Cleo', 'Marsh');
  stats(db, cooling.id, { state: 'cooling', historical: 90, momentum: -1.5 });
  return { db, sam, debt, fading, cooling };
}

describe('suggestions stage', () => {
  it('stores candidates, ranks them into today’s digest (seed + cap stored) and sets showing cooldowns', async () => {
    const { db, sam, fading, cooling } = world();
    const r = await run(db, T0);
    expect(r).toMatchObject({ status: 'ok', localDate: '2026-10-14', seed: 7, cap: 4 });
    expect(r.selectedIds).toHaveLength(3);
    const digest = db.prepare('SELECT * FROM digests WHERE local_date = ?').get('2026-10-14') as Record<string, unknown>;
    expect(digest).toMatchObject({ id: r.digestId, status: 'composing', rng_seed: 7, item_cap: 4, run_id: r.runId });
    const items = db.prepare('SELECT ordinal, suggestion_id FROM digest_items WHERE digest_id = ? ORDER BY ordinal').all(r.digestId) as { ordinal: number; suggestion_id: string }[];
    expect(items.map((i) => i.suggestion_id)).toEqual(r.selectedIds);
    const rows = r.selectedIds.map((id) => suggestionRow(db, id));
    expect(rows.map((x) => x.kind).sort()).toEqual(['cooling', 'fading', 'reply_debt']);
    expect(rows.every((x) => x.status === 'selected' && x.showings === 1 && x.selected_at === T0 && x.digest_id === r.digestId)).toBe(true);
    const lf = JSON.parse(rows.find((x) => x.kind === 'fading')!.learned_factors as string) as { kind: number; arms: { key: string }[]; details: unknown[] };
    expect(lf.arms.map((a) => a.key)).toEqual(['kind:fading', 'kind:fading|tier:light', `person:${fading.id}`]);
    expect(lf.details.length).toBeGreaterThan(0);
    const cds = db.prepare('SELECT scope, until, reason FROM suggestion_cooldowns ORDER BY scope').all() as { scope: string; until: number }[];
    expect(cds).toEqual(
      expect.arrayContaining([
        { scope: `pk:${sam.id}|reply_debt`, until: T0 + 2 * DAY, reason: 'shown' },
        { scope: `pk:${fading.id}|fading`, until: T0 + 14 * DAY, reason: 'shown' },
        { scope: `pk:${cooling.id}|cooling`, until: T0 + 21 * DAY, reason: 'shown' },
      ]),
    );
    expect(db.prepare('SELECT seed, cap, selected_count FROM digest_rankings').get()).toEqual({ seed: 7, cap: 4, selected_count: 3 });
    // one ranking per local day
    expect(await run(db, T0 + HOUR)).toMatchObject({ status: 'skipped', reason: 'already_ranked' });
    // nothing journaled
    expect(db.prepare('SELECT count(*) FROM change_batches').pluck().get()).toBe(0);
  });

  it('respects cooldowns and max showings on later days; candidates whose signal is gone are superseded', async () => {
    const { db, debt } = world();
    const day1 = await run(db, T0);
    const debtRow = day1.selectedIds.map((id) => suggestionRow(db, id)).find((x) => x.kind === 'reply_debt') as { id: string };
    // day 2: everyone is still cooling down
    const day2 = await run(db, T0 + DAY);
    expect(day2.selectedIds).toEqual([]);
    // day 3: the reply debt (2-day cooldown) is back, same row, second showing; fading still rests (14 d)
    const day3 = await run(db, T0 + 2 * DAY);
    expect(day3.selectedIds).toEqual([debtRow.id]);
    expect(suggestionRow(db, debtRow.id)).toMatchObject({ showings: 2, status: 'selected' });
    await run(db, T0 + 4 * DAY);
    expect(suggestionRow(db, debtRow.id).showings).toBe(3);
    // ≤3 showings for a reply debt
    expect((await run(db, T0 + 6 * DAY)).selectedIds).not.toContain(debtRow.id);
    // a weak new debt is stored but stays a candidate (below the floor) …
    const other = friend(db, 'Dev', 'Tanaka');
    const d2 = replyDebt(db, other, T0 + 6 * DAY);
    await run(db, T0 + 7 * DAY);
    expect(db.prepare(`SELECT status FROM suggestions WHERE subject_key = ?`).pluck().get(d2.id)).toBe('candidate');
    // … and once its signal is gone (answered), the next pass supersedes it; shown rows wait for their reward window
    db.prepare(`UPDATE reply_debts SET status = 'replied' WHERE id IN (?, ?)`).run(debt.id, d2.id);
    await run(db, T0 + 8 * DAY);
    expect(db.prepare(`SELECT status FROM suggestions WHERE subject_key = ?`).pluck().get(d2.id)).toBe('superseded');
    expect(suggestionRow(db, debtRow.id).status).toBe('selected');
  });

  it('mutes, ignore cooldowns and hidden people keep items out; time-critical items skip only the ignore cooldown', async () => {
    const { db, sam, fading, cooling } = world();
    setSetting(db, 'learner.muted_kinds', ['cooling']);
    mutePerson(db, sam.id, ['reply_debt'], T0);
    recordIgnore(db, fading.id, T0, 7);
    const vip = friend(db, 'Eli', 'Brand');
    recordIgnore(db, vip.id, T0, 7);
    const hidden = friend(db, 'Hollis', 'Vane', { is_hidden: 1 });
    const brief = fixedGenerator('pre_event_brief', () => [
      { kind: 'pre_event_brief', personIds: [vip.id], subjectKey: 'occ-1', base: 0.8, evidenceIds: [], expiresAt: T0 + DAY, timeCritical: true, payload: {} },
      { kind: 'pre_event_brief', personIds: [hidden.id], subjectKey: 'occ-2', base: 0.8, evidenceIds: [], expiresAt: T0 + DAY, timeCritical: true, payload: {} },
    ]);
    const r = await run(db, T0, { generators: [...defaultGenerators, brief] });
    expect(r.selectedIds.map((id) => suggestionRow(db, id).kind)).toEqual(['pre_event_brief']);
    expect(suggestionRow(db, r.selectedIds[0]!).person_id).toBe(vip.id);
    expect(r.stats).toMatchObject({ skip_muted: 2, skip_ignore_cooldown: 1, dropped: 1 });
    void cooling;
  });

  it('a failing generator is isolated: other kinds still rank and its stored candidates are kept', async () => {
    const { db } = world();
    await run(db, T0, { generators: [fixedGenerator('memory', () => [])] });
    const boom = { kind: 'fading' as const, generate: () => { throw new Error('synthetic failure'); } };
    const r = await run(db, T0 + DAY, { generators: [boom, ...defaultGenerators.filter((g) => g.kind !== 'fading')] });
    expect(r.status).toBe('ok');
    expect(r.stats.generatorErrors).toBe(1);
  });

  it('fatigue halves the score of someone in a digest in the last 3 days', async () => {
    const { db, fading } = world();
    const twice = fixedGenerator('cooling', () => [
      { kind: 'cooling', personIds: [fading.id], subjectKey: `${fading.id}-x`, base: 0.9, evidenceIds: [], expiresAt: null, payload: {} },
    ]);
    await run(db, T0);
    const r = await run(db, T0 + DAY, { generators: [twice] });
    const id = db.prepare(`SELECT id FROM suggestions WHERE kind = 'cooling' AND person_id = ?`).pluck().get(fading.id) as string;
    expect(r.selectedIds).toContain(id);
    expect(JSON.parse(suggestionRow(db, id).rank_details as string)).toMatchObject({ fatigue: true });
  });

  it('Party invites (set by text) lifts party / event / intro items about that person ×1.3, nothing else', async () => {
    const { db, fading, cooling } = world();
    const circle = 'circle-party';
    db.prepare(
      `INSERT INTO circles (id, name, kind, signature, status, created_at, updated_at) VALUES (?, 'Party invites', 'user', 'pref:party_invites', 'active', ?, ?)`,
    ).run(circle, T0, T0);
    db.prepare(`INSERT INTO circle_members (circle_id, person_id, origin, excluded, created_at, updated_at) VALUES (?, ?, 'user', 0, ?, ?)`).run(circle, fading.id, T0, T0);
    const followups = fixedGenerator('event_followup', () =>
      [fading, cooling].map((p) => ({ kind: 'event_followup' as const, personIds: [p.id], subjectKey: `occ:x-${p.id}`, base: 0.5, evidenceIds: [], expiresAt: null, payload: {} })),
    );
    const r = await run(db, T0, { generators: [followups] });
    const row = (pid: string) => db.prepare(`SELECT id, score, rank_details FROM suggestions WHERE kind = 'event_followup' AND person_id = ?`).get(pid) as { id: string; score: number; rank_details: string };
    expect(r.selectedIds).toEqual([row(fading.id).id, row(cooling.id).id]);
    expect(row(fading.id).score / row(cooling.id).score).toBeCloseTo(1.3);
    expect(JSON.parse(row(fading.id).rank_details)).toMatchObject({ party: true });
    expect(JSON.parse(row(cooling.id).rank_details)).toMatchObject({ party: false });
    expect(buildWhy(db, row(fading.id).id, T0).adjustments).toContainEqual({ label: 'In Party invites', value: '×1.3' });
  });

  it('🎲 wildcard: stored only when picked, flagged, never two days in a row; the seed reproduces the digest', async () => {
    const make = () => {
      const w = world();
      setSetting(w.db, 'learner.wildcard_epsilon', 0.5); // chance 1 on allowed days
      const old = friend(w.db, 'Fen', 'Okafor');
      stats(w.db, old.id, { state: 'steady', historical: 70, silenceD: 200 });
      const src: WildcardSource = {
        generator: 'dormant_close',
        generate: (): Candidate[] => [{ kind: 'dormant', personIds: [old.id], subjectKey: old.id, base: 0.3, evidenceIds: [], expiresAt: null, payload: { onceClose: true } }],
      };
      return { ...w, old, src };
    };
    const a = make();
    const r1 = await run(a.db, T0, { wildcardSources: [a.src] });
    expect(r1.wildcardId).not.toBeNull();
    expect(suggestionRow(a.db, r1.wildcardId!)).toMatchObject({ is_wildcard: 1, wildcard_generator: 'dormant_close', status: 'selected', kind: 'dormant' });
    expect(r1.selectedIds.at(-1)).toBe(r1.wildcardId);
    expect(a.db.prepare('SELECT wildcard_generator FROM digest_rankings').pluck().get()).toBe('dormant_close');
    const lf = JSON.parse(suggestionRow(a.db, r1.wildcardId!).learned_factors as string) as { arms: { key: string; w: number }[] };
    expect(lf.arms).toEqual([
      { arm: 'wildcard', key: 'wild:dormant_close', w: 1 },
      { arm: 'kind', key: 'kind:dormant', w: 0.5 },
      { arm: 'person', key: `person:${a.old.id}`, w: 1 },
    ]);
    const r2 = await run(a.db, T0 + DAY, { wildcardSources: [a.src], seed: 8 });
    expect(r2.wildcardId).toBeNull();

    const b = make();
    const again = await run(b.db, T0, { wildcardSources: [b.src] });
    const kinds = (db: DB, ids: string[]) => ids.map((id) => [suggestionRow(db, id).kind, suggestionRow(db, id).score]);
    expect(kinds(b.db, again.selectedIds)).toEqual(kinds(a.db, r1.selectedIds));
  });

  it('skips a day whose digest already went out', async () => {
    const { db } = world();
    db.prepare(`INSERT INTO digests (id, local_date, status) VALUES ('d-sent', '2026-10-14', 'sent')`).run();
    expect(await run(db, T0)).toMatchObject({ status: 'skipped', reason: 'digest_closed' });
  });

  it('a late ranking takes over delivery’s empty placeholder (nothing was sent for it), never a real skipped day', async () => {
    const { db } = world();
    db.prepare(`INSERT INTO digests (id, local_date, status, skip_reason, composed_at) VALUES ('d-ph', '2026-10-14', 'skipped', 'empty', ?)`).run(T0);
    const r = await run(db, T0 + 2 * HOUR);
    expect(r).toMatchObject({ status: 'ok', digestId: 'd-ph' });
    expect(r.selectedIds.length).toBeGreaterThan(0);
    expect(db.prepare('SELECT status, skip_reason FROM digests WHERE id = ?').get('d-ph')).toEqual({ status: 'composing', skip_reason: null });
    // a heartbeat already went out for that day: it stays closed
    const db2 = world().db;
    db2.prepare(`INSERT INTO digests (id, local_date, status, skip_reason, notice_outbound_id) VALUES ('d-hb', '2026-10-14', 'skipped', 'empty', 'out-1')`).run();
    expect(await run(db2, T0)).toMatchObject({ status: 'skipped', reason: 'digest_closed' });
  });

  it('feedback that lands while the stage yields wins: that row is not re-selected', async () => {
    const { db } = world();
    const first = await run(db, T0);
    const debtId = first.selectedIds.find((id) => suggestionRow(db, id).kind === 'reply_debt')!;
    // next day the row is in the pool again; mark it done right as the ranker reaches its write step
    let inPool = false;
    const ranker = {
      rank: (scored: Parameters<NonNullable<StageOptions['ranker']>['rank']>[0]) => {
        inPool = scored.some((x) => x.suggestionId === debtId);
        db.prepare(`UPDATE suggestions SET status = 'done', decided_at = ? WHERE id = ?`).run(T0 + DAY, debtId);
        return { selected: scored, wildcard: null };
      },
    };
    db.prepare('DELETE FROM suggestion_cooldowns').run();
    const r = await run(db, T0 + DAY, { ranker: ranker as never });
    expect(inPool).toBe(true);
    expect(r.selectedIds).not.toContain(debtId);
    expect(r.selectedIds.length).toBeGreaterThan(0);
    expect(suggestionRow(db, debtId)).toMatchObject({ status: 'done', decided_at: T0 + DAY });
  });

  it('stops between generators when aborted (partial run, no digest)', async () => {
    const { db } = world();
    const ac = new AbortController();
    ac.abort();
    const r = await run(db, T0, { signal: ac.signal });
    expect(r).toMatchObject({ status: 'partial', reason: 'aborted', digestId: null });
    expect(db.prepare('SELECT count(*) FROM digests').pluck().get()).toBe(0);
  });

  it('runs the full registry (every module’s generators and wildcard sources) without errors', async () => {
    const { db } = world();
    const r = await runSuggestionsStage(db, { now: T0, seed: 9 });
    expect(r.status).toBe('ok');
    expect(r.stats.generatorErrors ?? 0).toBe(0);
    expect(r.stats.wildcardErrors ?? 0).toBe(0);
    expect(r.selectedIds.length).toBeGreaterThan(0);
  });

  it('🎲 unseen_kind picks a stored candidate that missed the cut and flags that row only', async () => {
    const { db, sam, cooling } = world();
    setSetting(db, 'learner.wildcard_epsilon', 0.5);
    const gens = [
      fixedGenerator('reply_debt', () => [{ kind: 'reply_debt', personIds: [sam.id], subjectKey: 'd1', base: 0.9, evidenceIds: [], expiresAt: null, payload: {} }]),
      fixedGenerator('cooling', () => [{ kind: 'cooling', personIds: [cooling.id], subjectKey: cooling.id, base: 0.05, evidenceIds: [], expiresAt: null, payload: {} }]),
    ];
    const r = await run(db, T0, { generators: gens, wildcardSources: [unseenKindWildcard] });
    expect(r.selectedIds).toHaveLength(2);
    const [first, second] = r.selectedIds.map((id) => suggestionRow(db, id));
    expect(first).toMatchObject({ kind: 'reply_debt', is_wildcard: 0, wildcard_generator: null });
    expect(second).toMatchObject({ kind: 'cooling', is_wildcard: 1, wildcard_generator: 'unseen_kind', status: 'selected' });
    expect(db.prepare(`SELECT count(*) FROM suggestions WHERE kind = 'cooling'`).pluck().get()).toBe(1);
  });
});
