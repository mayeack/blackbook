/**
 * The self-learning ranker's memory (PLAN "Self-learning ranker"): Beta(α, β) arms per kind, kind × tie-tier,
 * kind × circle, person and 🎲 wildcard generator, with a Beta(2, 2) prior and exponential forgetting (half-life
 * 60 days) so tastes can drift; Thompson samples become ranker factors (θ / 0.5, clamped to [0.4, 1.8], θ floored
 * at the 0.05 propensity floor); per-person ignore cooldowns and hard mutes; the adaptive item cap.
 *
 * Forgetting is linear: an arm stores its excess over the prior as of `updated_at`, and every contribution made
 * at t₀ is worth c·0.5^((t−t₀)/H) at t. So reversing a contribution (a stronger outcome replacing a weaker one,
 * an undone `done`) subtracts exactly what is left of it. Learning tunes ONLY the ranker: nothing here touches
 * merge thresholds, fact gates or any journaled table.
 */
import { addDays, localDate, SUGGESTION_KINDS, type SuggestionKind, type WildcardGenerator } from '@yb/shared';
import type { DB } from '../../db/connection';
import { tx } from '../../db/tx';
import type { SettingsSnapshot } from '../../settings/registry';
import { beta as sampleBeta, type Rng } from './rng';
import { armKey, LEARNER, SELECTION, type RewardSource } from './types';
import { TIER_LABEL, type PersonInfo, type TieTier } from './people';

const DAY = 86_400_000;
const HALF_LIFE_MS = LEARNER.halfLifeDays * DAY;
const PRIOR_A = LEARNER.priorAlpha;
const PRIOR_B = LEARNER.priorBeta;

/** Person arms need at least this much (decayed) evidence before they move the score (else neutral). */
export const PERSON_MIN_N = 2;

/** One outcome per suggestion counts: explicit > implicit (acted) > open (0.3) > ignored. */
export const PRECEDENCE: Readonly<Record<RewardSource, number>> = { explicit: 4, implicit: 3, open: 2, ignored: 1, wildcard: 0 };

export const decay = (dtMs: number): number => (dtMs <= 0 ? 1 : 0.5 ** (dtMs / HALF_LIFE_MS));

// ---------------------------------------------------------------------------------------------- arms

export type ArmType = 'kind' | 'bucket' | 'circle' | 'person' | 'wildcard';

/** An arm a suggestion trains, with its weight (wildcard items train their kind at 0.5). */
export interface ArmRef {
  arm: ArmType;
  key: string;
  w: number;
}

export interface ArmPosterior {
  key: string;
  alpha: number;
  beta: number;
  /** Decayed outcome weight behind it (α + β − prior). */
  n: number;
  /** Posterior mean, floored at the propensity floor. */
  mean: number;
  updatedAt: number | null;
}

interface ArmRow {
  arm_key: string;
  alpha: number;
  beta: number;
  updated_at: number;
}

const mean = (a: number, b: number) => Math.max(LEARNER.propensityFloor, a / (a + b));

function decayed(row: ArmRow | undefined, now: number): { exA: number; exB: number } {
  if (!row) return { exA: 0, exB: 0 };
  const d = decay(now - row.updated_at);
  return { exA: Math.max(0, row.alpha - PRIOR_A) * d, exB: Math.max(0, row.beta - PRIOR_B) * d };
}

export function readArm(db: DB, key: string, now: number): ArmPosterior {
  const row = db.prepare('SELECT * FROM learner_arms WHERE arm_key = ?').get(key) as ArmRow | undefined;
  const { exA, exB } = decayed(row, now);
  const alpha = PRIOR_A + exA;
  const b = PRIOR_B + exB;
  return { key, alpha, beta: b, n: exA + exB, mean: mean(alpha, b), updatedAt: row?.updated_at ?? null };
}

/** All arms whose key starts with `prefix`, decayed to `now`. */
export function readArms(db: DB, prefix: string, now: number): ArmPosterior[] {
  const rows = db.prepare(`SELECT * FROM learner_arms WHERE arm_key >= ? AND arm_key < ? ORDER BY arm_key`).all(prefix, `${prefix}￿`) as ArmRow[];
  return rows.map((r) => {
    const { exA, exB } = decayed(r, now);
    return { key: r.arm_key, alpha: PRIOR_A + exA, beta: PRIOR_B + exB, n: exA + exB, mean: mean(PRIOR_A + exA, PRIOR_B + exB), updatedAt: r.updated_at };
  });
}

/** Adds (dA, dB) to an arm's decayed excess at `now` (negative to reverse; excess never drops below 0). */
function addToArm(db: DB, key: string, dA: number, dB: number, now: number): void {
  const row = db.prepare('SELECT * FROM learner_arms WHERE arm_key = ?').get(key) as ArmRow | undefined;
  const { exA, exB } = decayed(row, now);
  const alpha = PRIOR_A + Math.max(0, exA + dA);
  const b = PRIOR_B + Math.max(0, exB + dB);
  db.prepare(
    `INSERT INTO learner_arms (arm_key, alpha, beta, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(arm_key) DO UPDATE SET alpha = excluded.alpha, beta = excluded.beta, updated_at = excluded.updated_at`,
  ).run(key, alpha, b, now);
}

/** When the arm was last reset (by itself or by a reset of everything, key '*'). */
function resetAt(db: DB, key: string): number {
  return (
    (db.prepare(`SELECT max(reset_at) FROM learner_arm_resets WHERE arm_key IN (?, '*')`).pluck().get(key) as number | null | undefined) ?? -Infinity
  );
}

// ---------------------------------------------------------------------------------------------- arm sets

export const KIND_LABEL: Readonly<Record<SuggestionKind, string>> = {
  reply_debt: 'Replies owed',
  pre_event_brief: 'Event briefs',
  commitment_due: 'Promises',
  event_followup: 'Event follow-ups',
  party_invite: 'Who to invite',
  event_invite: 'Invite to a show',
  fading: 'Fading',
  travel_overlap: 'Travel',
  cooling: 'Cooling',
  intro: 'Intros',
  circle_neglect: 'Circle check-ins',
  dormant: 'Dormant',
  memory: 'Memories',
  wildcard: 'Wildcards',
};

export const WILDCARD_LABEL: Readonly<Record<WildcardGenerator, string>> = {
  dormant_close: 'Once-close friends',
  unseen_kind: 'Something different',
  memory: 'On this day',
  intro_pair: 'Intro pairs',
  circle_checkin: 'Circle check-ins',
};

/**
 * The arms a suggestion trains (and is scored by). Regular items: kind, kind × tie-tier, kind × each circle,
 * person. 🎲 items: the wildcard generator, the underlying kind at 0.5, and the person.
 */
export function armsFor(
  kind: SuggestionKind,
  person: Pick<PersonInfo, 'id' | 'tier' | 'circleIds'> | null,
  wildcard: WildcardGenerator | null,
  circleId?: string | null,
): ArmRef[] {
  if (wildcard) {
    const arms: ArmRef[] = [
      { arm: 'wildcard', key: armKey.wildcard(wildcard), w: 1 },
      { arm: 'kind', key: armKey.kind(kind), w: LEARNER.wildcardKindWeight },
    ];
    if (person) arms.push({ arm: 'person', key: armKey.person(person.id), w: 1 });
    return arms;
  }
  const arms: ArmRef[] = [{ arm: 'kind', key: armKey.kind(kind), w: 1 }];
  if (person) arms.push({ arm: 'bucket', key: armKey.bucket(kind, person.tier), w: 1 });
  const circles = person ? person.circleIds : circleId ? [circleId] : [];
  for (const c of circles) arms.push({ arm: 'circle', key: armKey.circle(kind, c), w: 1 });
  if (person) arms.push({ arm: 'person', key: armKey.person(person.id), w: 1 });
  return arms;
}

// ---------------------------------------------------------------------------------------------- Thompson sampling

export interface FactorDetail {
  arm: ArmType;
  key: string;
  label: string;
  value: number;
  propensity: number;
  n: number;
  /** false = too little data: backed off to neutral (1). */
  sampled: boolean;
}

export const clampFactor = (theta: number): number =>
  Math.min(LEARNER.factorMax, Math.max(LEARNER.factorMin, Math.max(LEARNER.propensityFloor, theta) / 0.5));

/** One Thompson sample per arm per digest (cached), drawn from the digest's seeded stream. */
export class ArmSampler {
  private readonly cache = new Map<string, { theta: number; post: ArmPosterior }>();

  constructor(
    private readonly db: DB,
    private readonly now: number,
    private readonly rng: Rng,
    private readonly enabled: boolean,
  ) {}

  private draw(key: string): { theta: number; post: ArmPosterior } {
    let hit = this.cache.get(key);
    if (!hit) {
      const post = readArm(this.db, key, this.now);
      hit = { theta: sampleBeta(this.rng, post.alpha, post.beta), post };
      this.cache.set(key, hit);
    }
    return hit;
  }

  factor(ref: Pick<ArmRef, 'arm' | 'key'>, label: string, minN = 0): FactorDetail {
    if (!this.enabled) {
      const post = readArm(this.db, ref.key, this.now);
      return { arm: ref.arm, key: ref.key, label, value: 1, propensity: post.mean, n: post.n, sampled: false };
    }
    const post = readArm(this.db, ref.key, this.now);
    if (post.n < minN) return { arm: ref.arm, key: ref.key, label, value: 1, propensity: post.mean, n: post.n, sampled: false };
    const { theta } = this.draw(ref.key);
    return { arm: ref.arm, key: ref.key, label, value: clampFactor(theta), propensity: post.mean, n: post.n, sampled: true };
  }
}

export interface ScoredFactors {
  kind: number;
  bucket: number;
  person: number;
  wildcard: number;
  details: FactorDetail[];
}

const geoMean = (xs: number[]) => (xs.length ? Math.exp(xs.reduce((s, x) => s + Math.log(x), 0) / xs.length) : 1);

/**
 * θ_kind × θ_bucket × θ_person (× θ_wild) for one candidate. θ_bucket combines the tie-tier arm and the circle arms
 * that have enough data (geometric mean); sparse bucket arms back off to the kind level (neutral 1).
 */
export function sampleFactors(
  sampler: ArmSampler,
  kind: SuggestionKind,
  person: Pick<PersonInfo, 'id' | 'tier' | 'circleIds'> | null,
  personLabel: string | null,
  wildcard: WildcardGenerator | null,
  circleNames: (id: string) => string | null,
  circleId?: string | null,
): ScoredFactors {
  const details: FactorDetail[] = [];
  const kindF = sampler.factor({ arm: 'kind', key: armKey.kind(kind) }, `${KIND_LABEL[kind]} overall`);
  details.push(kindF);
  const bucketParts: FactorDetail[] = [];
  if (person) {
    const tier = sampler.factor({ arm: 'bucket', key: armKey.bucket(kind, person.tier) }, `${KIND_LABEL[kind]} · ${TIER_LABEL[person.tier as TieTier]}`, LEARNER.minBucketN);
    details.push(tier);
    if (tier.sampled) bucketParts.push(tier);
  }
  for (const c of person ? person.circleIds : circleId ? [circleId] : []) {
    const f = sampler.factor({ arm: 'circle', key: armKey.circle(kind, c) }, `${KIND_LABEL[kind]} · ${circleNames(c) ?? 'a circle'}`, LEARNER.minBucketN);
    if (f.sampled) {
      details.push(f);
      bucketParts.push(f);
    }
  }
  let personF = 1;
  if (person) {
    const f = sampler.factor({ arm: 'person', key: armKey.person(person.id) }, personLabel ?? 'This person', PERSON_MIN_N);
    details.push(f);
    personF = f.value;
  }
  let wildF = 1;
  if (wildcard) {
    const f = sampler.factor({ arm: 'wildcard', key: armKey.wildcard(wildcard) }, `🎲 ${WILDCARD_LABEL[wildcard]}`);
    details.push(f);
    wildF = f.value;
  }
  const bucket = bucketParts.length ? Math.min(LEARNER.factorMax, Math.max(LEARNER.factorMin, geoMean(bucketParts.map((b) => b.value)))) : 1;
  return { kind: kindF.value, bucket, person: personF, wildcard: wildF, details };
}

// ---------------------------------------------------------------------------------------------- outcomes

interface OutcomeRow {
  id: number;
  suggestion_id: string;
  reward: number;
  weight: number;
  source: RewardSource;
  decided_at: number;
  effective: number;
  arms: string;
  applied_at: number | null;
}

function contribute(db: DB, o: Pick<OutcomeRow, 'reward' | 'weight' | 'arms' | 'applied_at' | 'decided_at'>, now: number, sign: 1 | -1): void {
  const arms = JSON.parse(o.arms) as ArmRef[];
  const t0 = o.applied_at ?? o.decided_at;
  const d = decay(now - t0);
  for (const a of arms) {
    if (sign === -1 && resetAt(db, a.key) > t0) continue; // contributions from before a reset are already gone
    const w = o.weight * a.w * d;
    addToArm(db, a.key, sign * o.reward * w, sign * (1 - o.reward) * w, now);
  }
}

export interface OutcomeInput {
  suggestionId: string;
  reward: number;
  weight: number;
  source: RewardSource;
  arms: ArmRef[];
  now: number;
}

/**
 * Records an outcome and trains its arms, keeping one effective outcome per suggestion: a same-source outcome is
 * replaced; a stronger one reverses the weaker effective one; a weaker one is stored but doesn't train.
 * Returns whether it became the effective outcome.
 */
export function recordOutcome(db: DB, o: OutcomeInput): { effective: boolean } {
  if (!(o.reward >= 0 && o.reward <= 1) || !(o.weight >= 0)) throw new RangeError('reward must be in [0,1], weight ≥ 0');
  return tx(db, () => {
    const rows = db.prepare('SELECT * FROM suggestion_outcomes WHERE suggestion_id = ?').all(o.suggestionId) as OutcomeRow[];
    const same = rows.find((r) => r.source === o.source);
    if (same) {
      if (same.effective) contribute(db, same, o.now, -1);
      db.prepare('DELETE FROM suggestion_outcomes WHERE id = ?').run(same.id);
    }
    const current = rows.find((r) => r !== same && r.effective === 1);
    const arms = JSON.stringify(o.arms);
    const insert = db.prepare(
      `INSERT INTO suggestion_outcomes (suggestion_id, reward, weight, source, decided_at, effective, arms, applied_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    if (current && PRECEDENCE[current.source] > PRECEDENCE[o.source]) {
      insert.run(o.suggestionId, o.reward, o.weight, o.source, o.now, 0, arms, null);
      return { effective: false };
    }
    if (current) {
      contribute(db, current, o.now, -1);
      db.prepare('UPDATE suggestion_outcomes SET effective = 0 WHERE id = ?').run(current.id);
    }
    insert.run(o.suggestionId, o.reward, o.weight, o.source, o.now, 1, arms, o.now);
    contribute(db, { reward: o.reward, weight: o.weight, arms, applied_at: o.now, decided_at: o.now }, o.now, 1);
    return { effective: true };
  });
}

/** Removes an outcome (an undone `done`): reverses it if effective and promotes the strongest remaining one. */
export function removeOutcome(db: DB, suggestionId: string, source: RewardSource, now: number): boolean {
  return tx(db, () => {
    const rows = db.prepare('SELECT * FROM suggestion_outcomes WHERE suggestion_id = ?').all(suggestionId) as OutcomeRow[];
    const target = rows.find((r) => r.source === source);
    if (!target) return false;
    if (target.effective) contribute(db, target, now, -1);
    db.prepare('DELETE FROM suggestion_outcomes WHERE id = ?').run(target.id);
    if (target.effective) {
      const next = rows.filter((r) => r !== target).sort((a, b) => PRECEDENCE[b.source] - PRECEDENCE[a.source])[0];
      if (next) {
        // Its contribution counts from when it was decided, as if it had been effective all along.
        const t0 = next.decided_at;
        contribute(db, { ...next, applied_at: t0 }, now, 1);
        db.prepare('UPDATE suggestion_outcomes SET effective = 1, applied_at = ? WHERE id = ?').run(t0, next.id);
      }
    }
    return true;
  });
}

export function effectiveOutcome(db: DB, suggestionId: string): { source: RewardSource; reward: number; weight: number } | null {
  return (
    (db.prepare('SELECT source, reward, weight FROM suggestion_outcomes WHERE suggestion_id = ? AND effective = 1').get(suggestionId) as
      | { source: RewardSource; reward: number; weight: number }
      | undefined) ?? null
  );
}

// ---------------------------------------------------------------------------------------------- per-person state

export interface PersonLearnerState {
  personId: string;
  consecutiveIgnores: number;
  cooldownUntil: number | null;
  muted: boolean;
  mutedKinds: SuggestionKind[];
  updatedAt: number | null;
}

interface PersonStateRow {
  person_id: string;
  consecutive_ignores: number;
  cooldown_until: number | null;
  muted: number;
  muted_kinds: string;
  updated_at: number;
}

const toState = (r: PersonStateRow): PersonLearnerState => ({
  personId: r.person_id,
  consecutiveIgnores: r.consecutive_ignores,
  cooldownUntil: r.cooldown_until,
  muted: r.muted === 1,
  mutedKinds: (JSON.parse(r.muted_kinds) as string[]).filter((k): k is SuggestionKind => (SUGGESTION_KINDS as readonly string[]).includes(k)),
  updatedAt: r.updated_at,
});

export function personState(db: DB, personId: string): PersonLearnerState {
  const r = db.prepare('SELECT * FROM learner_person_state WHERE person_id = ?').get(personId) as PersonStateRow | undefined;
  return r ? toState(r) : { personId, consecutiveIgnores: 0, cooldownUntil: null, muted: false, mutedKinds: [], updatedAt: null };
}

export function allPersonStates(db: DB): PersonLearnerState[] {
  return (db.prepare('SELECT * FROM learner_person_state ORDER BY person_id').all() as PersonStateRow[]).map(toState);
}

function writePersonState(db: DB, s: PersonLearnerState, now: number): void {
  db.prepare(
    `INSERT INTO learner_person_state (person_id, consecutive_ignores, cooldown_until, muted, muted_kinds, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(person_id) DO UPDATE SET consecutive_ignores = excluded.consecutive_ignores, cooldown_until = excluded.cooldown_until,
       muted = excluded.muted, muted_kinds = excluded.muted_kinds, updated_at = excluded.updated_at`,
  ).run(s.personId, s.consecutiveIgnores, s.cooldownUntil, s.muted ? 1 : 0, JSON.stringify(s.mutedKinds), now);
}

/** An ignored item: the person rests base × 2^n days after the n-th consecutive ignore (PLAN; capped at 90). */
export function recordIgnore(db: DB, personId: string, now: number, baseDays: number): PersonLearnerState {
  const s = personState(db, personId);
  const n = s.consecutiveIgnores + 1;
  const days = Math.min(LEARNER.ignoreCooldownCapDays, Math.max(0, baseDays) * 2 ** n);
  const next = { ...s, consecutiveIgnores: n, cooldownUntil: Math.max(s.cooldownUntil ?? 0, now + days * DAY) };
  writePersonState(db, next, now);
  return next;
}

/** Acting on someone resets their ignore streak and cooldown. */
export function resetIgnores(db: DB, personId: string, now: number): void {
  const s = personState(db, personId);
  if (!s.consecutiveIgnores && !s.cooldownUntil) return;
  writePersonState(db, { ...s, consecutiveIgnores: 0, cooldownUntil: null }, now);
}

/** "Never suggest X": kinds = null mutes the person entirely. */
export function mutePerson(db: DB, personId: string, kinds: SuggestionKind[] | null, now: number): void {
  const s = personState(db, personId);
  if (kinds === null) writePersonState(db, { ...s, muted: true }, now);
  else writePersonState(db, { ...s, mutedKinds: [...new Set([...s.mutedKinds, ...kinds])] }, now);
}

/** Unmutes one kind for the person, or (kind undefined) the whole person. False when nothing was muted. */
export function unmutePerson(db: DB, personId: string, kind: SuggestionKind | undefined, now: number): boolean {
  const s = personState(db, personId);
  if (kind) {
    if (!s.mutedKinds.includes(kind)) return false;
    writePersonState(db, { ...s, mutedKinds: s.mutedKinds.filter((k) => k !== kind) }, now);
    return true;
  }
  if (!s.muted && !s.mutedKinds.length) return false;
  writePersonState(db, { ...s, muted: false, mutedKinds: [] }, now);
  return true;
}

// ---------------------------------------------------------------------------------------------- adaptive cap

function readMeta<T>(db: DB, key: string): T | null {
  const raw = db.prepare('SELECT value FROM learner_meta WHERE key = ?').pluck().get(key) as string | undefined;
  return raw ? (JSON.parse(raw) as T) : null;
}

function writeMeta(db: DB, key: string, value: unknown, now: number): void {
  db.prepare(
    `INSERT INTO learner_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, JSON.stringify(value), now);
}

/** Minimum number of items past position 3 before the adaptive cap moves. */
export const ADAPTIVE_MIN_ITEMS = 5;

/**
 * Acted-on rate of regular items past position 3 over the last 3 weeks (wildcards excluded); null when there are
 * fewer than ADAPTIVE_MIN_ITEMS of them.
 */
export function lateActRate(db: DB, now: number, timeZone: string): { rate: number | null; items: number } {
  const today = localDate(now, timeZone);
  const from = addDays(today, -SELECTION.adaptiveWindowDays);
  const rows = db
    .prepare(
      `SELECT s.id, s.status, s.acted_at,
              EXISTS (SELECT 1 FROM suggestion_outcomes o WHERE o.suggestion_id = s.id AND o.effective = 1 AND o.reward >= 1) AS rewarded
       FROM digest_items di JOIN digests d ON d.id = di.digest_id JOIN suggestions s ON s.id = di.suggestion_id
       LEFT JOIN digest_rankings r ON r.digest_id = d.id
       WHERE d.local_date >= ? AND d.local_date < ? AND di.ordinal > 3 AND (r.wildcard_suggestion_id IS NULL OR r.wildcard_suggestion_id <> s.id)`,
    )
    .all(from, today) as { id: string; status: string; acted_at: number | null; rewarded: number }[];
  if (rows.length < ADAPTIVE_MIN_ITEMS) return { rate: null, items: rows.length };
  const acted = rows.filter((r) => r.rewarded || r.status === 'done' || r.acted_at !== null).length;
  return { rate: acted / rows.length, items: rows.length };
}

interface AdaptiveMeta {
  cap: number;
  basis: number;
  decidedAt: number;
}

export const settingsCap = (s: Pick<SettingsSnapshot, 'digest.max_items'>): number =>
  Math.min(SELECTION.maxCap, Math.max(SELECTION.minCap, Math.round(s['digest.max_items'])));

/**
 * The effective cap for today's digest. Off (digest.adaptive_cap=false) → the setting. Otherwise the late-item
 * act rate moves it to 3 (<10%) or 5 (>40%); between, or without enough data, the last decision stands for 3 weeks
 * and then returns to the setting (so a cap of 3 can re-probe position 4). A changed setting starts over.
 */
export function adaptiveCap(
  db: DB,
  settings: Pick<SettingsSnapshot, 'digest.max_items' | 'digest.adaptive_cap'>,
  now: number,
  timeZone: string,
  persist = true,
): { cap: number; lateActRate: number | null } {
  const base = settingsCap(settings);
  const { rate } = lateActRate(db, now, timeZone);
  if (!settings['digest.adaptive_cap']) return { cap: base, lateActRate: rate };
  let stored = readMeta<AdaptiveMeta>(db, 'adaptive_cap');
  if (stored && stored.basis !== base) stored = null;
  let cap: number;
  if (rate === null) cap = stored && now - stored.decidedAt < SELECTION.adaptiveWindowDays * DAY ? stored.cap : base;
  else cap = rate < SELECTION.adaptiveLow ? SELECTION.minCap : rate > SELECTION.adaptiveHigh ? SELECTION.maxCap : base;
  if (persist && (!stored || stored.cap !== cap || rate !== null)) {
    writeMeta(db, 'adaptive_cap', { cap, basis: base, decidedAt: rate === null && stored ? stored.decidedAt : now } satisfies AdaptiveMeta, now);
  }
  return { cap, lateActRate: rate };
}

// ---------------------------------------------------------------------------------------------- history & resets

/** Daily snapshot of the kind and wildcard arms (for the 14-day trend). */
export function snapshotArms(db: DB, now: number, timeZone: string): number {
  const day = localDate(now, timeZone);
  const arms = [...readArms(db, 'kind:', now).filter((a) => !a.key.includes('|')), ...readArms(db, 'wild:', now)];
  const stmt = db.prepare(
    `INSERT INTO learner_arm_history (arm_key, day, alpha, beta) VALUES (?, ?, ?, ?)
     ON CONFLICT(arm_key, day) DO UPDATE SET alpha = excluded.alpha, beta = excluded.beta`,
  );
  tx(db, () => {
    for (const a of arms) stmt.run(a.key, day, a.alpha, a.beta);
    db.prepare('DELETE FROM learner_arm_history WHERE day < ?').run(addDays(day, -120));
  });
  return arms.length;
}

/** Propensity of an arm as of the latest snapshot on or before `day` (null when there is none). */
export function propensityAsOf(db: DB, key: string, day: string): number | null {
  const r = db.prepare('SELECT alpha, beta FROM learner_arm_history WHERE arm_key = ? AND day <= ? ORDER BY day DESC LIMIT 1').get(key, day) as
    | { alpha: number; beta: number }
    | undefined;
  return r ? mean(r.alpha, r.beta) : null;
}

export type ResetScope = { scope: 'all' } | { scope: 'kind'; kind: SuggestionKind } | { scope: 'person'; personId: string } | { scope: 'wildcard' };

/**
 * Forgets what was learned for a scope: its arms (and their trend history) go back to the prior; a person reset
 * also clears their ignore streak/cooldown (mutes stay: they are explicit choices). Returns the number of arms and
 * person rows reset.
 */
export function resetLearner(db: DB, r: ResetScope, now: number): number {
  return tx(db, () => {
    const keys: string[] = [];
    const like = (prefix: string) =>
      db.prepare(`SELECT arm_key FROM learner_arms WHERE arm_key >= ? AND arm_key < ?`).pluck().all(prefix, `${prefix}￿`) as string[];
    if (r.scope === 'all') keys.push(...(db.prepare('SELECT arm_key FROM learner_arms').pluck().all() as string[]));
    else if (r.scope === 'kind') keys.push(...like(`kind:${r.kind}|`), ...like(armKey.kind(r.kind)).filter((k) => k === armKey.kind(r.kind)));
    else if (r.scope === 'person') keys.push(...like(armKey.person(r.personId)).filter((k) => k === armKey.person(r.personId)));
    else keys.push(...like('wild:'));
    const del = db.prepare('DELETE FROM learner_arms WHERE arm_key = ?');
    const hist = db.prepare('DELETE FROM learner_arm_history WHERE arm_key = ?');
    const mark = db.prepare(
      'INSERT INTO learner_arm_resets (arm_key, reset_at) VALUES (?, ?) ON CONFLICT(arm_key) DO UPDATE SET reset_at = excluded.reset_at',
    );
    for (const k of new Set(keys)) {
      del.run(k);
      hist.run(k);
      mark.run(k, now);
    }
    let people = 0;
    if (r.scope === 'all') {
      people = db.prepare('UPDATE learner_person_state SET consecutive_ignores = 0, cooldown_until = NULL, updated_at = ? WHERE consecutive_ignores > 0 OR cooldown_until IS NOT NULL').run(now).changes;
      db.prepare(`DELETE FROM learner_meta WHERE key = 'adaptive_cap'`).run();
      // Anything recorded before the reset can no longer be reversed into a fresh arm.
      db.prepare(`INSERT INTO learner_arm_resets (arm_key, reset_at) VALUES ('*', ?) ON CONFLICT(arm_key) DO UPDATE SET reset_at = excluded.reset_at`).run(now);
    } else if (r.scope === 'person') {
      people = db
        .prepare('UPDATE learner_person_state SET consecutive_ignores = 0, cooldown_until = NULL, updated_at = ? WHERE person_id = ? AND (consecutive_ignores > 0 OR cooldown_until IS NOT NULL)')
        .run(now, r.personId).changes;
    }
    return new Set(keys).size + people;
  });
}
