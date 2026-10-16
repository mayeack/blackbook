/**
 * Source-agnostic episode writing for the Beeper, WhatsApp, Instagram-export and Partiful adapters. Episodes are
 * append-only, idempotent on a natural key and never journaled (PLAN "Three table classes"); the rules are the
 * iMessage ingest's, generalized:
 *   conversations  (source, source_conv_id); title, member count and the message time range only move forward
 *   members        (conversation, identity); a current roster or a post after left_at reactivates a member, and
 *                  my own identities never become members
 *   messages       (source, source_msg_id) + content_key; re-reads never blank text a source already gave, edits
 *                  and retractions are sticky; quoted replies link now or once the target lands
 *   reactions      folded onto their message; one whose target hasn't arrived is parked in pending_reactions and
 *                  applied by resolvePendingReactions() (call it after each page)
 * touchConversation() + refresh() re-sessionize what changed and re-derive interactions (pipeline/).
 * The caller owns the transaction (one page = one tx). Never logs content: stats are counts only.
 */
import { uuidv7 } from '@yb/shared';
import type { Statement } from 'better-sqlite3';
import type { DB } from '../../db/connection';
import { refreshConversations, type RefreshResult } from '../../pipeline/interactions';
import type { SessionRules } from '../../pipeline/sessionize';
import { contentKey } from '../imessage/mapping';
import { readCursor, writeCursor } from './cursors';

export type ConversationKind = 'direct' | 'group' | 'self' | 'business' | 'broadcast';
export type EpisodeMessageKind = 'text' | 'attachment' | 'system' | 'group_event' | 'poll' | 'sticker' | 'link';
export type MemberSource = 'roster' | 'group_event' | 'sender';
export type TextSource = 'text' | 'attributedBody' | 'none' | 'other';

export interface ConversationInput {
  source: string;
  sourceConvId: string;
  kind: ConversationKind;
  title?: string | null;
  /** conversations.title_source when the title changes (default 'chat'). */
  titleSource?: string;
  memberCount?: number | null;
  firstAt?: number | null;
  lastAt?: number | null;
}

export interface ConversationResult {
  id: string;
  created: boolean;
  kind: ConversationKind;
}

export interface MemberInput {
  source: MemberSource;
  /** When the membership was observed (roster fetch time, message time). */
  at: number;
  role?: string | null;
  /** false: the source says the member has left (an inactive roster row). Default true. */
  isActive?: boolean;
  joinedAt?: number | null;
  leftAt?: number | null;
}

export interface MessageInput {
  source: string;
  /** Natural key within the source: Beeper message id, `{jid}:{stanza}`, DYI hash, … */
  sourceMsgId: string;
  conversationId: string;
  /** null for my own messages and for senders the source can't identify. */
  senderIdentityId: string | null;
  isFromMe: boolean;
  sentAt: number;
  kind: EpisodeMessageKind;
  text: string | null;
  textSource?: TextSource;
  /** Source id of the quoted / replied-to message (same source). */
  replyToSourceId?: string | null;
  threadRootSourceId?: string | null;
  /** undefined keeps what is stored; [] or null clears. */
  attachments?: readonly unknown[] | null;
  editedAt?: number | null;
  retractedAt?: number | null;
  service?: string | null;
  isSpam?: boolean;
  isBot?: boolean;
  /** Where the row came from, for debugging (`zpk:123`, `page:4`); never content. */
  sourceRowRef?: string | null;
}

export interface MessageResult {
  id: number;
  created: boolean;
  updated: boolean;
}

export interface ReactionInput {
  source: string;
  sourceReactionId: string;
  targetSourceMsgId: string;
  actorIdentityId: string | null;
  isFromMe: boolean;
  /** 'like', 'love', 'emoji', … (sources without types use 'emoji' + emoji). */
  type: string;
  emoji?: string | null;
  /**
   * A removal: un-reacts the reaction with this id, or (sources that send removals as their own events) the
   * matching earlier reaction by the same actor on the same message.
   */
  removal?: boolean;
  at: number;
}

export type ReactionOutcome = 'stored' | 'updated' | 'removed' | 'parked' | 'unchanged';

export type MembershipAction = 'add' | 'remove' | 'leave' | 'rename';

export interface MembershipEventInput {
  conversationId: string;
  action: MembershipAction;
  /** The member added / removed / leaving (null for renames, or my own leave). */
  identityId: string | null;
  actorIdentityId?: string | null;
  newTitle?: string | null;
  at: number;
  messageId?: number | null;
}

export interface EpisodeStats {
  conversations_new: number;
  conversations_updated: number;
  members_upserted: number;
  members_left: number;
  messages_new: number;
  messages_updated: number;
  replies_linked: number;
  reactions: number;
  reactions_updated: number;
  reactions_removed: number;
  reactions_pending: number;
  reactions_resolved: number;
  reactions_expired: number;
  membership_events: number;
  sessions_changed: number;
  interactions_upserted: number;
  interactions_deleted: number;
}

const emptyStats = (): EpisodeStats => ({
  conversations_new: 0,
  conversations_updated: 0,
  members_upserted: 0,
  members_left: 0,
  messages_new: 0,
  messages_updated: 0,
  replies_linked: 0,
  reactions: 0,
  reactions_updated: 0,
  reactions_removed: 0,
  reactions_pending: 0,
  reactions_resolved: 0,
  reactions_expired: 0,
  membership_events: 0,
  sessions_changed: 0,
  interactions_upserted: 0,
  interactions_deleted: 0,
});

/** The non-zero counters (job_runs.stats). */
export const nonZeroStats = (s: object): Record<string, number> =>
  Object.fromEntries(Object.entries(s).filter((e): e is [string, number] => typeof e[1] === 'number' && e[1] !== 0));

/**
 * message_reactions.source_reaction_id is one key space across sources. iMessage keeps its bare chat.db guids;
 * every other source is namespaced "<source>:<id>".
 */
export const reactionKey = (source: string, id: string): string => (source === 'imessage' ? id : `${source}:${id}`);

/** The source's 'sessionized' cursor: messages with a larger id haven't been through refresh() yet. */
export const SESSIONIZED_SCOPE = 'sessionized';

const blankToNull = (s: string | null | undefined): string | null => (s?.trim() ? s.trim() : null);

/** SQL (inside upsertMember): this sighting means a member marked as left is in the chat again. */
const REJOINS = `conversation_members.is_active = 0 AND (@source = 'roster'
  OR (@source = 'sender' AND excluded.last_seen_at > coalesce(conversation_members.left_at, 0)))`;

interface ConversationRow {
  id: string;
  kind: ConversationKind;
  title: string | null;
  member_count: number | null;
  first_message_at: number | null;
  last_message_at: number | null;
}

interface MessageRow {
  id: number;
  sender_identity_id: string | null;
  text: string | null;
  text_source: string | null;
  edited_at: number | null;
  retracted_at: number | null;
  kind: string;
  is_bot: number;
  is_spam: number;
  attachments: string | null;
  content_key: string | null;
  reply_to_msg_id: number | null;
  reply_to_source_id: string | null;
  thread_root_source_id: string | null;
}

interface PendingRow {
  source_reaction_id: string;
  source: string;
  target_source_msg_id: string;
  actor_identity_id: string | null;
  is_from_me: number;
  type: string;
  emoji: string | null;
  removal: number;
  at: number;
}

export class EpisodeWriter {
  readonly stats = emptyStats();
  readonly now: number;
  private readonly statements = new Map<string, Statement>();
  private readonly touched = new Map<string, number | null>();
  private readonly sources = new Set<string>();
  private readonly convKinds = new Map<string, ConversationKind>();
  private readonly meCache = new Map<string, boolean>();

  constructor(
    readonly db: DB,
    o: { now?: number; meIdentityIds?: Iterable<string> } = {},
  ) {
    this.now = o.now ?? Date.now();
    for (const id of o.meIdentityIds ?? []) this.meCache.set(id, true);
  }

  /** Prepared-statement cache: a backfill runs the same few statements many thousand times. */
  private q(sql: string): Statement {
    let st = this.statements.get(sql);
    if (!st) this.statements.set(sql, (st = this.db.prepare(sql)));
    return st;
  }

  /** An identity bound to the 'me' person (identities not inserted yet, inside a deferred-FK page, are not). */
  isMe(identityId: string): boolean {
    let v = this.meCache.get(identityId);
    if (v === undefined) {
      v = this.q(`SELECT 1 FROM identities i JOIN people p ON p.id = i.person_id WHERE i.id = ? AND p.kind = 'me'`).get(identityId) !== undefined;
      this.meCache.set(identityId, v);
    }
    return v;
  }

  // ---------- conversations & members ----------

  /** Inserts or updates the conversation (changed columns only) and returns its id. */
  upsertConversation(c: ConversationInput): ConversationResult {
    const cur = this.q(
      'SELECT id, kind, title, member_count, first_message_at, last_message_at FROM conversations WHERE source = ? AND source_conv_id = ?',
    ).get(c.source, c.sourceConvId) as ConversationRow | undefined;
    const title = blankToNull(c.title);
    const firstAt = c.firstAt ?? null;
    const lastAt = c.lastAt ?? null;
    if (!cur) {
      const id = uuidv7(this.now);
      this.q(
        `INSERT INTO conversations (id, source, source_conv_id, kind, title, title_source, member_count, first_message_at, last_message_at,
           created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, c.source, c.sourceConvId, c.kind, title, title ? (c.titleSource ?? 'chat') : null, c.memberCount ?? null, firstAt, lastAt, this.now,
        this.now);
      this.stats.conversations_new++;
      this.convKinds.set(id, c.kind);
      return { id, created: true, kind: c.kind };
    }
    const next = {
      kind: c.kind,
      title: title ?? cur.title,
      member_count: c.memberCount ?? cur.member_count,
      first_message_at: firstAt === null ? cur.first_message_at : Math.min(cur.first_message_at ?? firstAt, firstAt),
      last_message_at: lastAt === null ? cur.last_message_at : Math.max(cur.last_message_at ?? lastAt, lastAt),
    };
    const changed = (Object.keys(next) as (keyof typeof next)[]).filter((k) => next[k] !== cur[k]);
    if (changed.length) {
      this.q(
        `UPDATE conversations SET kind = @kind, title = @title,
           title_source = CASE WHEN @titleChanged THEN @titleSource ELSE title_source END, member_count = @member_count,
           first_message_at = @first_message_at, last_message_at = @last_message_at, updated_at = @now
         WHERE id = @id`,
      ).run({ ...next, titleChanged: next.title !== cur.title ? 1 : 0, titleSource: c.titleSource ?? 'chat', now: this.now, id: cur.id });
      this.stats.conversations_updated++;
      // A kind change (direct ↔ self, …) changes whether and how the whole conversation is sessionized.
      if (next.kind !== cur.kind) this.touchConversation(cur.id, null);
    }
    this.convKinds.set(cur.id, c.kind);
    return { id: cur.id, created: false, kind: c.kind };
  }

  private conversationKind(conversationId: string): ConversationKind | undefined {
    let k = this.convKinds.get(conversationId);
    if (!k) {
      k = this.q('SELECT kind FROM conversations WHERE id = ?').pluck().get(conversationId) as ConversationKind | undefined;
      if (k) this.convKinds.set(conversationId, k);
    }
    return k;
  }

  /** Upserts a member (never me). Returns true if the row changed. */
  upsertMember(conversationId: string, identityId: string, m: MemberInput): boolean {
    if (this.isMe(identityId)) return false;
    const inactive = m.isActive === false ? 1 : 0;
    const changes = this.q(
      `INSERT INTO conversation_members (conversation_id, identity_id, role, is_active, joined_at, left_at, source, first_seen_at, last_seen_at)
       VALUES (@conv, @ident, @role, @active, @joined, @left, @source, @at, @at)
       ON CONFLICT (conversation_id, identity_id) DO UPDATE SET
         first_seen_at = min(conversation_members.first_seen_at, excluded.first_seen_at),
         last_seen_at = max(conversation_members.last_seen_at, excluded.last_seen_at),
         role = coalesce(excluded.role, conversation_members.role),
         joined_at = CASE WHEN excluded.joined_at IS NULL THEN conversation_members.joined_at
           ELSE min(coalesce(conversation_members.joined_at, excluded.joined_at), excluded.joined_at) END,
         is_active = CASE WHEN @inactive THEN 0 WHEN ${REJOINS} THEN 1 ELSE conversation_members.is_active END,
         left_at = CASE WHEN @inactive THEN coalesce(conversation_members.left_at, excluded.left_at)
           WHEN ${REJOINS} THEN NULL ELSE conversation_members.left_at END
       WHERE excluded.first_seen_at < conversation_members.first_seen_at OR excluded.last_seen_at > conversation_members.last_seen_at
         OR (excluded.role IS NOT NULL AND excluded.role IS NOT conversation_members.role)
         OR (excluded.joined_at IS NOT NULL AND (conversation_members.joined_at IS NULL OR excluded.joined_at < conversation_members.joined_at))
         OR (@inactive AND conversation_members.is_active = 1) OR (NOT @inactive AND ${REJOINS})`,
    ).run({
      conv: conversationId,
      ident: identityId,
      role: m.role ?? null,
      active: inactive ? 0 : 1,
      joined: m.joinedAt ?? null,
      left: inactive ? (m.leftAt ?? m.at) : null,
      source: m.source,
      at: m.at,
      inactive,
    }).changes;
    if (changes) this.stats.members_upserted++;
    return changes > 0;
  }

  /**
   * An authoritative full roster: active members not in it have left (at `at`). Call only with a complete
   * roster; partial ones (a page of participants) must not.
   */
  reconcileRoster(conversationId: string, currentIdentityIds: Iterable<string>, at: number): number {
    const keep = JSON.stringify([...new Set(currentIdentityIds)]);
    const n = this.q(
      `UPDATE conversation_members SET is_active = 0, left_at = coalesce(left_at, ?)
       WHERE conversation_id = ? AND is_active = 1 AND identity_id NOT IN (SELECT value FROM json_each(?))`,
    ).run(at, conversationId, keep).changes;
    this.stats.members_left += n;
    return n;
  }

  /** A group add / remove / leave / rename, applied to the roster like the iMessage group events. */
  recordMembershipEvent(e: MembershipEventInput): boolean {
    const newTitle = e.action === 'rename' ? blankToNull(e.newTitle) : null;
    const identityId = e.action === 'rename' ? null : e.identityId;
    const inserted = this.q(
      `INSERT INTO membership_events (conversation_id, identity_id, actor_identity_id, action, new_title, at, message_id)
       VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (dedupe_key) DO NOTHING`,
    ).run(e.conversationId, identityId, e.actorIdentityId ?? null, e.action, newTitle, e.at, e.messageId ?? null).changes;
    this.stats.membership_events += inserted;
    if (e.action === 'rename') {
      if (newTitle) {
        this.q(`UPDATE conversations SET title = ?, title_source = 'group_event', updated_at = ? WHERE id = ? AND title IS NOT ?`).run(
          newTitle,
          this.now,
          e.conversationId,
          newTitle,
        );
      }
      return inserted > 0;
    }
    if (!identityId || this.isMe(identityId)) return inserted > 0;
    if (e.action === 'add') {
      this.upsertMember(e.conversationId, identityId, { source: 'group_event', at: e.at });
      // A re-read of an add older than a later leave changes nothing; a re-add after a leave reactivates.
      this.q(
        `UPDATE conversation_members SET is_active = 1, left_at = NULL,
           joined_at = CASE WHEN joined_at IS NULL OR is_active = 0 THEN @t ELSE min(joined_at, @t) END
         WHERE conversation_id = @c AND identity_id = @i AND (left_at IS NULL OR left_at <= @t)
           AND (is_active = 0 OR joined_at IS NULL OR joined_at > @t)`,
      ).run({ t: e.at, c: e.conversationId, i: identityId });
    } else {
      this.q(
        `UPDATE conversation_members SET is_active = 0, left_at = @t
         WHERE conversation_id = @c AND identity_id = @i AND (joined_at IS NULL OR joined_at <= @t) AND (left_at IS NULL OR left_at < @t)`,
      ).run({ t: e.at, c: e.conversationId, i: identityId });
    }
    return inserted > 0;
  }

  // ---------- messages ----------

  messageIdBySourceId(source: string, sourceMsgId: string | null | undefined): number | null {
    if (!sourceMsgId) return null;
    return (this.q('SELECT id FROM messages WHERE source = ? AND source_msg_id = ?').pluck().get(source, sourceMsgId) as number | undefined) ?? null;
  }

  /**
   * Idempotent on (source, source_msg_id). A new message is inserted; an existing one gets only the columns that
   * changed. Senders of group and 1:1 posts become members ('sender'); the conversation is touched for refresh().
   */
  upsertMessage(m: MessageInput): MessageResult {
    this.sources.add(m.source);
    const existing = this.q(
      `SELECT id, sender_identity_id, text, text_source, edited_at, retracted_at, kind, is_bot, is_spam, attachments, content_key,
         reply_to_msg_id, reply_to_source_id, thread_root_source_id
       FROM messages WHERE source = ? AND source_msg_id = ?`,
    ).get(m.source, m.sourceMsgId) as MessageRow | undefined;
    const text = blankToNull(m.text);
    const retractedAt = m.retractedAt ?? existing?.retracted_at ?? null;
    // A retracted (unsent) message keeps no text; otherwise a re-read never blanks text an earlier read had.
    const nextText = m.retractedAt != null ? text : (text ?? existing?.text ?? null);
    const sender = existing?.sender_identity_id ?? m.senderIdentityId;
    const replyToSourceId = m.replyToSourceId ?? existing?.reply_to_source_id ?? null;
    const row = {
      sender_identity_id: m.isFromMe ? null : sender,
      text: nextText,
      text_source: text !== null ? (m.textSource ?? 'text') : (existing?.text_source ?? m.textSource ?? 'none'),
      edited_at: m.editedAt ?? existing?.edited_at ?? null,
      retracted_at: retractedAt,
      kind: m.kind,
      is_bot: m.isBot || existing?.is_bot === 1 ? 1 : 0,
      is_spam: m.isSpam ? 1 : 0,
      attachments: m.attachments === undefined ? (existing?.attachments ?? null) : m.attachments?.length ? JSON.stringify(m.attachments) : null,
      content_key: contentKey(m.conversationId, m.isFromMe ? 'me' : (sender ?? '?'), m.sentAt, nextText) ?? existing?.content_key ?? null,
      reply_to_msg_id: existing?.reply_to_msg_id ?? this.messageIdBySourceId(m.source, replyToSourceId),
      reply_to_source_id: replyToSourceId,
      thread_root_source_id: m.threadRootSourceId ?? existing?.thread_root_source_id ?? null,
    };
    let result: MessageResult;
    if (!existing) {
      const id = Number(
        this.q(
          `INSERT INTO messages (source, source_msg_id, conversation_id, sender_identity_id, is_from_me, sent_at, edited_at, retracted_at,
             kind, text, text_source, reply_to_msg_id, reply_to_source_id, thread_root_source_id, attachments, service, is_spam, is_bot,
             content_key, source_row_ref, ingested_at, updated_at)
           VALUES (@source, @sourceMsgId, @conv, @sender_identity_id, @fromMe, @sentAt, @edited_at, @retracted_at, @kind, @text, @text_source,
             @reply_to_msg_id, @reply_to_source_id, @thread_root_source_id, @attachments, @service, @is_spam, @is_bot, @content_key, @rowRef,
             @now, @now)`,
        ).run({
          ...row,
          source: m.source,
          sourceMsgId: m.sourceMsgId,
          conv: m.conversationId,
          fromMe: m.isFromMe ? 1 : 0,
          sentAt: m.sentAt,
          service: m.service ?? null,
          rowRef: m.sourceRowRef ?? null,
          now: this.now,
        }).lastInsertRowid,
      );
      this.stats.messages_new++;
      result = { id, created: true, updated: false };
    } else {
      const changed = (Object.keys(row) as (keyof typeof row)[]).filter((c) => row[c] !== existing[c]);
      if (changed.length) {
        this.q(`UPDATE messages SET ${changed.map((c) => `${c} = @${c}`).join(', ')}, updated_at = @now WHERE id = @id`).run({
          ...Object.fromEntries(changed.map((c) => [c, row[c]])),
          now: this.now,
          id: existing.id,
        });
        this.stats.messages_updated++;
      }
      result = { id: existing.id, created: false, updated: changed.length > 0 };
    }
    const kind = this.conversationKind(m.conversationId);
    if (!m.isFromMe && row.sender_identity_id && (kind === 'group' || kind === 'direct')) {
      this.upsertMember(m.conversationId, row.sender_identity_id, { source: 'sender', at: m.sentAt });
    }
    if (result.created || result.updated) this.touchConversation(m.conversationId, m.sentAt);
    return result;
  }

  /** Links quoted replies of `source` whose target has arrived since (not iMessage: it links by thread root). */
  linkPendingReplies(source: string): number {
    const n = this.q(
      `UPDATE messages SET reply_to_msg_id = (
         SELECT t.id FROM messages t WHERE t.source = messages.source AND t.source_msg_id = messages.reply_to_source_id)
       WHERE source = ? AND reply_to_msg_id IS NULL AND reply_to_source_id IS NOT NULL AND source <> 'imessage'
         AND EXISTS (SELECT 1 FROM messages t WHERE t.source = messages.source AND t.source_msg_id = messages.reply_to_source_id)`,
    ).run(source).changes;
    this.stats.replies_linked += n;
    return n;
  }

  // ---------- reactions ----------

  /** Stores, updates or removes a reaction; parks it when the target message isn't stored yet. */
  upsertReaction(r: ReactionInput): ReactionOutcome {
    const key = reactionKey(r.source, r.sourceReactionId);
    const target = this.messageIdBySourceId(r.source, r.targetSourceMsgId);
    if (target === null) {
      const parked = this.q(
        `INSERT INTO pending_reactions (source_reaction_id, source, target_source_msg_id, actor_identity_id, is_from_me, type, emoji,
           removal, at, first_seen_at) VALUES (@key, @source, @target, @actor, @fromMe, @type, @emoji, @removal, @at, @now)
         ON CONFLICT (source_reaction_id) DO UPDATE SET type = excluded.type, emoji = excluded.emoji, removal = excluded.removal,
           at = excluded.at
         WHERE excluded.at > pending_reactions.at OR (excluded.at = pending_reactions.at AND (excluded.type IS NOT pending_reactions.type
           OR excluded.emoji IS NOT pending_reactions.emoji OR excluded.removal <> pending_reactions.removal))`,
      ).run({
        key,
        source: r.source,
        target: r.targetSourceMsgId,
        actor: r.actorIdentityId,
        fromMe: r.isFromMe ? 1 : 0,
        type: r.type,
        emoji: r.emoji ?? null,
        removal: r.removal ? 1 : 0,
        at: r.at,
        now: this.now,
      }).changes;
      this.stats.reactions_pending += parked;
      return parked ? 'parked' : 'unchanged';
    }
    return this.applyReaction(target, key, r);
  }

  private applyReaction(
    messageId: number,
    key: string,
    r: Pick<ReactionInput, 'actorIdentityId' | 'isFromMe' | 'type' | 'emoji' | 'removal' | 'at'>,
  ): ReactionOutcome {
    const fromMe = r.isFromMe ? 1 : 0;
    if (!r.removal) {
      const before = this.q('SELECT 1 FROM message_reactions WHERE source_reaction_id = ?').get(key) !== undefined;
      // A re-read never revives a reaction removed later: removals move `at` forward.
      const n = this.q(
        `INSERT INTO message_reactions (source_reaction_id, message_id, actor_identity_id, is_from_me, type, emoji, removed, at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT (source_reaction_id) DO UPDATE SET type = excluded.type, emoji = excluded.emoji, removed = 0, at = excluded.at
         WHERE excluded.at > message_reactions.at OR (excluded.at = message_reactions.at AND message_reactions.removed = 0
           AND (excluded.type IS NOT message_reactions.type OR excluded.emoji IS NOT message_reactions.emoji))`,
      ).run(key, messageId, r.actorIdentityId, fromMe, r.type, r.emoji ?? null, r.at).changes;
      if (!n) return 'unchanged';
      if (before) {
        this.stats.reactions_updated++;
        return 'updated';
      }
      this.stats.reactions++;
      return 'stored';
    }
    const own = this.q('SELECT removed, at FROM message_reactions WHERE source_reaction_id = ?').get(key) as
      | { removed: number; at: number }
      | undefined;
    let n: number;
    if (own) {
      n = this.q('UPDATE message_reactions SET removed = 1, at = max(at, ?) WHERE source_reaction_id = ? AND removed = 0 AND at <= ?').run(
        r.at,
        key,
        r.at,
      ).changes;
    } else {
      n = this.q(
        `UPDATE message_reactions SET removed = 1, at = max(at, @at) WHERE message_id = @msg AND type = @type AND is_from_me = @fromMe
           AND coalesce(actor_identity_id, '') = coalesce(@actor, '') AND at <= @at AND removed = 0`,
      ).run({ at: r.at, msg: messageId, type: r.type, fromMe, actor: r.actorIdentityId }).changes;
    }
    this.stats.reactions_removed += n;
    return n ? 'removed' : 'unchanged';
  }

  /** Applies parked reactions of `source` whose target has arrived (adds before removals). */
  resolvePendingReactions(source: string): number {
    const ready = this.q(
      `SELECT p.*, m.id AS message_id FROM pending_reactions p
       JOIN messages m ON m.source = p.source AND m.source_msg_id = p.target_source_msg_id
       WHERE p.source = ? ORDER BY p.removal, p.at`,
    ).all(source) as (PendingRow & { message_id: number })[];
    const del = this.q('DELETE FROM pending_reactions WHERE source_reaction_id = ?');
    for (const p of ready) {
      this.applyReaction(p.message_id, p.source_reaction_id, {
        actorIdentityId: p.actor_identity_id,
        isFromMe: p.is_from_me === 1,
        type: p.type,
        emoji: p.emoji,
        removal: p.removal === 1,
        at: p.at,
      });
      del.run(p.source_reaction_id);
    }
    this.stats.reactions_resolved += ready.length;
    return ready.length;
  }

  /** Drops parked reactions of `source` first seen before `olderThan` (their target will never arrive). */
  expirePendingReactions(source: string, olderThan: number): number {
    const n = this.q('DELETE FROM pending_reactions WHERE source = ? AND first_seen_at < ?').run(source, olderThan).changes;
    this.stats.reactions_expired += n;
    return n;
  }

  // ---------- derived refresh ----------

  /** Marks a conversation for re-sessionizing from `fromSentAt` (null = the whole conversation). */
  touchConversation(conversationId: string, fromSentAt: number | null): void {
    if (!this.touched.has(conversationId)) {
      this.touched.set(conversationId, fromSentAt);
      return;
    }
    const cur = this.touched.get(conversationId)!;
    this.touched.set(conversationId, cur === null || fromSentAt === null ? null : Math.min(cur, fromSentAt));
  }

  /**
   * Re-sessionizes every touched conversation plus those with messages past each source's 'sessionized'
   * watermark (so a pass that died after committing pages is caught up by the next one), re-derives their
   * interactions, then advances the watermarks. `sources` adds sources to catch up beyond the ones written here.
   */
  refresh(o: { sources?: Iterable<string>; rules?: SessionRules } = {}): RefreshResult {
    const sources = new Set([...this.sources, ...(o.sources ?? [])]);
    const marks = new Map<string, number>();
    for (const source of sources) {
      const mark = Number(readCursor(this.db, source, SESSIONIZED_SCOPE)?.cursor ?? 0);
      const fresh = this.q('SELECT conversation_id, min(sent_at) AS from_at FROM messages WHERE source = ? AND id > ? GROUP BY conversation_id').all(
        source,
        mark,
      ) as { conversation_id: string; from_at: number }[];
      for (const f of fresh) this.touchConversation(f.conversation_id, f.from_at);
      const max = (this.q('SELECT max(id) FROM messages WHERE source = ? AND id > ?').pluck().get(source, mark) as number | null) ?? mark;
      if (max > mark) marks.set(source, max);
    }
    const r = refreshConversations(this.db, this.touched, { now: this.now, rules: o.rules });
    for (const [source, max] of marks) writeCursor(this.db, source, SESSIONIZED_SCOPE, String(max), this.now);
    this.touched.clear();
    this.stats.sessions_changed += r.sessionsChanged + r.sessionsRemoved;
    this.stats.interactions_upserted += r.interactionsUpserted;
    this.stats.interactions_deleted += r.interactionsDeleted;
    return r;
  }
}

export const episodeWriter = (db: DB, o: { now?: number; meIdentityIds?: Iterable<string> } = {}): EpisodeWriter => new EpisodeWriter(db, o);
