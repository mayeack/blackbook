/**
 * Suggestion contracts: candidate generators (one per kind, owned by the builder of that signal), the
 * self-learning ranker, and the feedback → reward mapping (PLAN "Suggestions, self-learning and wildcards";
 * intelligence §5).
 *
 * Flow (nightly, after ties/graph/obligations/intel): every registered CandidateGenerator emits Candidates →
 * the suggestions stage upserts them into `suggestions` (dedupe_key = `${kind}:${subjectKey}`, status
 * 'candidate'), applies cooldowns/mutes → the Ranker picks the digest (forced time-critical items, greedy by
 * score, ≤2 per kind, cap 3–5, maybe one 🎲 wildcard) → compose/delivery. Feedback (web, iMessage commands,
 * implicit "acted" detection) becomes Rewards that update the Beta arms in learner_arms.
 *
 * Generators are pure readers: they never write; the suggestions stage owns the `suggestions` table.
 * Persons in candidates are canonical, visible people only (never ME, hidden, merged, roster-only or service).
 */
import type { SuggestionKind, WildcardGenerator } from '@yb/shared';
import type { DB } from '../../db/connection';
import type { Logger } from '../../ops/logger';
import type { SettingsSnapshot } from '../../settings/registry';

export { SUGGESTION_KINDS, WILDCARD_GENERATORS, type SuggestionKind, type WildcardGenerator } from '@yb/shared';

// ---------------------------------------------------------------------------------------------- candidates

/** Ids a candidate points at (exactly the suggestions table's link columns). */
export interface CandidateLinks {
  eventId?: string | null;
  occasionId?: string | null;
  circleId?: string | null;
  commitmentId?: string | null;
  replyDebtId?: string | null;
  tripId?: string | null;
  /** intro: the second person (personIds[1] too). */
  relatedPersonId?: string | null;
}

/** Facts for the composer and "Why this?" — numbers and ids only; text is rendered later from them. */
export interface CandidatePayload {
  /** Template inputs: e.g. {silenceD: 41, expectedGapD: 9}, {question: 'm:8812'}, {city: 'Austin'}. */
  [key: string]: string | number | boolean | null | string[] | number[] | undefined;
}

export interface Candidate {
  kind: SuggestionKind;
  /** Canonical person ids, primary first ([] for circle-level items). */
  personIds: string[];
  /** Stable identity of the thing suggested within its kind (person id, `${a}|${b}`, debt id, occasion id, …). */
  subjectKey: string;
  /** Base score in [0, 1] (intelligence §5 table). Callers clamp; the ranker rejects NaN. */
  base: number;
  /** Citation ids: 'm:8812', 'F<id>', 'occ:<id>', 'event:<id>', 'K<commitmentId>', 'conv:<id>'. */
  evidenceIds: string[];
  /** After this the candidate is dropped (pre-event: event start; reply debt: 30 d; null = no expiry). */
  expiresAt: number | null;
  /** Forced into the digest (pre-event within 36 h, travel within 48 h). */
  timeCritical?: boolean;
  /** Touches a sensitive fact/occasion: never shown in iMessage or push (web says "something personal"). */
  sensitive?: boolean;
  links?: CandidateLinks;
  payload: CandidatePayload;
}

export interface GeneratorContext {
  db: DB;
  now: number;
  /** IANA zone (settings tz). */
  timeZone: string;
  settings: SettingsSnapshot;
  runId: string | null;
  log: Logger;
  signal?: AbortSignal;
}

export interface CandidateGenerator {
  kind: SuggestionKind;
  generate(ctx: GeneratorContext): Candidate[] | Promise<Candidate[]>;
}

/** A 🎲 wildcard source; its candidates are flagged is_wildcard with this generator. */
export interface WildcardSource {
  generator: WildcardGenerator;
  generate(ctx: GeneratorContext, rng: () => number): Candidate[] | Promise<Candidate[]>;
}

// ---------------------------------------------------------------------------------------------- per-kind policy

export interface KindPolicy {
  /** w_kind in the score. */
  weight: number;
  /** Per (person, kind) cooldown after a showing, days. null = once per subject (events, trips). */
  cooldownDays: number | null;
  /** Max showings of one subject (reply debt: 3). */
  maxShowings: number | null;
  /** Window after delivery in which an outbound/call/occasion/log with the person counts as "acted". */
  actWindowMs: number;
}

const H = 3_600_000;
const D = 24 * H;

/** intelligence §5 table + PLAN reward windows (72 h for debts/commitments/pre-event, 7 d for the rest). */
export const KIND_POLICY: Readonly<Record<SuggestionKind, KindPolicy>> = {
  reply_debt: { weight: 1.0, cooldownDays: 2, maxShowings: 3, actWindowMs: 72 * H },
  pre_event_brief: { weight: 1.0, cooldownDays: null, maxShowings: 1, actWindowMs: 72 * H },
  commitment_due: { weight: 0.95, cooldownDays: 3, maxShowings: null, actWindowMs: 72 * H },
  event_followup: { weight: 0.85, cooldownDays: null, maxShowings: 1, actWindowMs: 7 * D },
  party_invite: { weight: 0.8, cooldownDays: null, maxShowings: 1, actWindowMs: 7 * D },
  event_invite: { weight: 0.75, cooldownDays: null, maxShowings: 1, actWindowMs: 7 * D },
  fading: { weight: 0.8, cooldownDays: 14, maxShowings: null, actWindowMs: 7 * D },
  travel_overlap: { weight: 0.8, cooldownDays: null, maxShowings: 1, actWindowMs: 7 * D },
  cooling: { weight: 0.5, cooldownDays: 21, maxShowings: null, actWindowMs: 7 * D },
  intro: { weight: 0.5, cooldownDays: 30, maxShowings: null, actWindowMs: 7 * D },
  circle_neglect: { weight: 0.4, cooldownDays: 30, maxShowings: null, actWindowMs: 7 * D },
  dormant: { weight: 0.3, cooldownDays: 90, maxShowings: null, actWindowMs: 7 * D },
  memory: { weight: 0.3, cooldownDays: 365, maxShowings: 1, actWindowMs: 7 * D },
  wildcard: { weight: 0.3, cooldownDays: 30, maxShowings: null, actWindowMs: 7 * D },
};

/** Kinds where a Party invites person (pipeline/circles/preferences.ts) ranks higher: SELECTION.partyBoost. */
export const PARTY_BOOST_KINDS: ReadonlySet<SuggestionKind> = new Set<SuggestionKind>(['pre_event_brief', 'event_followup', 'party_invite', 'intro']);

/** Selection rules (intelligence §5, PLAN): */
export const SELECTION = {
  /** Default cap is the digest.max_items setting (3–5); adaptive moves it within [min, max]. */
  minCap: 3,
  maxCap: 5,
  maxPerKind: 2,
  /** ×0.6 when the kind already appears twice. */
  sameKindPenalty: 0.6,
  floor: 0.25,
  /** If fewer than 3 clear the floor. */
  relaxedFloor: 0.15,
  /** fatigue_p = 0.5 if the person appeared in any digest in the last 3 days. */
  fatigueFactor: 0.5,
  fatigueDays: 3,
  priorityBoost: 0.3,
  /** ×1.3 for a party / event / invite / intro item about someone in the Party invites circle (set by text). */
  partyBoost: 0.3,
  /** ×0.35 for an item about someone in the Deprioritized circle (set by text); they lose the priority boost too. */
  deprioritizedFactor: 0.35,
  /** Forced in: pre-event within 36 h, travel within 48 h. */
  preEventForceMs: 36 * H,
  travelForceMs: 48 * H,
  /** Adaptive cap: items past position 3 acted on < 10% over 3 weeks → 3; > 40% → 5. */
  adaptiveWindowDays: 21,
  adaptiveLow: 0.1,
  adaptiveHigh: 0.4,
} as const;

// ---------------------------------------------------------------------------------------------- learner

/** PLAN "Self-learning ranker". */
export const LEARNER = {
  priorAlpha: 2,
  priorBeta: 2,
  /** Exponential forgetting of arm counts. */
  halfLifeDays: 60,
  /** Thompson sample / 0.5, clamped. */
  factorMin: 0.4,
  factorMax: 1.8,
  /** No kind dies unless explicitly muted. */
  propensityFloor: 0.05,
  /** Ignore cooldown: base (settings agent.ignore_cooldown_days) × 2^consecutive ignores, capped. */
  ignoreCooldownCapDays: 90,
  /** Wildcard feedback also trains the underlying kind at this weight. */
  wildcardKindWeight: 0.5,
  /** Bucket arms back off to the kind arm below this many (decayed) outcomes. */
  minBucketN: 5,
  /** Counterfactual guard: no "acted" credit if the conversation was active in the 24 h before delivery. */
  counterfactualMs: 24 * H,
  /** Fading muted for 90 days after 3 dismissals for one person. */
  fadingMuteAfterDismissals: 3,
  fadingMuteDays: 90,
  /** Dismiss multiplies that (person, kind) cooldown by 4. */
  dismissCooldownMultiplier: 4,
} as const;

/** learner_arms.arm_key builders (one Beta per key). */
export const armKey = {
  kind: (k: SuggestionKind) => `kind:${k}`,
  bucket: (k: SuggestionKind, tier: string) => `kind:${k}|tier:${tier}`,
  circle: (k: SuggestionKind, circleId: string) => `kind:${k}|circle:${circleId}`,
  person: (personId: string) => `person:${personId}`,
  wildcard: (g: WildcardGenerator) => `wild:${g}`,
} as const;

export type RewardSource = 'explicit' | 'implicit' | 'open' | 'ignored' | 'wildcard';

/** A decided outcome of one suggestion (suggestion_outcomes row; UNIQUE (suggestion_id, source)). */
export interface Reward {
  suggestionId: string;
  /** 0..1 */
  reward: number;
  /** ≥0 */
  weight: number;
  source: RewardSource;
  decidedAt: number;
}

/** Explicit / implicit feedback → (reward, weight). `snooze` and `why` are neutral (no reward). */
export const REWARDS = {
  done: { reward: 1, weight: 1, source: 'explicit' },
  skip: { reward: 0, weight: 1.5, source: 'explicit' },
  dismiss: { reward: 0, weight: 1.5, source: 'explicit' },
  wrong: { reward: 0, weight: 2, source: 'explicit' },
  acted: { reward: 1, weight: 1, source: 'implicit' },
  open: { reward: 0.3, weight: 1, source: 'open' },
  ignored: { reward: 0, weight: 0.5, source: 'ignored' },
} as const satisfies Record<string, { reward: number; weight: number; source: RewardSource }>;

export type FeedbackChannel = 'imessage' | 'web' | 'push' | 'system';

/** One feedback event (feedback table) as the learner consumes it. */
export interface FeedbackEvent {
  suggestionId: string;
  action: 'done' | 'snooze' | 'skip' | 'dismiss' | 'wrong' | 'why' | 'draft' | 'open' | 'mute' | 'acted' | 'ignored';
  channel: FeedbackChannel;
  at: number;
  /** snooze: {until}; mute: {scope}; wrong: {note}. */
  payload?: Record<string, unknown>;
  inboundCommandId?: string | null;
}

// ---------------------------------------------------------------------------------------------- ranker

export interface LearnedFactors {
  kind: number;
  bucket: number;
  person: number;
  /** wildcard generator factor (1 for regular items) */
  wildcard: number;
}

export interface ScoredCandidate extends Candidate {
  /** suggestions.id once stored */
  suggestionId: string;
  score: number;
  factors: LearnedFactors;
  isWildcard: boolean;
  wildcardGenerator: WildcardGenerator | null;
}

export interface RankContext extends GeneratorContext {
  /** Seeded per digest; the seed is stored on digests.rng_seed. */
  rng: () => number;
  seed: number;
  /** Effective cap for this digest (3–5). */
  cap: number;
  /** Whether yesterday's digest carried a wildcard (never two days in a row). */
  wildcardYesterday: boolean;
}

export interface RankResult {
  /** In digest order (ordinal = index + 1). Composite items (one person, several kinds) are merged upstream. */
  selected: ScoredCandidate[];
  wildcard: ScoredCandidate | null;
  seed: number;
  cap: number;
  /** Candidates considered (counts by kind, for the run summary). */
  considered: Partial<Record<SuggestionKind, number>>;
}

export interface Ranker {
  rank(candidates: ScoredCandidate[], ctx: RankContext): RankResult;
}

/** suggestions.dedupe_key for a candidate. */
export const suggestionDedupeKey = (c: Pick<Candidate, 'kind' | 'subjectKey'>): string => `${c.kind}:${c.subjectKey}`;
