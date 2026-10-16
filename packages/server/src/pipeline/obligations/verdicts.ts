/**
 * The extraction's `needs_reply` (intelligence §4.4) → reply debts. The extraction builder calls, per applied
 * window:
 *   recordNeedsReplyFromExtraction(t, input)  inside its window's journal batch: stores the verdict and applies it to
 *                                             the conversation's live debt at once (confirm / close), in that batch,
 *                                             so undoing the window undoes this too;
 *   recordNeedsReplyVerdict(db, input)        store only (the hourly pass applies it).
 * A verdict is "current" when it covers the conversation's last inbound message; only current verdicts suppress or
 * close. needs_reply ≥ 0.6 confirms (classifier 'llm'); no_reply_needed / already_replied ≥ 0.7 close. New debts
 * the verdict implies are created by the next hourly pass (the candidate rules still apply: age, outbound, …).
 * Nothing here stores message text.
 */
import type { DB } from '../../db/connection';
import type { JournalTx } from '../../journal/batch';
import { REPLY_DEBT } from './constants';
import { writeDebtClose, type DebtRow, type VerdictRow } from './replyDebt';
import type { DebtReason, Urgency } from './text';

export interface NeedsReplyInput {
  conversationId: string;
  /** The window's last NEW message id: the verdict describes the conversation as of this message. */
  throughMsgId: number;
  state: 'needs_reply' | 'no_reply_needed' | 'already_replied' | 'n_a';
  /** The message that needs the reply (`needs_reply.msg` "m:8812" resolved to 8812), or null. */
  msgId: number | null;
  reason: DebtReason | null;
  urgency: Urgency;
  /** 0–1 (out-of-range values are clamped; NaN is rejected). */
  confidence: number;
  windowId?: string | null;
  promptVersion?: string | null;
}

export type NeedsReplyOutcome =
  | { stored: false; reason: 'unknown_conversation' | 'unknown_message' | 'invalid' }
  | { stored: true; effect: 'confirmed' | 'dismissed' | 'replied' | 'none' };

const STATES = new Set(['needs_reply', 'no_reply_needed', 'already_replied', 'n_a']);
const REASONS = new Set(['question', 'request', 'invitation', 'plan_confirm', 'emotional', 'other']);
const URGENCIES = new Set(['low', 'normal', 'high']);

/** Validates and stores one verdict (idempotent per (conversation, through message)). */
export function recordNeedsReplyVerdict(db: DB, input: NeedsReplyInput, now: number = Date.now()): NeedsReplyOutcome & { verdict?: VerdictRow } {
  if (!STATES.has(input.state) || !Number.isFinite(input.confidence)) return { stored: false, reason: 'invalid' };
  if (db.prepare('SELECT 1 FROM conversations WHERE id = ?').pluck().get(input.conversationId) === undefined) {
    return { stored: false, reason: 'unknown_conversation' };
  }
  const through = db.prepare('SELECT sent_at FROM messages WHERE id = ? AND conversation_id = ?').get(input.throughMsgId, input.conversationId) as
    | { sent_at: number }
    | undefined;
  if (!through) return { stored: false, reason: 'unknown_message' };
  // The named message must be an inbound message of this conversation; otherwise the verdict stands without it.
  const msgOk =
    input.msgId !== null &&
    db.prepare('SELECT 1 FROM messages WHERE id = ? AND conversation_id = ? AND is_from_me = 0').pluck().get(input.msgId, input.conversationId) !== undefined;
  const verdict: VerdictRow = {
    conversation_id: input.conversationId,
    through_msg: input.throughMsgId,
    through_at: through.sent_at,
    state: input.state,
    msg_id: msgOk ? input.msgId : null,
    reason: input.reason && REASONS.has(input.reason) ? input.reason : null,
    urgency: URGENCIES.has(input.urgency) ? input.urgency : 'normal',
    confidence: Math.max(0, Math.min(1, input.confidence)),
    created_at: now,
  };
  db.prepare(
    `INSERT INTO reply_verdicts (conversation_id, through_msg, through_at, state, msg_id, reason, urgency, confidence, window_id, prompt_version, created_at)
     VALUES (@conversation_id, @through_msg, @through_at, @state, @msg_id, @reason, @urgency, @confidence, @window_id, @prompt_version, @created_at)
     ON CONFLICT (conversation_id, through_msg) DO UPDATE SET through_at = excluded.through_at, state = excluded.state, msg_id = excluded.msg_id,
       reason = excluded.reason, urgency = excluded.urgency, confidence = excluded.confidence, window_id = excluded.window_id,
       prompt_version = excluded.prompt_version, created_at = excluded.created_at`,
  ).run({ ...verdict, window_id: input.windowId ?? null, prompt_version: input.promptVersion ?? null });
  return { stored: true, effect: 'none', verdict };
}

/** What a current verdict does to a live debt (confirm, close or nothing), written through `t`. */
export function applyVerdict(t: JournalTx, d: DebtRow, v: VerdictRow): 'confirmed' | 'dismissed' | 'replied' | 'none' {
  const lastAt = (t.db.prepare('SELECT sent_at FROM messages WHERE id = ?').pluck().get(d.last_inbound_msg) as number | undefined) ?? d.asked_at;
  if (v.through_at < lastAt) return 'none';
  if (v.state === 'needs_reply' && v.confidence >= REPLY_DEBT.llmNeedsReplyMin) {
    const changed = t.update('reply_debts', { id: d.id }, {
      classifier: 'llm',
      confidence: v.confidence,
      llm_state: 'needs_reply',
      reason: v.reason ?? d.reason,
      urgency: v.urgency,
    });
    return changed ? 'confirmed' : 'none';
  }
  if (v.confidence < REPLY_DEBT.llmSuppressMin) return 'none';
  if (v.state === 'no_reply_needed') {
    return writeDebtClose(t, d, { status: 'dismissed', reason: 'no_reply_needed', byMsg: null }, { llm_state: 'no_reply_needed' }) ? 'dismissed' : 'none';
  }
  if (v.state === 'already_replied') {
    return writeDebtClose(t, d, { status: 'replied', reason: 'already_replied', byMsg: null }, { llm_state: 'already_replied' }) ? 'replied' : 'none';
  }
  return 'none';
}

/** Stores the verdict and applies it to the conversation's live debt inside the caller's journal batch. */
export function recordNeedsReplyFromExtraction(t: JournalTx, input: NeedsReplyInput): NeedsReplyOutcome {
  const r = recordNeedsReplyVerdict(t.db, input, t.now);
  if (!r.stored || !r.verdict) return r.stored ? { stored: true, effect: 'none' } : r;
  const live = t.db
    .prepare(`SELECT * FROM reply_debts WHERE conversation_id = ? AND status IN ('open','snoozed') ORDER BY asked_at DESC LIMIT 1`)
    .get(input.conversationId) as DebtRow | undefined;
  return { stored: true, effect: live ? applyVerdict(t, live, r.verdict) : 'none' };
}
