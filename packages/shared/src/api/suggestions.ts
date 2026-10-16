/**
 * Suggestions: the digest items, their feedback and "Why this?".
 *
 *   POST /api/v1/suggestions/:id/feedback   SuggestionFeedback → SuggestionFeedbackResult
 *   GET  /api/v1/suggestions/:id/why        → WhyThis
 *   GET  /api/v1/suggestions?status=&kind=&cursor=&limit=   → SuggestionList (history)
 *
 * Openers are DRAFTS ONLY: no code path sends them; the web offers Copy, iMessage shows them as text to self.
 */
import { z } from 'zod';
import { Cursor, EvidenceRef, Ms, PersonChip } from './common';

/** Candidate generator kinds (PLAN "Suggestions"; intelligence §5). */
export const SUGGESTION_KINDS = [
  'reply_debt',
  'pre_event_brief',
  'commitment_due',
  'event_followup',
  'fading',
  'travel_overlap',
  'cooling',
  'intro',
  'circle_neglect',
  'dormant',
  'memory',
  'wildcard',
] as const;
export const SuggestionKind = z.enum(SUGGESTION_KINDS);
export type SuggestionKind = z.infer<typeof SuggestionKind>;

/** The 🎲 wildcard generators (drawn uniformly). */
export const WILDCARD_GENERATORS = ['dormant_close', 'unseen_kind', 'memory', 'intro_pair', 'circle_checkin'] as const;
export const WildcardGenerator = z.enum(WILDCARD_GENERATORS);
export type WildcardGenerator = z.infer<typeof WildcardGenerator>;

/** suggestions.status */
export const SuggestionStatus = z.enum([
  'candidate',
  'selected',
  'delivered',
  'done',
  'snoozed',
  'dismissed',
  'wrong',
  'expired',
  'superseded',
  'ignored',
]);
export type SuggestionStatus = z.infer<typeof SuggestionStatus>;

/** Buttons a digest card offers (Done / Snooze / Skip / ⋯ Wrong / Why this?). */
export const DigestAction = z.enum(['done', 'snooze', 'skip', 'wrong', 'why', 'draft', 'mute']);
export type DigestAction = z.infer<typeof DigestAction>;

/** Where tapping the card goes. */
export const SuggestionTarget = z.object({
  type: z.enum(['person', 'pair', 'event', 'circle', 'trip']),
  id: z.string(),
  /** pair: the second person. */
  otherId: z.string().nullable(),
  /** Relative web path: /p/<id>, /p/<a>/with/<b>, /e/<id>, /c/<id>, /trips. */
  href: z.string(),
});
export type SuggestionTarget = z.infer<typeof SuggestionTarget>;

/** One item of a digest (also the web card on Today). `ordinal` is the N in `done N`. */
export const DigestItem = z.object({
  suggestionId: z.string(),
  ordinal: z.number().int().min(1),
  kind: SuggestionKind,
  isWildcard: z.boolean(),
  wildcardGenerator: WildcardGenerator.nullable(),
  people: z.array(PersonChip),
  /** ≤90 chars; first name + last initial. */
  headline: z.string(),
  /** ≤240 chars. */
  body: z.string().nullable(),
  /** ≤2 conversation-starter drafts, each ≤160 chars. Copy-only. */
  openers: z.array(z.string()),
  /** Sensitive items say "something personal — open app" everywhere outside the web. */
  sensitive: z.boolean(),
  status: SuggestionStatus,
  snoozedUntil: Ms.nullable(),
  deliveredAt: Ms.nullable(),
  expiresAt: Ms.nullable(),
  /** Forced in (pre-event within 36 h, travel within 48 h). */
  timeCritical: z.boolean(),
  /** 'llm' when the composer wrote the copy and it passed grounding; 'template' otherwise. */
  copy: z.enum(['llm', 'template']),
  target: SuggestionTarget.nullable(),
  evidence: z.array(EvidenceRef),
  actions: z.array(DigestAction),
});
export type DigestItem = z.infer<typeof DigestItem>;

/** One multiplicative factor of the ranker score (Thompson samples normalized by 0.5, clamped to [0.4, 1.8]). */
export const LearnedFactor = z.object({
  arm: z.enum(['kind', 'bucket', 'circle', 'person', 'wildcard']),
  /** "Reply debt overall", "Fading · close friends", "Sam R.". */
  label: z.string(),
  value: z.number(),
  /** Posterior mean of the arm (0..1) and how many outcomes back it. */
  propensity: z.number(),
  n: z.number(),
});
export type LearnedFactor = z.infer<typeof LearnedFactor>;

/** A cadence/feature number shown in "Why this?" ("quiet 41 days", "usually every ~9 days"). */
export const WhySignal = z.object({ label: z.string(), value: z.string() });
export type WhySignal = z.infer<typeof WhySignal>;

/** GET /suggestions/:id/why (and `why N` over iMessage, as text). */
export const WhyThis = z.object({
  suggestionId: z.string(),
  kind: SuggestionKind,
  summary: z.string(),
  base: z.number(),
  score: z.number(),
  factors: z.array(LearnedFactor),
  signals: z.array(WhySignal),
  evidence: z.array(EvidenceRef),
  /** Fatigue / cooldown / priority adjustments that applied. */
  adjustments: z.array(WhySignal),
});
export type WhyThis = z.infer<typeof WhyThis>;

/** POST /suggestions/:id/feedback */
export const SuggestionFeedback = z.discriminatedUnion('action', [
  z.object({ action: z.literal('done') }),
  z.object({ action: z.literal('snooze'), until: Ms }),
  z.object({ action: z.literal('skip') }),
  /** "Wrong": negative feedback on the item; when it rests on a fact/merge/edge, that is retracted and blocked. */
  z.object({ action: z.literal('wrong'), note: z.string().max(500).optional() }),
  z.object({ action: z.literal('why') }),
  /** Two more openers (sync LLM call, effort low; template fallback). */
  z.object({ action: z.literal('draft') }),
  /** Web deep-link open: partial credit 0.3. */
  z.object({ action: z.literal('open') }),
  /** "Never suggest X": person = this person for any kind, kind = this kind for anyone, person_kind = both. */
  z.object({ action: z.literal('mute'), scope: z.enum(['person', 'kind', 'person_kind']) }),
]);
export type SuggestionFeedback = z.infer<typeof SuggestionFeedback>;
export type FeedbackActionName = SuggestionFeedback['action'];

export const SuggestionFeedbackResult = z.object({
  suggestionId: z.string(),
  status: SuggestionStatus,
  /** Journal batch of a retraction/mute the feedback caused (null for pure feedback). */
  batchId: z.string().nullable(),
  /** action=why */
  why: WhyThis.nullable(),
  /** action=draft */
  openers: z.array(z.string()).nullable(),
});
export type SuggestionFeedbackResult = z.infer<typeof SuggestionFeedbackResult>;

export const SuggestionListQuery = z.object({
  status: z.enum(['open', 'acted', 'all']).default('all'),
  kind: SuggestionKind.optional(),
  personId: z.string().optional(),
  cursor: Cursor.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type SuggestionListQuery = z.infer<typeof SuggestionListQuery>;

export const SuggestionSummary = z.object({
  id: z.string(),
  kind: SuggestionKind,
  isWildcard: z.boolean(),
  people: z.array(PersonChip),
  headline: z.string(),
  status: SuggestionStatus,
  score: z.number(),
  createdAt: Ms,
  deliveredAt: Ms.nullable(),
  actedAt: Ms.nullable(),
});
export type SuggestionSummary = z.infer<typeof SuggestionSummary>;

export const SuggestionList = z.object({ items: z.array(SuggestionSummary), nextCursor: z.string().nullable() });
export type SuggestionList = z.infer<typeof SuggestionList>;
