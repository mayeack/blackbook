/**
 * Bookkeeping for the executor (migration 015 tables + inbound_commands): claim/finish a command, its effect
 * record (what `undo` reverts), clarification state, and the per-hour limits.
 */
import { uuidv7 } from '@yb/shared';
import type { DB } from '../db/connection';
import { MAX_COMMANDS_PER_HOUR, MAX_OUTBOUND_PER_HOUR } from '../delivery/types';
import type { PreferenceKind } from '../pipeline/circles/preferences';

const HOUR = 3_600_000;
export const CLARIFY_TTL_MS = HOUR;

export type CommandStatus = 'pending' | 'handled' | 'error' | 'ignored' | 'seen_late' | 'clarifying';
export type EffectKind = 'none' | 'feedback' | 'log' | 'setting' | 'mixed';

export interface PendingCommand {
  id: string;
  message_id: number;
  raw_text: string;
  created_at: number;
}

export interface CommandParsed {
  v: 1;
  /** commands | free | empty | clarification */
  kind: string;
  verbs: string[];
  yb: boolean;
  /** Why it was ignored / failed (no text). */
  reason?: string;
  /** The reply as sent (local only), and the sender's outcome. */
  reply?: string | null;
  replyPurpose?: 'reply' | 'answer';
  replyStatus?: string | null;
  /** The intent parser answered (vs the deterministic path). */
  llm?: boolean;
  /** Screenshots that went to the intent parser with it. */
  images?: number;
  clarificationId?: string;
}

export function pendingCommands(db: DB, limit: number): PendingCommand[] {
  return db
    .prepare(
      `SELECT ic.id, ic.message_id, ic.raw_text, ic.created_at FROM inbound_commands ic JOIN messages m ON m.id = ic.message_id
       WHERE ic.status = 'pending' ORDER BY m.sent_at, m.id LIMIT ?`,
    )
    .all(limit) as PendingCommand[];
}

export const hasPending = (db: DB): boolean => db.prepare(`SELECT 1 FROM inbound_commands WHERE status = 'pending' LIMIT 1`).get() !== undefined;

export function finishCommand(
  db: DB,
  id: string,
  o: { status: CommandStatus; now: number; parsed: CommandParsed; intent?: string | null; digestId?: string | null; batchId?: string | null },
): void {
  db.prepare(
    `UPDATE inbound_commands SET status = ?, intent = coalesce(?, intent), parsed = ?, target_digest_id = coalesce(?, target_digest_id),
       batch_id = coalesce(?, batch_id), handled_at = ? WHERE id = ?`,
  ).run(o.status, o.intent ?? null, JSON.stringify(o.parsed), o.digestId ?? null, o.batchId ?? null, o.now, id);
}

export function setCommandStatus(db: DB, id: string, status: CommandStatus, now: number, reason?: string): void {
  db.prepare(
    `UPDATE inbound_commands SET status = ?, handled_at = ?,
       parsed = CASE WHEN ? IS NULL THEN parsed ELSE json_set(coalesce(parsed, '{}'), '$.reason', ?) END WHERE id = ?`,
  ).run(status, now, reason ?? null, reason ?? null, id);
}

export function recordReply(db: DB, id: string, outboundId: string | null, status: string): void {
  db.prepare(
    `UPDATE inbound_commands SET response_outbound_id = coalesce(?, response_outbound_id),
       parsed = json_set(coalesce(parsed, '{}'), '$.replyStatus', ?) WHERE id = ?`,
  ).run(outboundId, status, id);
}

// ---------------------------------------------------------------------------------------------- effects

export interface SuggestionSnapshot {
  id: string;
  status: string;
  snoozed_until: number | null;
  acted_at: number | null;
  cooldown_until: number | null;
  /** The status the command left it in (undo restores only if it is still that). */
  after_status: string | null;
}

export interface EffectRow {
  command_id: string;
  state: 'started' | 'done' | 'failed';
  effect: EffectKind;
  run_id: string | null;
  batch_ids: string;
  suggestions: string;
  summary: string | null;
  acked_at: number | null;
  undone_at: number | null;
  created_at: number;
}

export const effectState = (db: DB, commandId: string): EffectRow | undefined =>
  db.prepare('SELECT * FROM command_effects WHERE command_id = ?').get(commandId) as EffectRow | undefined;

export function startEffect(db: DB, commandId: string, now: number): void {
  db.prepare(`INSERT INTO command_effects (command_id, state, created_at, updated_at) VALUES (?, 'started', ?, ?)`).run(commandId, now, now);
}

export function finishEffect(
  db: DB,
  commandId: string,
  o: { state: 'done' | 'failed'; effect: EffectKind; runId: string | null; batchIds: string[]; suggestions: SuggestionSnapshot[]; summary: string | null; now: number },
): void {
  db.prepare(
    `UPDATE command_effects SET state = ?, effect = ?, run_id = ?, batch_ids = ?, suggestions = ?, summary = ?, updated_at = ? WHERE command_id = ?`,
  ).run(o.state, o.effect, o.runId, JSON.stringify([...new Set(o.batchIds)]), JSON.stringify(o.suggestions), o.summary, o.now, commandId);
}

export function markAcked(db: DB, commandId: string, now: number): void {
  db.prepare('UPDATE command_effects SET acked_at = coalesce(acked_at, ?), updated_at = ? WHERE command_id = ?').run(now, now, commandId);
}

/** The most recent command that changed something (what a bare `undo` reverts). */
export function lastEffect(db: DB, before: number): EffectRow | undefined {
  return db
    .prepare(`SELECT * FROM command_effects WHERE state = 'done' AND effect <> 'none' AND created_at <= ? ORDER BY created_at DESC, command_id DESC LIMIT 1`)
    .get(before) as EffectRow | undefined;
}

export function snapshotSuggestion(db: DB, id: string): Omit<SuggestionSnapshot, 'after_status'> | undefined {
  return db.prepare('SELECT id, status, snoozed_until, acted_at, cooldown_until FROM suggestions WHERE id = ?').get(id) as
    | Omit<SuggestionSnapshot, 'after_status'>
    | undefined;
}

// ---------------------------------------------------------------------------------------------- clarifications

export interface ClarifyOption {
  personId: string;
  label: string;
}

export interface ClarifyPayload {
  text: string;
  kind: string;
  at: number;
  date: string;
  /** Interaction or facts only (add_fact). */
  interaction: boolean;
  resolved: string[];
  /** The mention being asked about now. */
  surface: string;
  /** Further ambiguous mentions, asked one at a time. */
  pending: { surface: string; options: ClarifyOption[] }[];
  facts: { personId: string; cat: string; value: string }[];
  unresolved: string[];
  llm: boolean;
  /** Standing preferences (set_preference); personId null = the ambiguous `surface`, settled by the clarification. */
  prefs?: { personId: string | null; surface: string; kind: PreferenceKind }[];
  /** People this command added (from a screenshot), for the reply. */
  created?: string[];
}

export interface ClarificationRow {
  id: string;
  command_id: string;
  options: ClarifyOption[];
  payload: ClarifyPayload;
  expires_at: number;
  created_at: number;
}

export function openClarification(db: DB, at: number): ClarificationRow | null {
  const r = db
    .prepare(`SELECT * FROM command_clarifications WHERE status = 'open' AND expires_at > ? AND created_at <= ? ORDER BY created_at DESC LIMIT 1`)
    .get(at, at + 60_000) as { id: string; command_id: string; options: string; payload: string; expires_at: number; created_at: number } | undefined;
  return r ? { ...r, options: JSON.parse(r.options) as ClarifyOption[], payload: JSON.parse(r.payload) as ClarifyPayload } : null;
}

/** Opens a clarification. Any older open one is superseded, and the `log:` it was asking about is dropped. */
export function createClarification(db: DB, commandId: string, options: ClarifyOption[], payload: ClarifyPayload, now: number): string {
  const older = db.prepare(`SELECT id, command_id FROM command_clarifications WHERE status = 'open'`).all() as { id: string; command_id: string }[];
  for (const o of older) {
    db.prepare(`UPDATE command_clarifications SET status = 'superseded', updated_at = ? WHERE id = ?`).run(now, o.id);
    if (o.command_id !== commandId) {
      db.prepare(
        `UPDATE inbound_commands SET status = 'ignored', parsed = json_set(coalesce(parsed, '{}'), '$.reason', 'clarification_superseded')
         WHERE id = ? AND status = 'clarifying'`,
      ).run(o.command_id);
    }
  }
  const id = uuidv7(now);
  db.prepare(
    `INSERT INTO command_clarifications (id, command_id, kind, options, payload, status, expires_at, created_at, updated_at)
     VALUES (?, ?, 'log_person', ?, ?, 'open', ?, ?, ?)`,
  ).run(id, commandId, JSON.stringify(options), JSON.stringify(payload), now + CLARIFY_TTL_MS, now, now);
  return id;
}

export function closeClarification(db: DB, id: string, status: 'resolved' | 'cancelled' | 'expired', now: number, byCommandId: string | null): void {
  db.prepare(`UPDATE command_clarifications SET status = ?, resolved_by_command_id = ?, updated_at = ? WHERE id = ?`).run(status, byCommandId, now, id);
}

/** Open clarifications past their hour: closed, and the command that asked is left 'ignored'. */
export function expireClarifications(db: DB, now: number): number {
  const rows = db.prepare(`SELECT id, command_id FROM command_clarifications WHERE status = 'open' AND expires_at <= ?`).all(now) as {
    id: string;
    command_id: string;
  }[];
  for (const r of rows) {
    closeClarification(db, r.id, 'expired', now, null);
    db.prepare(
      `UPDATE inbound_commands SET status = 'ignored', parsed = json_set(coalesce(parsed, '{}'), '$.reason', 'clarification_expired')
       WHERE id = ? AND status = 'clarifying'`,
    ).run(r.command_id);
  }
  return rows.length;
}

// ---------------------------------------------------------------------------------------------- limits

/** Commands acted on in the hour before `now` (ignored notes-to-self don't count). */
export function commandsLastHour(db: DB, now: number): number {
  return db
    .prepare(`SELECT count(*) FROM inbound_commands WHERE status IN ('handled','clarifying','error','seen_late') AND handled_at > ? AND handled_at <= ?`)
    .pluck()
    .get(now - HOUR, now) as number;
}

export const commandLimitReached = (db: DB, now: number): boolean => commandsLastHour(db, now) >= MAX_COMMANDS_PER_HOUR;

/** Whether a "slow down" notice already went out this hour. */
export function rateNoticeSent(db: DB, now: number): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM inbound_commands WHERE json_extract(parsed, '$.reason') = 'rate_limited' AND response_outbound_id IS NOT NULL
         AND handled_at > ? LIMIT 1`,
      )
      .get(now - HOUR) !== undefined
  );
}

/** The outbound circuit breaker (the sender enforces it too): > MAX_OUTBOUND_PER_HOUR in the last hour. */
export function outboundCircuitOpen(db: DB, now: number): boolean {
  const n = db.prepare('SELECT count(*) FROM outbound_messages WHERE created_at > ?').pluck().get(now - HOUR) as number;
  return n >= MAX_OUTBOUND_PER_HOUR;
}

/** Replies that were composed but never handed to the sender (a crash between the two), recent ones only. */
export function unsentReplies(db: DB, now: number): { id: string; reply: string; purpose: 'reply' | 'answer' }[] {
  return (
    db
      .prepare(
        `SELECT id, json_extract(parsed, '$.reply') AS reply, coalesce(json_extract(parsed, '$.replyPurpose'), 'reply') AS purpose
         FROM inbound_commands WHERE status <> 'pending' AND handled_at > ? AND response_outbound_id IS NULL
           AND json_extract(parsed, '$.reply') IS NOT NULL AND json_extract(parsed, '$.replyStatus') IS NULL`,
      )
      .all(now - 15 * 60_000) as { id: string; reply: string; purpose: 'reply' | 'answer' }[]
  );
}
