/**
 * Golden-set labeling (Settings → Eval, /settings/eval) and the eval report (intelligence §8).
 *
 *   GET  /api/v1/eval/items?set=&status=&cursor=&limit=   → EvalItemPage
 *   POST /api/v1/eval/labels                             EvalLabelInput → EvalLabelResult
 *   GET  /api/v1/eval/report                             → EvalReport
 *
 * Items are local (the owner's own data on his own server); nothing here is sent to the LLM.
 */
import { z } from 'zod';
import { Cursor, Ms } from './common';

/** G1 extraction windows · G2 identity pairs · G3 reply debt · G4 ask questions. */
export const EvalSet = z.enum(['extraction', 'identity', 'reply_debt', 'ask']);
export type EvalSet = z.infer<typeof EvalSet>;

export const EvalLine = z.object({
  /** 'm:8812' */
  ref: z.string(),
  at: Ms.nullable(),
  author: z.string(),
  text: z.string(),
  /** CONTEXT lines are shown greyed out (do-not-extract). */
  context: z.boolean(),
});
export type EvalLine = z.infer<typeof EvalLine>;

/** One thing the system predicted that the owner judges. */
export const EvalPrediction = z.object({
  id: z.string(),
  /** 'fact' | 'commitment' | 'needs_reply' | 'relation' | 'self_id' | 'merge' | 'person' … */
  kind: z.string(),
  label: z.string(),
  detail: z.string().nullable(),
  refs: z.array(z.string()),
});
export type EvalPrediction = z.infer<typeof EvalPrediction>;

export const EvalVerdict = z.enum(['correct', 'incorrect', 'unsure']);
export type EvalVerdict = z.infer<typeof EvalVerdict>;

export const EvalLabel = z.object({
  verdicts: z.array(z.object({ predictionId: z.string(), verdict: EvalVerdict })),
  /** Things the system missed, in the owner's words. */
  missing: z.array(z.string().max(300)),
  note: z.string().max(1000).nullable(),
  labeledAt: Ms,
});
export type EvalLabel = z.infer<typeof EvalLabel>;

export const EvalItem = z.object({
  id: z.string(),
  set: EvalSet,
  title: z.string(),
  /** extraction / reply_debt: the window lines; identity: both sides' summaries; ask: the question. */
  lines: z.array(EvalLine),
  predictions: z.array(EvalPrediction),
  /** ask: the expected people (owner-entered). */
  expectedPersonIds: z.array(z.string()),
  label: EvalLabel.nullable(),
  promptVersion: z.string().nullable(),
  createdAt: Ms,
});
export type EvalItem = z.infer<typeof EvalItem>;

export const EvalItemsQuery = z.object({
  set: EvalSet.optional(),
  status: z.enum(['unlabeled', 'labeled', 'all']).default('unlabeled'),
  cursor: Cursor.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});
export type EvalItemsQuery = z.infer<typeof EvalItemsQuery>;

export const EvalSetCount = z.object({ set: EvalSet, total: z.number().int(), labeled: z.number().int(), target: z.number().int() });
export type EvalSetCount = z.infer<typeof EvalSetCount>;

export const EvalItemPage = z.object({
  items: z.array(EvalItem),
  nextCursor: z.string().nullable(),
  counts: z.array(EvalSetCount),
});
export type EvalItemPage = z.infer<typeof EvalItemPage>;

export const EvalLabelInput = z.object({
  itemId: z.string(),
  verdicts: z.array(z.object({ predictionId: z.string(), verdict: EvalVerdict })).max(200),
  missing: z.array(z.string().trim().min(1).max(300)).max(50).default([]),
  note: z.string().max(1000).optional(),
  /** ask set: the people the answer should have found. */
  expectedPersonIds: z.array(z.string()).max(50).optional(),
});
export type EvalLabelInput = z.infer<typeof EvalLabelInput>;

export const EvalLabelResult = z.object({ itemId: z.string(), labeledAt: Ms });
export type EvalLabelResult = z.infer<typeof EvalLabelResult>;

export const EvalMetric = z.object({
  /** 'precision.interest', 'recall', 'groundedness', 'schema_valid', 'refusal_rate', 'due_date_±1d', … */
  name: z.string(),
  value: z.number().nullable(),
  target: z.number(),
  /** Higher is better unless false (refusal rate). */
  higherIsBetter: z.boolean(),
  pass: z.boolean().nullable(),
  n: z.number().int(),
});
export type EvalMetric = z.infer<typeof EvalMetric>;

export const EvalReport = z.object({
  generatedAt: Ms,
  sets: z.array(z.object({ set: EvalSet, labeled: z.number().int(), metrics: z.array(EvalMetric) })),
  /** Online signals (digest action/dismiss/wrong rates, undo rates). */
  online: z.array(EvalMetric),
  promptVersions: z.array(z.string()),
});
export type EvalReport = z.infer<typeof EvalReport>;
