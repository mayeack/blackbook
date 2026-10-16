/**
 * PLAN Phase 2 learner checks, simulated end to end through the real stage + rewards jobs:
 *   - "always acts on reply_debt, ignores fading" → reply_debt propensity rises and fading falls within 2 weeks;
 *   - the 🎲 wildcard rate stays ≈ 0.2 and never lands on two consecutive days.
 */
import { describe, expect, it } from 'vitest';
import { readArm } from '../../../src/pipeline/suggestions/learner';
import { attributeRewards, recordImpressions } from '../../../src/pipeline/suggestions/rewards';
import { runSuggestionsStage } from '../../../src/pipeline/suggestions/stage';
import type { Candidate, WildcardSource } from '../../../src/pipeline/suggestions/types';
import { DAY, fixedGenerator, friend, HOUR, message, setSetting, suggestionRow, suggestionsDb, T0, type Friend } from './world';

const NAMES = ['Avery', 'Bram', 'Cleo', 'Dev', 'Eli', 'Fen', 'Gus', 'Hana', 'Ivo', 'Juno', 'Kai', 'Lior'];

describe('self-learning simulation', () => {
  it('acting on reply debts and ignoring fading moves the propensities within two weeks', async () => {
    const db = suggestionsDb();
    setSetting(db, 'learner.wildcard_epsilon', 0);
    const debtors: Friend[] = NAMES.slice(0, 6).map((n) => friend(db, n, 'Debtor'));
    const faders: Friend[] = NAMES.slice(6).map((n) => friend(db, n, 'Fader'));
    let day = 0;
    const gens = [
      fixedGenerator('reply_debt', () =>
        debtors.map((f): Candidate => ({ kind: 'reply_debt', personIds: [f.id], subjectKey: `${f.id}-${day}`, base: 0.6, evidenceIds: [], expiresAt: null, payload: {} })),
      ),
      fixedGenerator('fading', () =>
        faders.map((f): Candidate => ({ kind: 'fading', personIds: [f.id], subjectKey: f.id, base: 0.6 / 0.8, evidenceIds: [], expiresAt: null, payload: {} })),
      ),
    ];
    const shown: { day: number; kind: string }[] = [];
    for (day = 0; day < 14; day++) {
      const now = T0 + day * DAY;
      const r = await runSuggestionsStage(db, { now, seed: 1000 + day, generators: gens, wildcardSources: [] });
      // he opens Today every morning (the impression that starts each reward window)
      recordImpressions(db, r.selectedIds, { now: now + 30 * 60_000, channel: 'web' });
      for (const id of r.selectedIds) {
        const row = suggestionRow(db, id);
        shown.push({ day, kind: row.kind as string });
        if (row.kind === 'reply_debt') {
          const f = debtors.find((d) => d.id === row.person_id)!;
          message(db, f.dm, now + 2 * HOUR, null, 'on it');
        }
      }
      await attributeRewards(db, { now: now + 20 * HOUR });
    }
    const end = T0 + 14 * DAY;
    const debt = readArm(db, 'kind:reply_debt', end);
    const fading = readArm(db, 'kind:fading', end);
    expect(debt.mean).toBeGreaterThan(0.6);
    expect(fading.mean).toBeLessThan(0.45);
    expect(debt.mean).toBeGreaterThan(fading.mean);
    // and the digests lean towards what he acts on
    const share = (from: number, to: number) => {
      const xs = shown.filter((s) => s.day >= from && s.day < to);
      return xs.filter((s) => s.kind === 'reply_debt').length / Math.max(1, xs.length);
    };
    expect(share(7, 14)).toBeGreaterThanOrEqual(share(0, 7));
    // ignored people rest (exponential cooldown)
    expect(db.prepare('SELECT count(*) FROM learner_person_state WHERE consecutive_ignores > 0').pluck().get()).toBeGreaterThan(0);
  });

  it('the wildcard rate stays ≈ ε = 0.2, never on consecutive days, with the seed stored per digest', async () => {
    const db = suggestionsDb();
    const people = NAMES.map((n) => friend(db, n, 'Wild'));
    let day = 0;
    // a fresh circle-level candidate every day, so cooldowns never empty the pool
    const src: WildcardSource = {
      generator: 'circle_checkin',
      generate: () => [{ kind: 'circle_neglect', personIds: [], subjectKey: `c-${day}`, base: 0.4, evidenceIds: [], expiresAt: null, payload: { checkin: true } }],
    };
    const regular = fixedGenerator('reply_debt', () => [
      { kind: 'reply_debt', personIds: [people[(day + 5) % people.length]!.id], subjectKey: `d-${day}`, base: 0.8, evidenceIds: [], expiresAt: null, payload: {} },
    ]);
    const hits: boolean[] = [];
    for (day = 0; day < 200; day++) {
      const r = await runSuggestionsStage(db, { now: T0 + day * DAY, seed: 7919 * (day + 1), generators: [regular], wildcardSources: [src] });
      hits.push(r.wildcardId !== null);
    }
    for (let i = 1; i < hits.length; i++) expect(hits[i] && hits[i - 1]).toBe(false);
    const rate = hits.filter(Boolean).length / hits.length;
    expect(rate).toBeGreaterThan(0.12);
    expect(rate).toBeLessThan(0.28);
    const seeds = db.prepare('SELECT d.rng_seed, r.seed FROM digests d JOIN digest_rankings r ON r.digest_id = d.id').all() as { rng_seed: number; seed: number }[];
    expect(seeds).toHaveLength(200);
    expect(seeds.every((s) => s.rng_seed === s.seed && s.seed > 0)).toBe(true);
  });
});
