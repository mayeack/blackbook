/**
 * Person page extensions (routes/personExtras.ts; the base /people routes stay in routes/people.ts).
 *
 *   GET    /api/v1/people/:id/ties                       → TieStats
 *   GET    /api/v1/people/:id/facts                      → PersonFacts
 *   POST   /api/v1/people/:id/facts/:factId/wrong        FactWrong → BatchRef   (retract + block: never re-added)
 *   GET    /api/v1/people/:id/loops                      → OpenLoopList (loops.ts)
 *   GET    /api/v1/people/:id/starters                   → Starters        (copy-only drafts)
 *   GET    /api/v1/people/:id/connections                → Connections
 *   POST   /api/v1/people/:id/connections/:otherId/wrong ConnectionWrong → BatchRef
 *   GET    /api/v1/people/:id/notes                      → NoteList
 *   POST   /api/v1/people/:id/notes                      NoteCreate → NoteWriteResult
 *   PATCH  /api/v1/notes/:noteId                         NoteUpdate → NoteWriteResult
 *   DELETE /api/v1/notes/:noteId                         {} → BatchRef (tombstone)
 *   GET    /api/v1/people/:id/merges                     → MergeHistory
 *   POST   /api/v1/people/:id/merges/:mergeId/split      {} → BatchRef   (undo + do_not_merge)
 *   GET    /api/v1/people/:id/collections                → PersonCollections
 *   POST   /api/v1/people/:id/collections                CollectionMembershipEdit → BatchRef
 *   GET    /api/v1/people/:a/with/:b                     → PairView   (web: /p/:a/with/:b)
 */
import { z } from 'zod';
import { CollectionChip, CollectionType, EdgeTier, EvidenceRef, LocalDate, Ms, PersonChip, TieState } from './common';

// ------------------------------------------------------------------------------------------------ ties

export const SparkPoint = z.object({
  /** Week start (local date). */
  date: LocalDate,
  /** Tie strength T (0–100) at that snapshot. */
  t: z.number(),
  /** Touch units that week. */
  units: z.number(),
});
export type SparkPoint = z.infer<typeof SparkPoint>;

/** intelligence §3 per-person stats, for the header ring and "usually every ~9d · last 41d ago". */
export const TieStats = z.object({
  personId: z.string(),
  state: TieState.nullable(),
  /** "Strong", "Steady", "Cooling", "Fading", "Dormant", "New". */
  label: z.string().nullable(),
  tieStrength: z.number().nullable(),
  historicalStrength: z.number().nullable(),
  expectedGapD: z.number().nullable(),
  silenceD: z.number().nullable(),
  fadingRatio: z.number().nullable(),
  momentum: z.number().nullable(),
  reciprocity: z.number().nullable(),
  /** Share of 365-day sessions the owner started ("you start 82% of conversations"). */
  iStartShare: z.number().nullable(),
  contactDays365: z.number().int().nullable(),
  lastAt: Ms.nullable(),
  /** Fading held back until the person's WhatsApp/Instagram are ingesting. */
  fadingSuppressed: z.boolean(),
  sparkline: z.array(SparkPoint),
  computedAt: Ms.nullable(),
});
export type TieStats = z.infer<typeof TieStats>;

// ------------------------------------------------------------------------------------------------ facts

export const FactType = z.enum([
  'interest',
  'activity_pref',
  'food_drink',
  'job',
  'employer',
  'role',
  'school',
  'education',
  'home_location',
  'location_current',
  'location_next',
  'hometown',
  'travel_plan',
  'address',
  'relationship_status',
  'family',
  'pet',
  'preference',
  'other',
]);
export type FactType = z.infer<typeof FactType>;

export const FactView = z.object({
  id: z.string(),
  type: FactType,
  value: z.string(),
  status: z.enum(['candidate', 'tentative', 'confirmed', 'invalidated', 'rejected']),
  sensitive: z.boolean(),
  confidence: z.number(),
  support: z.number().int(),
  validFrom: Ms.nullable(),
  validTo: Ms.nullable(),
  recordedAt: Ms,
  retractedAt: Ms.nullable(),
  /** 'llm', 'user_log', 'legacy', 'addressbook', 'user'. */
  source: z.string(),
  evidence: z.array(EvidenceRef),
});
export type FactView = z.infer<typeof FactView>;

export const PersonFacts = z.object({
  /** tentative + confirmed, current (valid_to null or future). */
  active: z.array(FactView),
  /** Invalidated, superseded or rejected ("History"). */
  history: z.array(FactView),
});
export type PersonFacts = z.infer<typeof PersonFacts>;

export const FactWrong = z.object({ note: z.string().max(500).optional() });
export type FactWrong = z.infer<typeof FactWrong>;

// ------------------------------------------------------------------------------------------------ starters

export const Starter = z.object({
  text: z.string(),
  /** What it is grounded in (fact / message / event ids). */
  basis: z.array(EvidenceRef),
  source: z.enum(['llm', 'template']),
});
export type Starter = z.infer<typeof Starter>;

/** Conversation starters: drafts with a Copy button, labeled "never sent". No send path exists. */
export const Starters = z.object({
  starters: z.array(Starter),
  generatedAt: Ms.nullable(),
  neverSent: z.literal(true),
});
export type Starters = z.infer<typeof Starters>;

// ------------------------------------------------------------------------------------------------ connections

/** One evidence chip on an edge ("11 shared group chats · most active 'Ski Trip 2026'"). */
export const EdgeChip = z.object({
  /** edge_evidence.type ('co_group', 'co_attend', 'invited_by', 'plus_one', 'co_host', 'mentioned_together', …) or 'label'. */
  type: z.string(),
  text: z.string(),
  count: z.number().int(),
  latest: EvidenceRef.nullable(),
  /** Inline "wrong" retracts it and adds a negative. */
  wrongable: z.boolean(),
});
export type EdgeChip = z.infer<typeof EdgeChip>;

export const EdgeLabelView = z.object({
  id: z.string(),
  /** partner, spouse, sibling, parent_child, family_other, roommate, coworker, classmate, friend, other (ex is never shown). */
  label: z.string(),
  confidence: z.number(),
  origin: z.enum(['llm', 'user', 'legacy']),
  evidence: z.array(EvidenceRef),
});
export type EdgeLabelView = z.infer<typeof EdgeLabelView>;

export const ConnectionEdge = z.object({
  person: PersonChip,
  strength: z.number(),
  tier: EdgeTier,
  dominantType: z.string().nullable(),
  label: EdgeLabelView.nullable(),
  chips: z.array(EdgeChip),
  lastAt: Ms.nullable(),
});
export type ConnectionEdge = z.infer<typeof ConnectionEdge>;

export const Connections = z.object({
  personId: z.string(),
  edges: z.array(ConnectionEdge),
  /** Mini ego-graph: edges among the listed neighbors (canonical ids, a < b). */
  among: z.array(z.object({ a: z.string(), b: z.string(), strength: z.number() })),
});
export type Connections = z.infer<typeof Connections>;

export const ConnectionWrong = z.object({
  /** Retract one evidence type (e.g. 'mentioned_together') or the relation label (labelId). */
  type: z.string().max(40).optional(),
  labelId: z.string().optional(),
});
export type ConnectionWrong = z.infer<typeof ConnectionWrong>;

// ------------------------------------------------------------------------------------------------ notes

export const Note = z.object({
  id: z.string(),
  personId: z.string().nullable(),
  content: z.string(),
  origin: z.enum(['user', 'text_log', 'legacy', 'agent']),
  createdAt: Ms,
  updatedAt: Ms,
});
export type Note = z.infer<typeof Note>;

export const NoteList = z.object({ notes: z.array(Note) });
export type NoteList = z.infer<typeof NoteList>;

export const NoteCreate = z.object({ content: z.string().trim().min(1).max(10_000) });
export type NoteCreate = z.infer<typeof NoteCreate>;

export const NoteUpdate = NoteCreate;
export type NoteUpdate = z.infer<typeof NoteUpdate>;

export const NoteWriteResult = z.object({ note: Note, batchId: z.string().nullable() });
export type NoteWriteResult = z.infer<typeof NoteWriteResult>;

// ------------------------------------------------------------------------------------------------ merges

export const MergeRecord = z.object({
  id: z.string(),
  /** The record merged into this person (its name; never a phone/email). */
  merged: z.object({ id: z.string(), displayName: z.string() }),
  method: z.enum(['deterministic', 'probabilistic', 'llm_tiebreak', 'user', 'legacy', 'migration']),
  score: z.number().nullable(),
  /** Evidence families / reasons ("same phone", "IG handle ⊇ name + 2 shared groups"). */
  reasons: z.array(z.string()),
  batchId: z.string(),
  createdAt: Ms,
  undoneAt: Ms.nullable(),
  canSplit: z.boolean(),
});
export type MergeRecord = z.infer<typeof MergeRecord>;

export const MergeHistory = z.object({ merges: z.array(MergeRecord) });
export type MergeHistory = z.infer<typeof MergeHistory>;

// ------------------------------------------------------------------------------------------------ collections

export const PersonCollections = z.object({
  circles: z.array(CollectionChip.extend({ origin: z.enum(['auto', 'user', 'legacy']) })),
  tags: z.array(CollectionChip),
  locations: z.array(CollectionChip),
});
export type PersonCollections = z.infer<typeof PersonCollections>;

/** Add by id, or create-and-add by name (tags/locations/user circles). Removing an auto-circle member is sticky. */
export const CollectionMembershipEdit = z.object({
  add: z
    .array(
      z.object({ type: CollectionType, id: z.string().optional(), name: z.string().trim().min(1).max(80).optional() }).refine((v) => !!v.id !== !!v.name, {
        message: 'give id or name',
      }),
    )
    .max(50)
    .default([]),
  remove: z.array(z.object({ type: CollectionType, id: z.string() })).max(50).default([]),
});
export type CollectionMembershipEdit = z.infer<typeof CollectionMembershipEdit>;

// ------------------------------------------------------------------------------------------------ pair page

export const PairEvidenceItem = z.object({
  type: z.string(),
  at: Ms.nullable(),
  title: z.string(),
  quote: z.string().nullable(),
  ref: EvidenceRef,
});
export type PairEvidenceItem = z.infer<typeof PairEvidenceItem>;

export const PairView = z.object({
  a: PersonChip,
  b: PersonChip,
  strength: z.number(),
  tier: EdgeTier,
  weight: z.number(),
  label: EdgeLabelView.nullable(),
  chips: z.array(EdgeChip),
  sharedCircles: z.object({ both: z.array(CollectionChip), onlyA: z.array(CollectionChip), onlyB: z.array(CollectionChip) }),
  /** Merged evidence timeline (groups, events, mentions with quotes), newest first. */
  timeline: z.array(PairEvidenceItem),
  /** Batches that wrote the label/evidence (undo from here). */
  batchIds: z.array(z.string()),
});
export type PairView = z.infer<typeof PairView>;
