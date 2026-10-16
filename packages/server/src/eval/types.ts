/**
 * Internal shapes of the eval module: what an eval_items row holds (payload + snapshotted predictions with the
 * metadata the metrics need) and the keyed predictions shadow replays compare. The web sees only the EvalItem DTO
 * (@yb/shared): `m` never leaves the server.
 */
import type { EvalSet } from '@yb/shared';

export type SetName = EvalSet;
export const SET_NAMES: readonly SetName[] = ['extraction', 'identity', 'reply_debt', 'ask'];

/** What a prediction claims, in metric terms. */
export interface PredictionMeta {
  /** fact category, commitment kind, needs_reply state, relation label, reply reason, … */
  cat?: string | null;
  /** extraction: shown to the owner (tentative/confirmed fact, any commitment / verdict / relation) vs an invisible candidate */
  applied?: boolean;
  /** The row it came from (fact id, commitment id, edge label id, debt id, turn id). */
  subjectId?: string | null;
  /** Canonical person the claim is about (fact subject, commitment counterpart, Ask person, debt person). */
  personId?: string | null;
  /** Match key for shadow comparisons ('fact|<person>|<cat>|<value_norm>', …). */
  key?: string | null;
  /** Normalized value (fact value_norm, commitment `what`) for fuzzy matching. */
  value?: string | null;
  /** Evidence as stored: message id + quote AS SENT (null when sensitive). */
  evidence?: { msgId: number; quote: string | null }[];
  /** identity: merged | held | possible_duplicate | blocked | separate · reply_debt: open | snoozed | none */
  decision?: string | null;
  /** identity merge method (deterministic | probabilistic | llm_tiebreak) */
  method?: string | null;
  p?: number | null;
  conf?: number | null;
  /** Ask: position of the person in the answer (1-based). */
  rank?: number;
  /** shadow spot-check: new in the candidate prompt, unchanged, or dropped by it */
  shadow?: 'added' | 'kept' | 'removed';
}

export interface StoredPrediction {
  id: string;
  /** fact | commitment | due_date | needs_reply | relation | merge | possible | separate | no_reply | person | citation */
  kind: string;
  label: string;
  detail: string | null;
  refs: string[];
  m: PredictionMeta;
}

/** One message line of a window as the model saw it (payload snapshot). */
export interface PayloadLine {
  msgId: number;
  /** window-local m:N (0 for triaged-out windows, which never had a packet) */
  n: number;
  role: 'new' | 'context';
  at: number;
  /** canonical person id of the author, null = the owner */
  authorPersonId: string | null;
  /** the body exactly as sent (pseudonymized), null when the window never had a packet */
  body: string | null;
}

export interface ExtractionPayload {
  kind: 'extraction';
  windowId: string;
  conversationId: string;
  source: string;
  chat: 'dm' | 'group';
  mode: 'steady' | 'historical';
  status: 'applied' | 'triaged_out';
  lines: PayloadLine[];
  /** The pseudonymized user turn (kept for golden windows so a new prompt can be replayed after the 30-day purge). */
  userText: string | null;
}

export interface IdentityPayload {
  kind: 'identity';
  a: string;
  b: string;
  band: 'auto' | 'possible' | 'low' | 'twin' | 'first_week';
  candidateId: number | null;
  mergeId: string | null;
  families: string[];
  guards: string[];
}

export interface ReplyPayload {
  kind: 'reply_debt';
  conversationId: string;
  source: string;
  chat: 'direct' | 'group';
  /** The fixed timestamp the case is frozen at: only messages up to it are shown or judged. */
  frozenAt: number;
  msgIds: number[];
  debtId: string | null;
  debtMsg: number | null;
  personId: string | null;
}

export interface AskPayload {
  kind: 'ask';
  turnId: string;
  conversationId: string;
  channel: 'web' | 'imessage';
  question: string;
  answer: string | null;
  degraded: boolean;
  violations: number;
  askedAt: number;
  finishedAt: number | null;
}

export type ItemPayload = ExtractionPayload | IdentityPayload | ReplyPayload | AskPayload;

export interface StoredLabel {
  verdicts: { predictionId: string; verdict: 'correct' | 'incorrect' | 'unsure' }[];
  missing: string[];
  note: string | null;
  labeledAt: number;
}

export interface ItemRow {
  id: string;
  set_name: SetName;
  subject_ref: string;
  stratum: string;
  origin: 'sample' | 'shadow';
  shadow_run_id: string | null;
  title: string;
  frozen_at: number;
  payload: string;
  predictions: string;
  prompt_version: string | null;
  expected_person_ids: string;
  label: string | null;
  labeled_at: number | null;
  created_at: number;
  updated_at: number;
}

/** A parsed eval_items row. */
export interface Item {
  id: string;
  set: SetName;
  subjectRef: string;
  stratum: string;
  origin: 'sample' | 'shadow';
  shadowRunId: string | null;
  title: string;
  frozenAt: number;
  payload: ItemPayload;
  predictions: StoredPrediction[];
  promptVersion: string | null;
  expectedPersonIds: string[];
  label: StoredLabel | null;
  createdAt: number;
}

export function parseItem(r: ItemRow): Item {
  return {
    id: r.id,
    set: r.set_name,
    subjectRef: r.subject_ref,
    stratum: r.stratum,
    origin: r.origin,
    shadowRunId: r.shadow_run_id,
    title: r.title,
    frozenAt: r.frozen_at,
    payload: JSON.parse(r.payload) as ItemPayload,
    predictions: JSON.parse(r.predictions) as StoredPrediction[],
    promptVersion: r.prompt_version,
    expectedPersonIds: JSON.parse(r.expected_person_ids) as string[],
    label: r.label ? (JSON.parse(r.label) as StoredLabel) : null,
    createdAt: r.created_at,
  };
}

/** A new item, as a sampler builds it. */
export interface NewItem {
  set: SetName;
  subjectRef: string;
  stratum: string;
  title: string;
  frozenAt: number;
  payload: ItemPayload;
  predictions: StoredPrediction[];
  promptVersion: string | null;
  origin?: 'sample' | 'shadow';
  shadowRunId?: string | null;
}

/** An extraction claim in comparison form (shadow replays: both sides). */
export interface KeyedPrediction {
  kind: 'fact' | 'commitment' | 'needs_reply' | 'relation';
  cat: string;
  personId: string | null;
  key: string;
  value: string;
  /** Display label (local only). */
  label: string;
  conf: number | null;
  refs: string[];
}
