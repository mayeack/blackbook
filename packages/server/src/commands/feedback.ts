/**
 * The bridge from item verbs (done/snooze/skip/wrong/why/draft) to THE suggestion feedback entry point
 * (pipeline/suggestions/feedback.ts), plus the `undo` of a command's effect.
 *
 * Undo (PLAN/critic: bare `undo` reverts the last acknowledged command's effect; agent-run undo is web-only and
 * iMessage never cascades): each feedback the command gave is reverted by the suggestions module itself
 * (undoSuggestionFeedback: earlier status, the exact explicit reward, cooldowns, mutes and its journal batch);
 * then whatever else the command journaled in its run (log notes/interactions/facts, pause/resume settings) is
 * undone through the undo engine, without cascade. A suggestion the module never recorded feedback for (an older
 * feedback implementation) falls back to the command's own before-snapshot.
 */
import { uuidv7, type SuggestionFeedback, type SuggestionFeedbackResult, type WhyThis } from '@yb/shared';
import type { DB } from '../db/connection';
import { tx } from '../db/tx';
import { HttpError } from '../http/errors';
import { getRun } from '../journal/runs';
import { undoBatch, undoRun, UndoError } from '../journal/undo';
import { applySuggestionFeedback, undoSuggestionFeedback, whyThis, type FeedbackContext } from '../pipeline/suggestions/feedback';
import { lastEffect, type EffectRow, type SuggestionSnapshot } from './state';

export type FeedbackOutcome =
  | { ok: true; result: SuggestionFeedbackResult }
  | { ok: false; reason: 'not_available' | 'not_found' | 'conflict' | 'invalid' | 'error' };

export async function sendFeedback(db: DB, suggestionId: string, fb: SuggestionFeedback, ctx: FeedbackContext): Promise<FeedbackOutcome> {
  try {
    return { ok: true, result: await applySuggestionFeedback(db, suggestionId, fb, ctx) };
  } catch (e) {
    if (e instanceof HttpError) {
      if (e.status === 501) return { ok: false, reason: 'not_available' };
      if (e.status === 404) return { ok: false, reason: 'not_found' };
      if (e.status === 409) return { ok: false, reason: 'conflict' };
      if (e.status === 400) return { ok: false, reason: 'invalid' };
    }
    return { ok: false, reason: 'error' };
  }
}

/** whyThis without throwing (null when the suggestions module can't explain it yet). */
export function safeWhy(db: DB, suggestionId: string): WhyThis | null {
  try {
    return whyThis(db, suggestionId);
  } catch {
    return null;
  }
}

export type UndoOutcome =
  | { status: 'undone'; summary: string | null; undoRunId: string | null }
  | { status: 'nothing' }
  | { status: 'already'; summary: string | null }
  | { status: 'blocked'; reason: 'cascade' | 'conflict' | 'error' };

class Blocked extends Error {
  constructor(readonly reason: 'cascade' | 'conflict' | 'error') {
    super(reason);
  }
}

/** Reverts the effect of the most recent effectful command (sent before `at`). */
export function undoLastCommandEffect(db: DB, o: { at: number; now: number; byCommandId: string }): UndoOutcome {
  const e = lastEffect(db, o.at);
  if (!e) return { status: 'nothing' };
  if (e.undone_at !== null) return { status: 'already', summary: e.summary };
  try {
    return tx(db, () => revert(db, e, o));
  } catch (err) {
    if (err instanceof Blocked) return { status: 'blocked', reason: err.reason };
    throw err;
  }
}

/** Feedback rows (with an effect) the suggestions module recorded for this command. */
const EFFECT_ACTIONS = `('done','snooze','skip','dismiss','wrong','mute')`;

function revert(db: DB, e: EffectRow, o: { now: number; byCommandId: string }): UndoOutcome {
  let undoRunId: string | null = null;
  const reverted = new Set<string>();
  const rows = db
    .prepare(`SELECT id, suggestion_id FROM feedback WHERE inbound_command_id = ? AND suggestion_id IS NOT NULL AND action IN ${EFFECT_ACTIONS} ORDER BY created_at DESC`)
    .all(e.command_id) as { id: string; suggestion_id: string }[];
  for (const r of rows) {
    try {
      undoSuggestionFeedback(db, r.id, { now: o.now, channel: 'imessage' });
      reverted.add(r.suggestion_id);
    } catch (err) {
      if (err instanceof UndoError) throw new Blocked(err.code === 'CASCADE_REQUIRED' ? 'cascade' : err.code === 'CONFLICT' ? 'conflict' : 'error');
      if (err instanceof HttpError && err.status === 409) {
        reverted.add(r.suggestion_id); // already undone (from the web)
        continue;
      }
      throw err;
    }
  }
  const run = e.run_id ? getRun(db, e.run_id) : undefined;
  const liveInRun = run
    ? (db.prepare('SELECT count(*) FROM change_batches WHERE run_id = ? AND undone_at IS NULL AND undoable = 1').pluck().get(run.id) as number)
    : 0;
  try {
    if (run && liveInRun > 0 && run.undone_at === null) undoRunId = undoRun(db, run.id, { actor: 'user', now: o.now }).runId;
    const extra = (JSON.parse(e.batch_ids) as string[]).filter((id) => {
      const b = db.prepare('SELECT run_id, undone_at, undoable FROM change_batches WHERE id = ?').get(id) as
        | { run_id: string; undone_at: number | null; undoable: number }
        | undefined;
      return b && b.undone_at === null && b.undoable === 1 && b.run_id !== e.run_id;
    });
    for (const id of extra) undoBatch(db, id, { actor: 'user', now: o.now });
  } catch (err) {
    if (err instanceof UndoError) throw new Blocked(err.code === 'CASCADE_REQUIRED' ? 'cascade' : err.code === 'CONFLICT' ? 'conflict' : 'error');
    throw err;
  }

  const restore = db.prepare(
    `UPDATE suggestions SET status = @status, snoozed_until = @snoozed_until, acted_at = @acted_at, cooldown_until = @cooldown_until,
       updated_at = @now WHERE id = @id AND status = @after_status`,
  );
  const dropReward = db.prepare(`DELETE FROM suggestion_outcomes WHERE suggestion_id = ? AND source = 'explicit' AND decided_at >= ?`);
  const feedback = db.prepare(
    `INSERT INTO feedback (id, suggestion_id, subject_type, subject_id, action, payload, channel, inbound_command_id, created_at)
     VALUES (?, ?, 'suggestion', ?, 'undo', ?, 'imessage', ?, ?)`,
  );
  for (const s of JSON.parse(e.suggestions) as SuggestionSnapshot[]) {
    if (s.after_status === null || reverted.has(s.id)) continue;
    if (restore.run({ ...s, now: o.now }).changes) {
      dropReward.run(s.id, e.created_at);
      feedback.run(uuidv7(o.now), s.id, s.id, JSON.stringify({ reverts_command: e.command_id }), o.byCommandId, o.now);
    }
  }
  db.prepare('UPDATE command_effects SET undone_at = ?, undone_by_command_id = ?, updated_at = ? WHERE command_id = ?').run(
    o.now,
    o.byCommandId,
    o.now,
    e.command_id,
  );
  return { status: 'undone', summary: e.summary, undoRunId };
}
