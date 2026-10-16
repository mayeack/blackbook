import { describe, expect, it } from 'vitest';
import {
  adaptiveCap,
  ArmSampler,
  armsFor,
  clampFactor,
  decay,
  effectiveOutcome,
  personState,
  readArm,
  recordIgnore,
  recordOutcome,
  removeOutcome,
  resetIgnores,
  resetLearner,
  sampleFactors,
  snapshotArms,
  propensityAsOf,
} from '../../../src/pipeline/suggestions/learner';
import { beta, gamma, mulberry32, pick, stream } from '../../../src/pipeline/suggestions/rng';
import { armKey } from '../../../src/pipeline/suggestions/types';
import { DAY, suggestionsDb, T0 } from './world';

const SID = '019a0000-0000-7000-8000-0000000000a1';
const SID2 = '019a0000-0000-7000-8000-0000000000a2';

function seedSuggestion(db: ReturnType<typeof suggestionsDb>, id: string, kind = 'fading') {
  db.prepare(
    `INSERT INTO suggestions (id, kind, dedupe_key, score, signals, status, created_at, updated_at) VALUES (?, ?, ?, 0.5, '{}', 'selected', ?, ?)`,
  ).run(id, kind, `${kind}:${id}`, T0, T0);
}

describe('seeded randomness', () => {
  it('is reproducible per seed and independent per stream', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const xs = Array.from({ length: 5 }, () => a());
    expect(Array.from({ length: 5 }, () => b())).toEqual(xs);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(stream(42, 0)()).not.toBe(stream(42, 1)());
    expect(pick(mulberry32(1), [])).toBeUndefined();
  });

  it('Beta samples have the right mean; gamma handles shape < 1', () => {
    const rng = mulberry32(7);
    const n = 4000;
    let s = 0;
    for (let i = 0; i < n; i++) s += beta(rng, 8, 2);
    expect(s / n).toBeGreaterThan(0.77);
    expect(s / n).toBeLessThan(0.83);
    expect(gamma(rng, 0.3)).toBeGreaterThanOrEqual(0);
    expect(() => gamma(rng, 0)).toThrow();
  });
});

describe('arms', () => {
  it('start at the Beta(2,2) prior and forget with a 60-day half-life', () => {
    const db = suggestionsDb();
    seedSuggestion(db, SID);
    expect(readArm(db, armKey.kind('fading'), T0)).toMatchObject({ alpha: 2, beta: 2, n: 0, mean: 0.5 });
    recordOutcome(db, { suggestionId: SID, reward: 1, weight: 4, source: 'explicit', arms: [{ arm: 'kind', key: armKey.kind('fading'), w: 1 }], now: T0 });
    expect(readArm(db, armKey.kind('fading'), T0)).toMatchObject({ alpha: 6, beta: 2, n: 4 });
    const later = readArm(db, armKey.kind('fading'), T0 + 60 * DAY);
    expect(later.alpha).toBeCloseTo(4, 6);
    expect(later.n).toBeCloseTo(2, 6);
    expect(decay(120 * DAY)).toBeCloseTo(0.25);
  });

  it('keeps one effective outcome per suggestion: a stronger one reverses a weaker one exactly', () => {
    const db = suggestionsDb();
    seedSuggestion(db, SID);
    const arms = [{ arm: 'kind' as const, key: armKey.kind('fading'), w: 1 }];
    recordOutcome(db, { suggestionId: SID, reward: 0.3, weight: 1, source: 'open', arms, now: T0 });
    expect(readArm(db, arms[0]!.key, T0)).toMatchObject({ alpha: 2.3, beta: 2.7 });
    // done (explicit) replaces the open's 0.3, even 10 days later (forgetting is linear)
    recordOutcome(db, { suggestionId: SID, reward: 1, weight: 1, source: 'explicit', arms, now: T0 + 10 * DAY });
    const a = readArm(db, arms[0]!.key, T0 + 10 * DAY);
    expect(a.alpha).toBeCloseTo(3, 6);
    expect(a.beta).toBeCloseTo(2, 6);
    expect(effectiveOutcome(db, SID)).toMatchObject({ source: 'explicit', reward: 1 });
    // a weaker outcome later is stored but doesn't train
    expect(recordOutcome(db, { suggestionId: SID, reward: 0, weight: 0.5, source: 'ignored', arms, now: T0 + 11 * DAY })).toEqual({ effective: false });
    expect(readArm(db, arms[0]!.key, T0 + 10 * DAY).beta).toBeCloseTo(2, 6);
    // a second explicit replaces the first (done → skip)
    recordOutcome(db, { suggestionId: SID, reward: 0, weight: 1.5, source: 'explicit', arms, now: T0 + 10 * DAY });
    const b = readArm(db, arms[0]!.key, T0 + 10 * DAY);
    expect(b.alpha).toBeCloseTo(2, 6);
    expect(b.beta).toBeCloseTo(3.5, 6);
    // removing it promotes the strongest remaining outcome (the open, counted from when it was decided)
    expect(removeOutcome(db, SID, 'explicit', T0 + 10 * DAY)).toBe(true);
    expect(effectiveOutcome(db, SID)).toMatchObject({ source: 'open' });
    const c = readArm(db, arms[0]!.key, T0 + 10 * DAY);
    expect(c.alpha).toBeCloseTo(2 + 0.3 * decay(10 * DAY), 6);
    expect(c.beta).toBeCloseTo(2 + 0.7 * decay(10 * DAY), 6);
    expect(() => recordOutcome(db, { suggestionId: SID, reward: 2, weight: 1, source: 'open', arms, now: T0 })).toThrow(RangeError);
  });

  it('wildcard items train the generator arm, the kind at 0.5 and the person', () => {
    const arms = armsFor('dormant', { id: 'p1', tier: 'close', circleIds: ['c1'] }, 'dormant_close');
    expect(arms).toEqual([
      { arm: 'wildcard', key: 'wild:dormant_close', w: 1 },
      { arm: 'kind', key: 'kind:dormant', w: 0.5 },
      { arm: 'person', key: 'person:p1', w: 1 },
    ]);
    expect(armsFor('fading', { id: 'p1', tier: 'close', circleIds: ['c1'] }, null).map((a) => a.key)).toEqual([
      'kind:fading',
      'kind:fading|tier:close',
      'kind:fading|circle:c1',
      'person:p1',
    ]);
    expect(armsFor('circle_neglect', null, null, 'c9').map((a) => a.key)).toEqual(['kind:circle_neglect', 'kind:circle_neglect|circle:c9']);
  });

  it('Thompson factors: θ/0.5 clamped to [0.4, 1.8]; sparse buckets and people back off to 1; learning off → 1', () => {
    expect(clampFactor(0.01)).toBe(0.4);
    expect(clampFactor(0.99)).toBe(1.8);
    expect(clampFactor(0.5)).toBe(1);
    const db = suggestionsDb();
    const sampler = new ArmSampler(db, T0, mulberry32(3), true);
    const f = sampleFactors(sampler, 'fading', { id: 'p1', tier: 'steady', circleIds: [] }, 'Avery Q.', null, () => null);
    expect(f.bucket).toBe(1);
    expect(f.person).toBe(1);
    expect(f.kind).toBeGreaterThanOrEqual(0.4);
    expect(f.kind).toBeLessThanOrEqual(1.8);
    // one sample per arm per digest
    expect(sampler.factor({ arm: 'kind', key: 'kind:fading' }, 'x').value).toBe(f.kind);
    const off = sampleFactors(new ArmSampler(db, T0, mulberry32(3), false), 'fading', null, null, null, () => null);
    expect(off).toMatchObject({ kind: 1, bucket: 1, person: 1, wildcard: 1 });
  });

  it('a well-supported bad bucket pulls the score down; a strong kind lifts it', () => {
    const db = suggestionsDb();
    db.prepare(`INSERT INTO learner_arms (arm_key, alpha, beta, updated_at) VALUES ('kind:reply_debt', 40, 2, ?), ('kind:fading|tier:light', 2, 40, ?)`).run(T0, T0);
    const s = new ArmSampler(db, T0, mulberry32(9), true);
    expect(s.factor({ arm: 'kind', key: 'kind:reply_debt' }, 'x').value).toBeGreaterThan(1.6);
    const f = sampleFactors(s, 'fading', { id: 'p2', tier: 'light', circleIds: [] }, 'Bram O.', null, () => null);
    expect(f.bucket).toBe(0.4);
  });
});

describe('per-person state', () => {
  it('ignore cooldown doubles (7 d × 2^n) up to 90 days; acting resets it', () => {
    const db = suggestionsDb();
    const s1 = recordIgnore(db, 'p1', T0, 7);
    expect(s1).toMatchObject({ consecutiveIgnores: 1, cooldownUntil: T0 + 14 * DAY });
    expect(recordIgnore(db, 'p1', T0, 7).cooldownUntil).toBe(T0 + 28 * DAY);
    expect(recordIgnore(db, 'p1', T0, 7).cooldownUntil).toBe(T0 + 56 * DAY);
    expect(recordIgnore(db, 'p1', T0, 7).cooldownUntil).toBe(T0 + 90 * DAY); // 112 → capped
    resetIgnores(db, 'p1', T0);
    expect(personState(db, 'p1')).toMatchObject({ consecutiveIgnores: 0, cooldownUntil: null });
  });
});

describe('adaptive cap', () => {
  function digestWithLateItems(db: ReturnType<typeof suggestionsDb>, date: string, actedLate: boolean[]) {
    const did = `d-${date}`;
    db.prepare(`INSERT INTO digests (id, local_date, status) VALUES (?, ?, 'sent')`).run(did, date);
    actedLate.forEach((acted, i) => {
      const id = `s-${date}-${i}`;
      db.prepare(`INSERT INTO suggestions (id, kind, dedupe_key, score, signals, status, created_at, updated_at) VALUES (?, 'fading', ?, 0.5, '{}', ?, ?, ?)`).run(
        id,
        `fading:${id}`,
        acted ? 'done' : 'ignored',
        T0,
        T0,
      );
      db.prepare('INSERT INTO digest_items (digest_id, ordinal, suggestion_id) VALUES (?, ?, ?)').run(did, 4 + i, id);
    });
  }

  it('drops to 3 under 10% late act rate, rises to 5 above 40%, else the setting', () => {
    const settings = { 'digest.max_items': 4, 'digest.adaptive_cap': true };
    const db = suggestionsDb();
    expect(adaptiveCap(db, settings, T0, 'UTC')).toEqual({ cap: 4, lateActRate: null });
    for (const d of ['2026-10-05', '2026-10-06', '2026-10-07']) digestWithLateItems(db, d, [false, false]);
    expect(adaptiveCap(db, settings, T0, 'UTC')).toEqual({ cap: 3, lateActRate: 0 });
    const db2 = suggestionsDb();
    for (const d of ['2026-10-05', '2026-10-06', '2026-10-07']) digestWithLateItems(db2, d, [true, false]);
    expect(adaptiveCap(db2, settings, T0, 'UTC').cap).toBe(5);
    expect(adaptiveCap(db2, { ...settings, 'digest.adaptive_cap': false }, T0, 'UTC').cap).toBe(4);
    // without new data the last decision holds for 3 weeks, then the setting returns
    const db3 = suggestionsDb();
    for (const d of ['2026-10-05', '2026-10-06', '2026-10-07']) digestWithLateItems(db3, d, [false, false]);
    expect(adaptiveCap(db3, settings, T0, 'UTC').cap).toBe(3);
    expect(adaptiveCap(db3, settings, T0 + 15 * DAY, 'UTC').cap).toBe(3); // no late items in the window: the decision holds
    expect(adaptiveCap(db3, settings, T0 + 30 * DAY, 'UTC').cap).toBe(4); // 3 weeks on: back to the setting to re-probe
  });
});

describe('history and resets', () => {
  it('snapshots kind arms daily; reset forgets a scope and old contributions are never reversed into it', () => {
    const db = suggestionsDb();
    seedSuggestion(db, SID);
    seedSuggestion(db, SID2, 'reply_debt');
    const fadingArms = armsFor('fading', { id: 'p1', tier: 'close', circleIds: [] }, null);
    recordOutcome(db, { suggestionId: SID, reward: 0, weight: 2, source: 'explicit', arms: fadingArms, now: T0 });
    recordOutcome(db, { suggestionId: SID2, reward: 1, weight: 1, source: 'explicit', arms: armsFor('reply_debt', null, null), now: T0 });
    expect(snapshotArms(db, T0, 'UTC')).toBe(2);
    expect(propensityAsOf(db, 'kind:fading', '2026-10-14')).toBeCloseTo(2 / 6);
    expect(resetLearner(db, { scope: 'kind', kind: 'fading' }, T0 + DAY)).toBe(2); // kind:fading + its tier bucket
    expect(readArm(db, 'kind:fading', T0 + DAY).n).toBe(0);
    expect(readArm(db, 'person:p1', T0 + DAY).n).toBeGreaterThan(0);
    expect(propensityAsOf(db, 'kind:fading', '2026-10-14')).toBeNull();
    // replacing the old outcome does not subtract from the fresh arm
    recordOutcome(db, { suggestionId: SID, reward: 1, weight: 1, source: 'explicit', arms: fadingArms, now: T0 + 2 * DAY });
    expect(readArm(db, 'kind:fading', T0 + 2 * DAY)).toMatchObject({ alpha: 3, beta: 2 });
    expect(resetLearner(db, { scope: 'all' }, T0 + 3 * DAY)).toBeGreaterThan(0);
    expect(db.prepare('SELECT count(*) FROM learner_arms').pluck().get()).toBe(0);
  });
});
