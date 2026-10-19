/**
 * The extraction output contract (intelligence §4.4) and the consolidation pass's answer. Structured outputs
 * (output_config.format) compile these to JSON Schema: every field is required, `nullable` replaces optional, and
 * there are no numeric/length bounds (the API drops them) — validate.ts enforces bounds, ref sets and quotes. The
 * SDK's zod helper also moves `enum` into the description, so enums are checked by zod after the fact.
 *
 * One window is read by TWO requests whose answers are merged into one `Extraction` before validation (so a window
 * is still validated, applied and undone as one): ExtractionKnowledge (summary, facts, mentions, relations,
 * self_id, topics) and ExtractionObligations (commitments, needs_reply; only sent when obligations can be kept, see
 * validate.ts needsObligations). The single schema had 86 grammar nodes and the API refused every request with
 * "The compiled grammar is too large" (llm/client.ts GRAMMAR_MAX_NODES); the split keeps each part far under it
 * (test/llm/outputSchemas.test.ts). Mentions stay with facts and relations because both use their M… ids.
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

/** Part 1 of a window: what is durably true about people (always sent). */
export const ExtractionKnowledge = z.object({
  /** Rolling conversation summary, ≤800 chars (truncated at a sentence in code). */
  summary: z.string(),
  facts: z.array(ExtractedFact),
  mentions: z.array(Mention),
  relations: z.array(Relation),
  self_id: z.array(SelfId),
  /** 0–5 short search tags. */
  topics: z.array(z.string()),
});
export type ExtractionKnowledge = z.infer<typeof ExtractionKnowledge>;

/** Part 2 of a window: plans, promises and whether ME owes a reply (only when they can still be kept). */
export const ExtractionObligations = z.object({
  commitments: z.array(ExtractedCommitment),
  needs_reply: NeedsReply,
});
export type ExtractionObligations = z.infer<typeof ExtractionObligations>;

/** One window's merged answer (never an output format itself: too big for one grammar). */
export const Extraction = z.object({
  summary: ExtractionKnowledge.shape.summary,
  facts: ExtractionKnowledge.shape.facts,
  commitments: ExtractionObligations.shape.commitments,
  needs_reply: ExtractionObligations.shape.needs_reply,
  mentions: ExtractionKnowledge.shape.mentions,
  relations: ExtractionKnowledge.shape.relations,
  self_id: ExtractionKnowledge.shape.self_id,
  topics: ExtractionKnowledge.shape.topics,
});
export type Extraction = z.infer<typeof Extraction>;

export const KNOWLEDGE_KEYS = Object.keys(ExtractionKnowledge.shape) as (keyof ExtractionKnowledge)[];
export const OBLIGATION_KEYS = Object.keys(ExtractionObligations.shape) as (keyof ExtractionObligations)[];

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

export const EMPTY_OBLIGATIONS: ExtractionObligations = {
  commitments: [],
  needs_reply: { state: 'n_a', msg: null, reason: null, urgency: 'normal', conf: 0 },
};

export const EMPTY_EXTRACTION: Extraction = {
  summary: '',
  facts: [],
  ...EMPTY_OBLIGATIONS,
  mentions: [],
  relations: [],
  self_id: [],
  topics: [],
};

/**
 * The two parts' parsed JSON → one window answer: each part contributes only its own keys; a window that sent no
 * obligations request gets EMPTY_OBLIGATIONS. Not validated here (Extraction.safeParse does that).
 */
export function mergeExtractionParts(knowledge: unknown, obligations: unknown | null): Record<string, unknown> | null {
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  if (!isObj(knowledge) || (obligations !== null && !isObj(obligations))) return null;
  const k = Object.fromEntries(KNOWLEDGE_KEYS.map((key) => [key, knowledge[key]]));
  const o = obligations ? Object.fromEntries(OBLIGATION_KEYS.map((key) => [key, obligations[key]])) : EMPTY_OBLIGATIONS;
  return { ...k, ...o };
}
