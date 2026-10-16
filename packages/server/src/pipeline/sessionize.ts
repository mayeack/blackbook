/**
 * Sessions (intelligence §4.1): per conversation, a gap of more than 2 h (1:1) or 1 h (group) starts a new session,
 * and a session is hard-split at 400 messages or 12 h. Derived table: recomputed incrementally from the last
 * session that starts at or before the earliest touched message, so re-running is a no-op and a late message
 * re-splits only the tail. Session ids are `<conversation>:<first message id>`, stable while the start is.
 * Self threads, business chats and bot rows are not sessionized (they never become interactions).
 */
import type { DB } from '../db/connection';
import { tx } from '../db/tx';

const HOUR = 3_600_000;

type ConversationKind = 'direct' | 'group' | 'self' | 'business' | 'broadcast';

export interface SessionRules {
  dmGapMs: number;
  groupGapMs: number;
  maxMessages: number;
  maxSpanMs: number;
}

export const DEFAULT_SESSION_RULES: SessionRules = { dmGapMs: 2 * HOUR, groupGapMs: HOUR, maxMessages: 400, maxSpanMs: 12 * HOUR };

/** Message kinds that make up conversation activity (system rows, group events and reactions don't). */
export const SESSION_KINDS = ['text', 'attachment', 'link', 'poll', 'sticker'] as const;
const KIND_LIST = SESSION_KINDS.map((k) => `'${k}'`).join(',');

export interface SessionMessage {
  id: number;
  sent_at: number;
  is_from_me: number;
  sender_identity_id: string | null;
}

export interface ComputedSession {
  id: string;
  conversation_id: string;
  started_at: number;
  ended_at: number;
  first_msg: number;
  last_msg: number;
  msg_count: number;
  initiated_by_me: number;
  messages: SessionMessage[];
}

/** Splits time-ordered messages into sessions (pure). */
export function splitSessions<T extends { sent_at: number }>(msgs: readonly T[], gapMs: number, rules: SessionRules = DEFAULT_SESSION_RULES): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  for (const m of msgs) {
    const first = cur[0];
    const last = cur[cur.length - 1];
    if (first && last && (m.sent_at - last.sent_at > gapMs || cur.length >= rules.maxMessages || m.sent_at - first.sent_at > rules.maxSpanMs)) {
      out.push(cur);
      cur = [];
    }
    cur.push(m);
  }
  if (cur.length) out.push(cur);
  return out;
}

export interface SessionizeResult {
  conversationId: string;
  /** null: not a sessionized conversation (self thread, business chat); any old sessions were removed. */
  kind: 'direct' | 'group' | null;
  /** Every session in the recomputed range (changed or not), oldest first. */
  sessions: ComputedSession[];
  changed: string[];
  removed: string[];
}

interface SessionRow {
  id: string;
  started_at: number;
  ended_at: number;
  first_msg: number;
  last_msg: number;
  msg_count: number;
  initiated_by_me: number;
}

const sameSession = (a: SessionRow, b: ComputedSession) =>
  a.started_at === b.started_at &&
  a.ended_at === b.ended_at &&
  a.first_msg === b.first_msg &&
  a.last_msg === b.last_msg &&
  a.msg_count === b.msg_count &&
  a.initiated_by_me === b.initiated_by_me;

/** Recomputes one conversation's sessions from the session containing `fromSentAt` (null = from the start). */
export function sessionizeConversation(
  db: DB,
  conversationId: string,
  o: { fromSentAt?: number | null; rules?: SessionRules } = {},
): SessionizeResult {
  const rules = o.rules ?? DEFAULT_SESSION_RULES;
  return tx(db, () => {
    const conv = db.prepare('SELECT kind FROM conversations WHERE id = ?').get(conversationId) as { kind: ConversationKind } | undefined;
    if (!conv || (conv.kind !== 'direct' && conv.kind !== 'group')) {
      const removed = db.prepare('SELECT id FROM sessions WHERE conversation_id = ?').pluck().all(conversationId) as string[];
      db.prepare('DELETE FROM sessions WHERE conversation_id = ?').run(conversationId);
      return { conversationId, kind: null, sessions: [], changed: [], removed };
    }
    const kind: 'direct' | 'group' = conv.kind;
    const anchor =
      o.fromSentAt == null
        ? undefined
        : (db
            .prepare(
              `SELECT started_at, first_msg FROM sessions WHERE conversation_id = ? AND started_at <= ?
               ORDER BY started_at DESC, first_msg DESC LIMIT 1`,
            )
            .get(conversationId, o.fromSentAt) as { started_at: number; first_msg: number } | undefined);
    const range = anchor ? 'AND (sent_at, id) >= (@startedAt, @firstMsg)' : '';
    const params = { conv: conversationId, startedAt: anchor?.started_at ?? 0, firstMsg: anchor?.first_msg ?? 0 };
    const msgs = db
      .prepare(
        `SELECT id, sent_at, is_from_me, sender_identity_id FROM messages
         WHERE conversation_id = @conv AND kind IN (${KIND_LIST}) AND is_bot = 0 AND dup_of IS NULL ${range}
         ORDER BY sent_at, id`,
      )
      .all(params) as SessionMessage[];
    const existing = db
      .prepare(
        `SELECT id, started_at, ended_at, first_msg, last_msg, msg_count, initiated_by_me FROM sessions
         WHERE conversation_id = @conv ${anchor ? 'AND (started_at, first_msg) >= (@startedAt, @firstMsg)' : ''}`,
      )
      .all(params) as SessionRow[];

    const sessions: ComputedSession[] = splitSessions(msgs, kind === 'group' ? rules.groupGapMs : rules.dmGapMs, rules).map((s) => {
      const first = s[0]!;
      const last = s[s.length - 1]!;
      return {
        id: `${conversationId}:${first.id}`,
        conversation_id: conversationId,
        started_at: first.sent_at,
        ended_at: last.sent_at,
        first_msg: first.id,
        last_msg: last.id,
        msg_count: s.length,
        initiated_by_me: first.is_from_me ? 1 : 0,
        messages: s,
      };
    });

    const byId = new Map(existing.map((s) => [s.id, s]));
    const upsert = db.prepare(
      `INSERT INTO sessions (id, conversation_id, started_at, ended_at, first_msg, last_msg, msg_count, initiated_by_me)
       VALUES (@id, @conversation_id, @started_at, @ended_at, @first_msg, @last_msg, @msg_count, @initiated_by_me)
       ON CONFLICT (id) DO UPDATE SET started_at = excluded.started_at, ended_at = excluded.ended_at, first_msg = excluded.first_msg,
         last_msg = excluded.last_msg, msg_count = excluded.msg_count, initiated_by_me = excluded.initiated_by_me`,
    );
    const changed: string[] = [];
    for (const s of sessions) {
      const prev = byId.get(s.id);
      byId.delete(s.id);
      if (prev && sameSession(prev, s)) continue;
      const { messages: _messages, ...row } = s;
      upsert.run(row);
      changed.push(s.id);
    }
    const removed = [...byId.keys()];
    const del = db.prepare('DELETE FROM sessions WHERE id = ?');
    for (const id of removed) del.run(id);
    return { conversationId, kind, sessions, changed, removed };
  });
}
