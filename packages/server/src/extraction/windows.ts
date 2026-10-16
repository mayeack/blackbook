/**
 * Windows (intelligence §4.1): which conversations are extracted, which of their messages are NEW, how NEW
 * messages are cut into session-aligned windows within a token budget, deterministic triage, and the windows /
 * extraction_coverage bookkeeping.
 *
 *   steady      NEW = uncovered messages sent at or after the conversation's steady_since_at (and before the run
 *               started), packed up to 4k tokens; overflow becomes the next wave's window (≤4 waves a night),
 *               then carries over to the next night. One in-flight steady window per conversation.
 *   historical  the one-time backfill: uncovered messages sent before steady_since_at, cut into independent
 *               conversation-month windows of ≤8k tokens (several per month when a month is bigger).
 *
 * Every NEW message is covered by exactly one window from the moment the window is created, so a message is
 * never extracted twice and never skipped (late arrivals included). Messages from people who must not reach the
 * model (excluded, hidden, service) stay covered but are never rendered (packet.ts); a DM with such a person is
 * skipped as a whole.
 */
import { uuidv7 } from '@yb/shared';
import type { DB } from '../db/connection';
import { tx } from '../db/tx';
import { DEFAULT_SESSION_RULES, SESSION_KINDS, splitSessions } from '../pipeline/sessionize';
import { DAY_MS, localMonth, type Env } from './env';
import { estimateTokens } from './prompt';
import { attachmentTokens, isTrivialMessage, lineText, MESSAGE_CHARS } from './text';

export type WindowMode = 'steady' | 'historical';

export const STEADY_NEW_BUDGET = 4000;
export const HISTORICAL_NEW_BUDGET = 8000;
export const MAX_WAVES = 4;
/** First steady run on a conversation with no backfill: this much recent history counts as NEW. */
export const STEADY_INITIAL_LOOKBACK_MS = 2 * DAY_MS;
/** Steady never reaches further back than this (older uncovered messages belong to the backfill). */
export const STEADY_MAX_LOOKBACK_MS = 35 * DAY_MS;
/** Groups larger than this are extracted only when ME takes part (posted, named, replied to, mentioned). */
export const LARGE_GROUP = 25;

const KIND_LIST = SESSION_KINDS.map((k) => `'${k}'`).join(',');

export interface ConvRow {
  id: string;
  source: string;
  kind: string;
  title: string | null;
  member_count: number | null;
  agent_excluded: number;
  summary: string | null;
  summary_through_msg: number | null;
  extract_cursor_msg: number | null;
}

export interface MsgRow {
  id: number;
  sent_at: number;
  is_from_me: number;
  sender_identity_id: string | null;
  kind: string;
  text: string | null;
  attachments: string | null;
  reply_to_msg_id: number | null;
}

export const MSG_COLUMNS = 'id, sent_at, is_from_me, sender_identity_id, kind, text, attachments, reply_to_msg_id';

export function getConversation(db: DB, id: string): ConvRow | null {
  return (
    (db
      .prepare(
        'SELECT id, source, kind, title, member_count, agent_excluded, summary, summary_through_msg, extract_cursor_msg FROM conversations WHERE id = ?',
      )
      .get(id) as ConvRow | undefined) ?? null
  );
}

// ---------------------------------------------------------------------------------------------- eligibility

export interface Eligibility {
  ok: boolean;
  reason: 'ok' | 'kind' | 'excluded' | 'counterpart' | 'no_people';
  chat: 'dm' | 'group';
  /** DM: the other (canonical) person. */
  counterpart: string | null;
  memberCount: number;
}

/** Canonical people in a conversation other than ME (roster + senders). */
export function conversationPeople(env: Env, conversationId: string): string[] {
  const ids = env.db
    .prepare(
      `SELECT identity_id FROM conversation_members WHERE conversation_id = ?
       UNION SELECT DISTINCT sender_identity_id FROM messages WHERE conversation_id = ? AND is_from_me = 0 AND sender_identity_id IS NOT NULL`,
    )
    .pluck()
    .all(conversationId, conversationId) as string[];
  const out = new Set<string>();
  for (const i of ids) {
    const p = env.personOfIdentity(i);
    if (p && p !== env.meId) out.add(p);
  }
  return [...out];
}

export function eligibility(env: Env, conv: ConvRow): Eligibility {
  const chat = conv.kind === 'group' ? 'group' : 'dm';
  const base = { chat, counterpart: null, memberCount: conv.member_count ?? 0 } as const;
  if (conv.kind !== 'direct' && conv.kind !== 'group') return { ...base, ok: false, reason: 'kind' };
  if (conv.agent_excluded === 1 || env.excludedConversations.has(conv.id)) return { ...base, ok: false, reason: 'excluded' };
  const people = conversationPeople(env, conv.id);
  if (!people.length) return { ...base, ok: false, reason: 'no_people' };
  if (chat === 'dm') {
    const counterpart = people[0]!;
    // A DM with anyone who must not reach the model (excluded, hidden, service, business) is skipped whole.
    if (people.length !== 1 || !env.usable(counterpart)) return { ...base, ok: false, reason: 'counterpart' };
    return { ok: true, reason: 'ok', chat, counterpart, memberCount: Math.max(2, conv.member_count ?? 2) };
  }
  if (!people.some((p) => env.usable(p))) return { ...base, ok: false, reason: 'no_people' };
  return { ok: true, reason: 'ok', chat, counterpart: null, memberCount: Math.max(conv.member_count ?? 0, people.length + 1) };
}

// ---------------------------------------------------------------------------------------------- conversation state

/** steady_since_at for a conversation, creating the state row on first use. */
export function steadySince(env: Env, conversationId: string, o: { backfillThroughAt?: number | null } = {}): number {
  const row = env.db.prepare('SELECT steady_since_at FROM extraction_conv_state WHERE conversation_id = ?').pluck().get(conversationId) as
    | number
    | undefined;
  if (row !== undefined) return row;
  // After (or during) a backfill, steady starts where history ended (never further back than the steady
  // horizon); without one, the last STEADY_INITIAL_LOOKBACK_MS of history counts as NEW.
  const floor = env.now - STEADY_MAX_LOOKBACK_MS;
  const since = o.backfillThroughAt != null ? Math.max(o.backfillThroughAt, floor) : env.now - STEADY_INITIAL_LOOKBACK_MS;
  env.db
    .prepare('INSERT INTO extraction_conv_state (conversation_id, steady_since_at, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING')
    .run(conversationId, since, env.now, env.now);
  return since;
}

/** The latest backfill's through_at (any status), or null when no backfill was ever started. */
export function backfillThroughAt(db: DB): number | null {
  return (db.prepare('SELECT through_at FROM extraction_backfill ORDER BY started_at DESC LIMIT 1').pluck().get() as number | undefined) ?? null;
}

// ---------------------------------------------------------------------------------------------- messages

/** Uncovered, extractable messages of a conversation in [from, before), oldest first. */
export function uncoveredMessages(db: DB, conversationId: string, range: { from?: number | null; before: number }): MsgRow[] {
  return db
    .prepare(
      `SELECT ${MSG_COLUMNS.split(', ').map((c) => `m.${c}`).join(', ')} FROM messages m
       WHERE m.conversation_id = ? AND m.sent_at >= ? AND m.sent_at < ?
         AND m.kind IN (${KIND_LIST}) AND m.is_bot = 0 AND m.dup_of IS NULL AND m.retracted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM extraction_coverage c WHERE c.message_id = m.id)
       ORDER BY m.sent_at, m.id`,
    )
    .all(conversationId, range.from ?? 0, range.before) as MsgRow[];
}

/** Conversations with uncovered extractable messages sent in [from, before). */
export function conversationsWithUncovered(db: DB, from: number, before: number): string[] {
  return db
    .prepare(
      `SELECT DISTINCT m.conversation_id FROM messages m
       WHERE m.sent_at >= ? AND m.sent_at < ? AND m.kind IN (${KIND_LIST}) AND m.is_bot = 0 AND m.dup_of IS NULL AND m.retracted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM extraction_coverage c WHERE c.message_id = m.id)`,
    )
    .pluck()
    .all(from, before) as string[];
}

// ---------------------------------------------------------------------------------------------- packing

/** Token cost of one rendered line (header + text + attachment tokens). */
export function messageTokens(m: Pick<MsgRow, 'text' | 'attachments'>): number {
  return estimateTokens(lineText(m.text, MESSAGE_CHARS)) + 12 + attachmentTokens(m.attachments).length * 2;
}

export interface PlannedWindow {
  messages: MsgRow[];
  tokens: number;
  /** Local YYYY-MM (historical windows). */
  month: string | null;
}

function chunkByBudget(msgs: MsgRow[], budget: number): MsgRow[][] {
  const out: MsgRow[][] = [];
  let cur: MsgRow[] = [];
  let tok = 0;
  for (const m of msgs) {
    const t = messageTokens(m);
    if (cur.length && tok + t > budget) {
      out.push(cur);
      cur = [];
      tok = 0;
    }
    cur.push(m);
    tok += t;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Session-aligned packing: whole sessions while they fit; an oversized session is cut by budget. */
export function packMessages(msgs: MsgRow[], o: { chat: 'dm' | 'group'; budget: number }): MsgRow[][] {
  const gap = o.chat === 'group' ? DEFAULT_SESSION_RULES.groupGapMs : DEFAULT_SESSION_RULES.dmGapMs;
  const out: MsgRow[][] = [];
  let cur: MsgRow[] = [];
  let tok = 0;
  const flush = () => {
    if (cur.length) out.push(cur);
    cur = [];
    tok = 0;
  };
  for (const session of splitSessions(msgs, gap)) {
    const st = session.reduce((n, m) => n + messageTokens(m), 0);
    if (st > o.budget) {
      flush();
      out.push(...chunkByBudget(session, o.budget));
      continue;
    }
    if (tok + st > o.budget) flush();
    cur.push(...session);
    tok += st;
  }
  flush();
  return out;
}

export function planWindows(msgs: MsgRow[], o: { mode: WindowMode; chat: 'dm' | 'group'; tz: string }): PlannedWindow[] {
  const tokensOf = (ms: MsgRow[]) => ms.reduce((n, m) => n + messageTokens(m), 0);
  if (o.mode === 'steady') {
    return packMessages(msgs, { chat: o.chat, budget: STEADY_NEW_BUDGET }).map((ms) => ({ messages: ms, tokens: tokensOf(ms), month: null }));
  }
  const byMonth = new Map<string, MsgRow[]>();
  for (const m of msgs) {
    const k = localMonth(m.sent_at, o.tz);
    let arr = byMonth.get(k);
    if (!arr) byMonth.set(k, (arr = []));
    arr.push(m);
  }
  const out: PlannedWindow[] = [];
  for (const [month, ms] of byMonth) {
    for (const chunk of packMessages(ms, { chat: o.chat, budget: HISTORICAL_NEW_BUDGET })) out.push({ messages: chunk, tokens: tokensOf(chunk), month });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- triage

export type TriageVerdict = { keep: true } | { keep: false; reason: 'trivial' | 'large_group' | 'no_usable_lines' };

const wordRe = (w: string) => new RegExp(`(?:^|[^\\p{L}])@?${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^\\p{L}])`, 'iu');

/**
 * Deterministic triage (no LLM): drop a window when every renderable NEW message is trivial; in groups larger
 * than LARGE_GROUP keep it only if ME posted, was named, was replied to or mentioned.
 */
export function triage(env: Env, msgs: MsgRow[], o: { chat: 'dm' | 'group'; memberCount: number }): TriageVerdict {
  const mine = (m: MsgRow) => m.is_from_me === 1 || (env.meId !== null && env.personOfIdentity(m.sender_identity_id) === env.meId);
  const renderable = msgs.filter((m) => mine(m) || env.usable(env.personOfIdentity(m.sender_identity_id)));
  if (!renderable.length) return { keep: false, reason: 'no_usable_lines' };
  if (renderable.every((m) => isTrivialMessage(m))) return { keep: false, reason: 'trivial' };
  if (o.chat === 'group' && o.memberCount > LARGE_GROUP) {
    const myIds = new Set<number>();
    const replyTargets = renderable.map((m) => m.reply_to_msg_id).filter((x): x is number => x !== null);
    if (replyTargets.length) {
      const rows = env.db
        .prepare(`SELECT id FROM messages WHERE is_from_me = 1 AND id IN (${replyTargets.map(() => '?').join(',')})`)
        .pluck()
        .all(...replyTargets) as number[];
      for (const r of rows) myIds.add(r);
    }
    const name = env.meFirstName?.trim();
    const named = name && name.length >= 2 ? wordRe(name) : null;
    const involved = renderable.some(
      (m) => mine(m) || (m.reply_to_msg_id !== null && myIds.has(m.reply_to_msg_id)) || (named !== null && named.test(m.text ?? '')),
    );
    if (!involved) return { keep: false, reason: 'large_group' };
  }
  return { keep: true };
}

// ---------------------------------------------------------------------------------------------- persistence

export type WindowStatus = 'pending' | 'triaged_out' | 'submitted' | 'applied' | 'refused' | 'dead_letter' | 'carried_over' | 'split';

export interface WindowRow {
  id: string;
  conversation_id: string;
  mode: WindowMode;
  from_msg: number;
  to_msg: number;
  context_from_msg: number | null;
  wave: number;
  status: WindowStatus;
  attempts: number;
  token_estimate: number | null;
  prompt_version: string | null;
  last_custom_id: string | null;
  created_at: number;
  updated_at: number;
}

export function getWindow(db: DB, id: string): WindowRow | null {
  return (db.prepare('SELECT * FROM windows WHERE id = ?').get(id) as WindowRow | undefined) ?? null;
}

/**
 * Creates a window over `messages` (all NEW, oldest first) and covers them. Reuses a carried-over row with the
 * same bounds (the UNIQUE key) instead of colliding with it.
 */
export function createWindow(
  db: DB,
  w: { conversationId: string; mode: WindowMode; messages: MsgRow[]; wave: number; status: 'pending' | 'triaged_out'; tokens: number; now: number },
): string {
  return tx(db, () => {
    const from = w.messages[0]!.id;
    const to = w.messages[w.messages.length - 1]!.id;
    const prior = db
      .prepare('SELECT id, status FROM windows WHERE conversation_id = ? AND mode = ? AND from_msg = ? AND to_msg = ?')
      .get(w.conversationId, w.mode, from, to) as { id: string; status: string } | undefined;
    let id: string;
    if (prior) {
      id = prior.id;
      db.prepare('UPDATE windows SET status = ?, wave = ?, token_estimate = ?, updated_at = ? WHERE id = ?').run(w.status, w.wave, w.tokens, w.now, id);
    } else {
      id = uuidv7(w.now);
      db.prepare(
        `INSERT INTO windows (id, conversation_id, mode, from_msg, to_msg, wave, status, attempts, token_estimate, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      ).run(id, w.conversationId, w.mode, from, to, w.wave, w.status, w.tokens, w.now, w.now);
    }
    // Never steals a message another window already owns (callers pass uncovered messages only).
    const cover = db.prepare('INSERT INTO extraction_coverage (message_id, window_id, created_at) VALUES (?, ?, ?) ON CONFLICT (message_id) DO NOTHING');
    for (const m of w.messages) cover.run(m.id, id, w.now);
    return id;
  });
}

/** Gives a window's messages back (not submitted tonight): they are re-windowed by a later run. */
export function carryOver(db: DB, windowId: string, now: number): void {
  tx(db, () => {
    db.prepare('DELETE FROM extraction_coverage WHERE window_id = ?').run(windowId);
    db.prepare('DELETE FROM extraction_packets WHERE window_id = ?').run(windowId);
    db.prepare(`UPDATE windows SET status = 'carried_over', updated_at = ? WHERE id = ?`).run(now, windowId);
  });
}

export function setWindowStatus(db: DB, windowId: string, status: WindowStatus, now: number, extra: { promptVersion?: string } = {}): void {
  db.prepare('UPDATE windows SET status = ?, updated_at = ?, prompt_version = coalesce(?, prompt_version) WHERE id = ?').run(
    status,
    now,
    extra.promptVersion ?? null,
    windowId,
  );
}

/** NEW messages of a window (from coverage), oldest first. */
export function windowMessages(db: DB, windowId: string): MsgRow[] {
  return db
    .prepare(
      `SELECT ${MSG_COLUMNS.split(', ').map((c) => `m.${c}`).join(', ')} FROM extraction_coverage c JOIN messages m ON m.id = c.message_id
       WHERE c.window_id = ? ORDER BY m.sent_at, m.id`,
    )
    .all(windowId) as MsgRow[];
}

/** Up to `n` messages before (sentAt, id) in a conversation, oldest first (CONTEXT). */
export function contextMessages(db: DB, conversationId: string, before: { sentAt: number; id: number }, n: number): MsgRow[] {
  const rows = db
    .prepare(
      `SELECT ${MSG_COLUMNS} FROM messages
       WHERE conversation_id = ? AND (sent_at < ? OR (sent_at = ? AND id < ?))
         AND kind IN (${KIND_LIST}) AND is_bot = 0 AND dup_of IS NULL AND retracted_at IS NULL
       ORDER BY sent_at DESC, id DESC LIMIT ?`,
    )
    .all(conversationId, before.sentAt, before.sentAt, before.id, n) as MsgRow[];
  return rows.reverse();
}

/** Splits a window's NEW messages at the largest time gap (max_tokens twice): two pending children. */
export function splitAtLargestGap(msgs: MsgRow[]): [MsgRow[], MsgRow[]] | null {
  if (msgs.length < 2) return null;
  let best = 1;
  let bestGap = -1;
  for (let i = 1; i < msgs.length; i++) {
    const g = msgs[i]!.sent_at - msgs[i - 1]!.sent_at;
    if (g > bestGap) {
      bestGap = g;
      best = i;
    }
  }
  return [msgs.slice(0, best), msgs.slice(best)];
}
