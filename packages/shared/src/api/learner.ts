/**
 * Settings → "What I've learned" (self-learning ranker transparency).
 *
 *   GET  /api/v1/learner            → LearnerState
 *   POST /api/v1/learner/reset      LearnerReset → { reset: n }
 *   POST /api/v1/learner/unmute     LearnerUnmute → OkResult
 *
 * Learning tunes only the ranker; merge thresholds and fact gates never move from feedback.
 */
import { z } from 'zod';
import { Ms, PersonChip } from './common';
import { SuggestionKind, WildcardGenerator } from './suggestions';

export const Trend = z.enum(['up', 'down', 'flat']);
export type Trend = z.infer<typeof Trend>;

export const KindPropensity = z.object({
  kind: SuggestionKind,
  alpha: z.number(),
  beta: z.number(),
  /** Posterior mean α/(α+β), floored at 0.05. */
  propensity: z.number(),
  trend: Trend,
  /** Change in propensity over the last 14 days. */
  trendDelta: z.number(),
  shown30d: z.number().int(),
  acted30d: z.number().int(),
  /** Hard-muted by the owner ("never suggest"). */
  muted: z.boolean(),
});
export type KindPropensity = z.infer<typeof KindPropensity>;

export const LearnerState = z.object({
  kinds: z.array(KindPropensity),
  wildcard: z.object({
    epsilon: z.number(),
    /** Share of shown wildcards acted on (null before any were shown). */
    hitRate: z.number().nullable(),
    shown: z.number().int(),
    acted: z.number().int(),
    lastShownDate: z.string().nullable(),
    generators: z.array(z.object({ generator: WildcardGenerator, propensity: z.number(), shown: z.number().int(), acted: z.number().int() })),
  }),
  mutedPeople: z.array(z.object({ person: PersonChip, kinds: z.array(SuggestionKind), since: Ms.nullable() })),
  cooledPeople: z.array(z.object({ person: PersonChip, cooldownUntil: Ms, consecutiveIgnores: z.number().int() })),
  adaptiveCap: z.object({
    current: z.number().int(),
    /** Acted-on rate of items past position 3 over 3 weeks (null = not enough data). */
    lateActRate: z.number().nullable(),
  }),
  updatedAt: Ms.nullable(),
});
export type LearnerState = z.infer<typeof LearnerState>;

export const LearnerReset = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('all') }),
  z.object({ scope: z.literal('kind'), kind: SuggestionKind }),
  z.object({ scope: z.literal('person'), personId: z.string() }),
  z.object({ scope: z.literal('wildcard') }),
]);
export type LearnerReset = z.infer<typeof LearnerReset>;

export const LearnerResetResult = z.object({ reset: z.number().int() });
export type LearnerResetResult = z.infer<typeof LearnerResetResult>;

export const LearnerUnmute = z.union([
  z.object({ personId: z.string(), kind: SuggestionKind.optional() }),
  z.object({ kind: SuggestionKind }),
]);
export type LearnerUnmute = z.infer<typeof LearnerUnmute>;
