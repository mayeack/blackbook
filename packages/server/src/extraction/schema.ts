/**
 * The extraction output contract (intelligence §4.4) and the consolidation pass's answer. Structured outputs
 * (output_config.format) compile these to JSON Schema: every field is required, `nullable` replaces optional, and
 * there are no numeric/length bounds (the API drops them) — validate.ts enforces bounds, ref sets and quotes.
 *
 * Refs inside a window are local to it:
 *   "ME" (the owner) | "P…" (a participant or mentionable, from the packet) | "M<n>" (a mention placeholder the
 *   model declares in `mentions`). Messages are "m:<n>" (the window's own numbering), facts "F<n>", open
 *   commitments "K<n>" — all mapped back to database ids locally (packet.ts); nothing global leaves the Mac.
 */
import { z } from 'zod';

export const FACT_CATS = [
  'interest',
  'activity_pref',
  'food_drink',
  'location_current',
  'location_next',
  'hometown',
  'employer',
  'role',
  'school',
  'pet',
  'travel_plan',
  'other',
] as const;
export type FactCat = (typeof FACT_CATS)[number];

export const RELATION_LABELS = [
  'partner',
  'spouse',
  'ex',
  'sibling',
  'parent_child',
  'family_other',
  'roommate',
  'coworker',
  'classmate',
  'friend',
  'other',
] as const;
export type RelationLabel = (typeof RELATION_LABELS)[number];

export const COMMITMENT_KINDS = ['meet', 'call', 'send', 'intro', 'reply_later', 'favor', 'plan', 'other'] as const;
export type CommitmentKind = (typeof COMMITMENT_KINDS)[number];

const Ref = z.string();
const Ev = z.object({ msg: z.string(), quote: z.string() });
export type Ev = z.infer<typeof Ev>;

export const ExtractedFact = z.object({
  op: z.enum(['ADD', 'UPDATE', 'INVALIDATE', 'NOOP']),
  subject: Ref,
  /** "F<n>": required for UPDATE / INVALIDATE / NOOP, null for ADD. */
  target: z.string().nullable(),
  cat: z.enum(FACT_CATS),
  value: z.string(),
  /** YYYY-MM-DD */
  valid_from: z.string().nullable(),
  valid_to: z.string().nullable(),
  sensitive: z.boolean(),
  ev: z.array(Ev),
  conf: z.number(),
});
export type ExtractedFact = z.infer<typeof ExtractedFact>;

export const ExtractedCommitment = z.object({
  owner: z.enum(['ME', 'THEM', 'BOTH']),
  with: z.array(Ref),
  kind: z.enum(COMMITMENT_KINDS),
  what: z.string(),
  due: z.object({
    kind: z.enum(['date', 'range', 'vague', 'none']),
    start: z.string().nullable(),
    end: z.string().nullable(),
  }),
  status: z.enum(['open', 'done', 'cancelled']),
  /** "K<n>" of an open commitment this one closes (status done/cancelled). */
  closes: z.string().nullable(),
  ev: z.array(Ev),
  conf: z.number(),
});
export type ExtractedCommitment = z.infer<typeof ExtractedCommitment>;

export const NeedsReply = z.object({
  state: z.enum(['needs_reply', 'no_reply_needed', 'already_replied', 'n_a']),
  msg: z.string().nullable(),
  reason: z.enum(['question', 'request', 'invitation', 'plan_confirm', 'emotional', 'other']).nullable(),
  urgency: z.enum(['low', 'normal', 'high']),
  conf: z.number(),
});
export type NeedsReply = z.infer<typeof NeedsReply>;

export const Mention = z.object({
  id: z.string(),
  surface: z.string(),
  msg: z.string(),
  resolved: Ref.nullable(),
  candidates: z.array(Ref),
  descriptor: z.string().nullable(),
});
export type Mention = z.infer<typeof Mention>;

export const Relation = z.object({
  op: z.enum(['ADD', 'INVALIDATE']),
  a: Ref,
  b: Ref,
  label: z.enum(RELATION_LABELS),
  sensitive: z.boolean(),
  ev: z.array(Ev),
  conf: z.number(),
});
export type Relation = z.infer<typeof Relation>;

export const SelfId = z.object({
  ref: Ref,
  name: z.string(),
  context: z.string().nullable(),
  basis: z.enum(['self_stated', 'addressed_by_me', 'third_party', 'new_number']),
  ev: z.array(Ev),
  conf: z.number(),
});
export type SelfId = z.infer<typeof SelfId>;

export const Extraction = z.object({
  /** Rolling conversation summary, ≤800 chars (truncated at a sentence in code). */
  summary: z.string(),
  facts: z.array(ExtractedFact),
  commitments: z.array(ExtractedCommitment),
  needs_reply: NeedsReply,
  mentions: z.array(Mention),
  relations: z.array(Relation),
  self_id: z.array(SelfId),
  /** 0–5 short search tags. */
  topics: z.array(z.string()),
});
export type Extraction = z.infer<typeof Extraction>;

/** The per-person consolidation pass (backfill, or on demand): dedupe + normalize + a 2-sentence summary. */
export const Consolidation = z.object({
  /** Two plain sentences; no sensitive topics. */
  summary: z.string(),
  merges: z.array(
    z.object({
      /** "F<n>" kept */
      keep: z.string(),
      /** "F<n>"s folded into `keep` (same category) */
      drop: z.array(z.string()),
      /** Normalized value for `keep`, or null to leave it. */
      value: z.string().nullable(),
    }),
  ),
  invalidate: z.array(
    z.object({
      fact: z.string(),
      reason: z.enum(['duplicate', 'contradicted', 'stale', 'not_a_fact', 'excluded_topic']),
    }),
  ),
});
export type Consolidation = z.infer<typeof Consolidation>;

/** Byte-stable JSON Schema text (part of the prompt version). */
export function schemaJson(schema: z.ZodType): string {
  return JSON.stringify(z.toJSONSchema(schema));
}

export const EMPTY_EXTRACTION: Extraction = {
  summary: '',
  facts: [],
  commitments: [],
  needs_reply: { state: 'n_a', msg: null, reason: null, urgency: 'normal', conf: 0 },
  mentions: [],
  relations: [],
  self_id: [],
  topics: [],
};
