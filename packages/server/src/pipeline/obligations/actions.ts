/**
 * Feedback hooks on open loops (POST /loops/:type/:id, the `done N` / `snooze N 2w` self-thread commands, digest
 * cards of kind reply_debt / commitment_due). Every effect is one journaled batch (actor user), undoable from Today:
 *
 *   action    reply_debt                           commitment
 *   done      replied   (closed_reason 'done')     done      (closed_reason 'done'; also confirms an auto-close)
 *   snooze    snoozed until `until`                snoozed until `until` (wakes as open or due)
 *   dismiss   dismissed ('no_reply_needed')        cancelled ('dismissed')
 *   wrong     retracted ('wrong': eval label)      retracted ('wrong')
 *
 * A feedback row (subject_type/subject_id, no suggestion id) records the action for the eval labels, unless the
 * caller already recorded one (the suggestions feedback path passes recordFeedback: false). Rewards for the learner
 * are the suggestions stage's job; it reads these closes through suggestions.reply_debt_id / commitment_id.
 */
import { uuidv7 } from '@yb/shared';
import type { BatchRef, LoopAction, OpenLoopType } from '@yb/shared';
import type { DB } from '../../db/connection';
import { tx } from '../../db/tx';
import { HttpError, notFound } from '../../http/errors';
import { withBatch, type Actor } from '../../journal/batch';
import { finishRun, startRun } from '../../journal/runs';
import type { FeedbackChannel } from '../suggestions/types';
import { LIVE_COMMITMENT, LIVE_DEBT } from './constants';
import { canonical, isVisible } from './signals';

export interface LoopActionContext {
  actor?: Actor;
  channel: FeedbackChannel;
  now?: number;
  /** Join an existing run (commands open one per command); else a 'user' / 'command' run is opened. */
  runId?: string | null;
  inboundCommandId?: string | null;
  /** Default true. */
  recordFeedback?: boolean;
}

export interface LoopActionResult extends BatchRef {
  type: OpenLoopType;
  id: string;
  /** Status after the action. */
  status: string;
  personId: string;
}

const TABLE = { reply_debt: 'reply_debts', commitment: 'commitments' } as const;

interface LoopRow {
  id: string;
  person_id: string;
  status: string;
}

function patchFor(type: OpenLoopType, row: LoopRow, action: LoopAction, now: number): { patch: Record<string, unknown>; title: string } | null {
  const live = (type === 'reply_debt' ? (LIVE_DEBT as readonly string[]) : (LIVE_COMMITMENT as readonly string[])).includes(row.status);
  const close = (status: string, reason: string) => ({ status, closed_at: now, closed_reason: reason, snoozed_until: null });
  switch (action.action) {
    case 'done':
      if (type === 'reply_debt') return live ? { patch: { ...close('replied', 'done'), closed_by_msg: null }, title: 'Marked a reply as done' } : null;
      if (live || row.status === 'auto_closed' || row.status === 'lapsed') return { patch: close('done', 'done'), title: 'Marked a promise as done' };
      return null;
    case 'snooze':
      if (!live) throw new HttpError(409, 'LOOP_CLOSED', 'That one is already closed.');
      if (!Number.isFinite(action.until) || action.until <= now) throw new HttpError(400, 'BAD_REQUEST', 'Snooze until a time in the future.');
      return { patch: { status: 'snoozed', snoozed_until: action.until }, title: type === 'reply_debt' ? 'Snoozed a reply' : 'Snoozed a promise' };
    case 'dismiss':
      if (!live) return null;
      return type === 'reply_debt'
        ? { patch: { ...close('dismissed', 'no_reply_needed'), closed_by_msg: null }, title: 'No reply needed' }
        : { patch: close('cancelled', 'dismissed'), title: 'Dropped a promise' };
    case 'wrong':
      if (row.status === 'retracted') return null;
      return { patch: { ...close('retracted', 'wrong'), ...(type === 'reply_debt' ? { closed_by_msg: null } : {}) }, title: type === 'reply_debt' ? 'Not a reply you owe' : 'Not a real promise' };
  }
}

const FEEDBACK_ACTION = { done: 'done', snooze: 'snooze', dismiss: 'dismiss', wrong: 'wrong' } as const;

/**
 * Applies one LoopAction. 404 when the loop doesn't exist or its person isn't visible; 409 snoozing a closed loop;
 * a no-op (already in that state) answers batchId null.
 */
export function applyLoopAction(db: DB, type: OpenLoopType, id: string, action: LoopAction, ctx: LoopActionContext): LoopActionResult {
  if (!(type in TABLE)) throw notFound('Open loop');
  const now = ctx.now ?? Date.now();
  const table = TABLE[type];
  return tx(db, () => {
    const row = db.prepare(`SELECT id, person_id, status FROM ${table} WHERE id = ?`).get(id) as LoopRow | undefined;
    if (!row) throw notFound('Open loop');
    const personId = canonical(db, row.person_id);
    if (!isVisible(db, personId)) throw notFound('Open loop');
    const change = patchFor(type, row, action, now);
    if (change && ctx.recordFeedback !== false) {
      db.prepare(
        `INSERT INTO feedback (id, suggestion_id, subject_type, subject_id, action, payload, channel, inbound_command_id, created_at)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        uuidv7(now),
        type,
        id,
        FEEDBACK_ACTION[action.action],
        action.action === 'snooze' ? JSON.stringify({ until: action.until }) : null,
        ctx.channel,
        ctx.inboundCommandId ?? null,
        now,
      );
    }
    if (!change) return { batchId: null, type, id, status: row.status, personId };
    const ownRun = !ctx.runId;
    const runId = ctx.runId ?? startRun(db, ctx.channel === 'imessage' ? 'command' : 'user', { now });
    const r = withBatch(
      db,
      { runId, kind: type, title: change.title, subjectPersonId: personId, actor: ctx.actor ?? 'user' },
      (t) => t.update(table, { id }, change.patch),
      { now },
    );
    if (ownRun) finishRun(db, runId, 'ok', { now });
    const status = (db.prepare(`SELECT status FROM ${table} WHERE id = ?`).pluck().get(id) as string) ?? row.status;
    return { batchId: r.changes ? r.batchId : null, type, id, status, personId };
  });
}

/**
 * The suggestions feedback path's hook: a digest item of kind reply_debt / commitment_due got done / snooze /
 * dismiss / wrong (skip leaves the loop as it is). Looks the loop up through the suggestion's link columns; null
 * when the suggestion carries no loop or the action doesn't touch it.
 */
export function loopFeedbackFromSuggestion(
  db: DB,
  suggestionId: string,
  action: 'done' | 'snooze' | 'skip' | 'dismiss' | 'wrong',
  ctx: LoopActionContext & { until?: number },
): LoopActionResult | null {
  if (action === 'skip') return null;
  const s = db.prepare('SELECT kind, reply_debt_id, commitment_id FROM suggestions WHERE id = ?').get(suggestionId) as
    | { kind: string; reply_debt_id: string | null; commitment_id: string | null }
    | undefined;
  if (!s) return null;
  const ref: { type: OpenLoopType; id: string } | null = s.reply_debt_id
    ? { type: 'reply_debt', id: s.reply_debt_id }
    : s.commitment_id
      ? { type: 'commitment', id: s.commitment_id }
      : null;
  if (!ref) return null;
  const loopAction: LoopAction =
    action === 'snooze' ? { action: 'snooze', until: ctx.until ?? (ctx.now ?? Date.now()) + 7 * 86_400_000 } : { action };
  try {
    return applyLoopAction(db, ref.type, ref.id, loopAction, { recordFeedback: false, ...ctx });
  } catch (e) {
    // The loop closed meanwhile (e.g. you replied before snoozing the card): the suggestion feedback still stands.
    if (e instanceof HttpError && (e.status === 404 || e.status === 409)) return null;
    throw e;
  }
}
