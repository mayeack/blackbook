/**
 * Beeper Desktop → Instagram episodes (PLAN "Ingestion → Instagram → Beeper adapter"). One pass:
 *   1. accounts   Instagram accounts only (isInstagramAccount); one whose status asks for the owner
 *                 (connection/reconnect/attention required, disconnected, disabled) makes the source auth_required,
 *                 while 'connecting'/'backfilling' are healthy and a missing status is unknown, not disconnected.
 *                 My own account (its numeric id, username, and Beeper's self user) binds to 'me'.
 *   2. chats      listed most recent first (accountIDs = Instagram) down to the 'chats' watermark. A chat whose
 *                 lastActivity moved gets its head synced: conversation, roster (participants → identities) and the
 *                 newest message page, re-read on every move so recent reactions and edits land.
 *   3. backlog    older pages, newest chats first, until each chat's gap to its high-water mark is closed or (first
 *                 sync) its whole history is in. A per-pass request budget bounds the pass; what is left stays in
 *                 the chat's source_cursors row (source 'instagram', scope = chat id) for the next pass.
 * Episodes go through EpisodeWriter; people and identities through identity/external.ts (journaled, so undoable).
 * One page = one transaction, its cursor included. A Beeper message that an Instagram export (DYI) row already
 * covered marks that row dup_of. Stats and health hold counts only.
 */
import type { Statement } from 'better-sqlite3';
import { canonicalId, canonicalMembers } from '../../db/canon';
import type { DB } from '../../db/connection';
import { tx } from '../../db/tx';
import { attachExternalIdentity, normalizeExternalKey, personOfIdentity, type ExternalKind } from '../../identity/external';
import { ensureMe, findIdentity, touchIdentitySeen } from '../../identity/resolver';
import { sourceRun, type SourceRun } from '../common/context';
import { cursorMeta, readCursor, recordSourceHealth, writeCursor, type HealthUpdate } from '../common/cursors';
import { episodeWriter, nonZeroStats, reactionKey, type EpisodeWriter } from '../common/episodes';
import { DYI_SOURCE } from '../instagram/dyiFiles';
import { promoteQualified } from '../instagram/identities';
import { MATCH_WINDOW_MS, textHash } from '../instagram/text';
import type { BeeperClient } from './client';
import {
  attachmentMeta,
  blankToNull,
  chatKind,
  instagramIdOf,
  isInstagramAccount,
  isoToMs,
  isReactionEvent,
  messageKey,
  messageKind,
  reactionSourceId,
  SOURCE,
} from './mapping';
import { BeeperParticipant, parseItems, type BeeperAccount, type BeeperChat, type BeeperMessage, type Page } from './schemas';

/** source_cursors scope of the chat-list watermark (chat scopes are Beeper chat ids, which start with '!'). */
export const CHATS_SCOPE = 'chats';
/** Same Beeper message id but a timestamp this far off: the Desktop install was reset and ids were reused. */
const ID_REUSE_MS = 5 * 60_000;
const MAX_ROSTER = 500;

export interface BeeperIngestOptions {
  now?: number;
  jobRunId?: number | null;
  signal?: AbortSignal;
  /** GET requests per pass (default 500). */
  maxRequests?: number;
  /** Older-history pages per chat per pass (default 30). */
  maxPagesPerChat?: number;
  /** Only the N most recent chats (a bounded check); the chat watermark is then left alone. */
  maxChats?: number;
  /** Chats per list page (1–200, default 100). */
  chatPageSize?: number;
}

/** Beeper Desktop API Account.status values that need the owner to act in Beeper (reconnect / re-enable). */
const NEEDS_OWNER = new Set(['connection_required', 'reconnect_required', 'attention_required', 'disconnected', 'disabled']);
/** Transient healthy states: the account is coming up or catching up. */
const SYNCING = new Set(['connecting', 'backfilling']);

export interface BeeperIngestStats {
  accounts: number;
  accounts_not_connected: number;
  chat_pages: number;
  chats_listed: number;
  chats_synced: number;
  chats_skipped_merged: number;
  chats_backlog: number;
  message_pages: number;
  requests: number;
  invalid_items: number;
  id_conflicts: number;
  username_conflicts: number;
  dyi_superseded: number;
  promoted: number;
  [k: string]: number;
}

/** Per-chat state (source_cursors.meta). */
interface ChatMeta {
  /** lastActivity (ms) whose head has been synced. */
  lastActivity?: number | null;
  /** Newest message time synced contiguously from the head. */
  newestAt?: number | null;
  /** Older-page walks still to do: until = stop at this time (a gap), null = to the start (backfill). */
  pending?: { cursor: string; until: number | null }[];
  /** The whole history has been read once. */
  complete?: boolean;
  initialized?: boolean;
}

interface ConvRef {
  id: string;
  kind: 'direct' | 'group';
}

interface UserRef {
  id: string;
  fullName?: string | null;
  username?: string | null;
  isSelf?: boolean | null;
  isNetworkBot?: boolean | null;
}

export class BeeperInstagramIngest {
  readonly stats: BeeperIngestStats = {
    accounts: 0,
    accounts_not_connected: 0,
    chat_pages: 0,
    chats_listed: 0,
    chats_synced: 0,
    chats_skipped_merged: 0,
    chats_backlog: 0,
    message_pages: 0,
    requests: 0,
    invalid_items: 0,
    id_conflicts: 0,
    username_conflicts: 0,
    dyi_superseded: 0,
    promoted: 0,
  };
  private readonly now: number;
  private readonly run: SourceRun;
  private readonly w: EpisodeWriter;
  private readonly maxRequests: number;
  private readonly maxPagesPerChat: number;
  private readonly igAccountIds = new Set<string>();
  private readonly selfUserIds = new Set<string>();
  private readonly selfIgIds = new Set<string>();
  private readonly users = new Map<string, string | null>();
  private readonly hasDyi = new Map<string, boolean>();
  private mePersonId: string | null = null;
  private readonly statements = new Map<string, Statement>();

  constructor(
    private readonly db: DB,
    private readonly client: BeeperClient,
    private readonly o: BeeperIngestOptions = {},
  ) {
    this.now = o.now ?? Date.now();
    this.run = sourceRun(db, SOURCE, { now: this.now, jobRunId: o.jobRunId ?? null, kind: 'ingest' });
    this.w = episodeWriter(db, { now: this.now });
    this.maxRequests = o.maxRequests ?? 500;
    this.maxPagesPerChat = o.maxPagesPerChat ?? 30;
  }

  /** Prepared-statement cache (a backfill runs the same few statements thousands of times). */
  private q(sql: string): Statement {
    let st = this.statements.get(sql);
    if (!st) this.statements.set(sql, (st = this.db.prepare(sql)));
    return st;
  }

  private get ctx() {
    return this.run.ctx;
  }

  private budgetLeft(): boolean {
    return this.client.requests < this.maxRequests && !this.o.signal?.aborted;
  }

  async ingest(): Promise<BeeperIngestStats> {
    const startRequests = this.client.requests;
    let status: 'ok' | 'error' = 'error';
    try {
      const accounts = (await this.client.accounts()).items.filter(isInstagramAccount);
      this.stats.accounts = accounts.length;
      if (!accounts.length) {
        this.health('auth_required', { error: 'No Instagram account is connected in Beeper Desktop: add Instagram there (Settings → Accounts).' });
        status = 'ok';
        return this.stats;
      }
      for (const a of accounts) this.igAccountIds.add(a.accountID);
      tx(this.db, () => this.bindMe(accounts));
      const notConnected = accounts.filter((a) => NEEDS_OWNER.has((a.status ?? '').toLowerCase()));
      const syncing = accounts.filter((a) => SYNCING.has((a.status ?? '').toLowerCase())).length;
      this.stats.accounts_not_connected = notConnected.length;

      const { toSync, listingComplete, listed } = await this.listChats();
      const heads = new Map<string, ConvRef>();
      const unsynced: number[] = [];
      for (const c of toSync) {
        if (!this.budgetLeft()) {
          unsynced.push(isoToMs(c.lastActivity) ?? 0);
          continue;
        }
        const conv = await this.syncHead(c);
        if (conv) heads.set(c.id, conv);
        else unsynced.push(isoToMs(c.lastActivity) ?? 0);
      }
      await this.drainBacklog(heads);
      this.advanceWatermark(listed, listingComplete, unsynced);
      tx(this.db, () => this.w.refresh());
      this.stats.chats_backlog = this.q(`SELECT count(*) FROM source_cursors WHERE source = ? AND scope LIKE '!%' AND json_array_length(meta, '$.pending') > 0`)
        .pluck()
        .get(SOURCE) as number;
      this.stats.requests = this.client.requests - startRequests;
      Object.assign(this.stats, nonZeroStats(this.w.stats));
      const details = {
        accounts: accounts.length,
        chats_synced: this.stats.chats_synced,
        backlog_chats: this.stats.chats_backlog,
        ...(syncing ? { accounts_syncing: syncing } : {}),
      };
      if (notConnected.length) {
        const what = notConnected.map((a) => a.statusText || a.status || 'not connected').join(', ');
        this.health('auth_required', { error: `Instagram in Beeper Desktop is ${what}: open Beeper and reconnect Instagram.`, details });
      } else {
        this.health('ok', { details });
      }
      status = 'ok';
      return this.stats;
    } finally {
      this.run.finish(status, { messages_new: this.w.stats.messages_new });
    }
  }

  private health(status: 'ok' | 'auth_required', o: HealthUpdate): void {
    recordSourceHealth(this.db, SOURCE, this.now, status, o);
  }

  // ---------------------------------------------------------------------------------------- identities

  /** My Instagram account(s): numeric id + username on 'me' (journaled attach batches, once). */
  private bindMe(accounts: BeeperAccount[]): void {
    this.mePersonId = ensureMe(this.ctx, []).personId;
    for (const a of accounts) {
      const u = a.user;
      if (!u?.id) continue;
      this.selfUserIds.add(u.id);
      const igId = instagramIdOf(u.id);
      if (igId) this.selfIgIds.add(igId);
      const kind: ExternalKind = igId ? 'instagram_id' : 'beeper_user';
      attachExternalIdentity(this.ctx, { kind, key: igId ?? u.id, raw: u.id, displayName: u.fullName, personId: this.mePersonId });
      if (u.username) attachExternalIdentity(this.ctx, { kind: 'instagram_username', key: u.username, personId: this.mePersonId });
    }
  }

  private isMe(u: Pick<UserRef, 'id' | 'isSelf'>): boolean {
    if (u.isSelf || this.selfUserIds.has(u.id)) return true;
    const ig = instagramIdOf(u.id);
    return ig !== null && this.selfIgIds.has(ig);
  }

  /**
   * A Beeper user → identity id. Instagram contacts are keyed on their numeric id (else the Beeper id), with the
   * username from the same payload linked deterministically and fullName kept as an alias. Me → my identity.
   */
  private resolveUser(u: UserRef, at: number): string | null {
    const cached = this.users.get(u.id);
    if (cached !== undefined) return cached;
    let id: string | null;
    if (this.isMe(u)) {
      id = attachExternalIdentity(this.ctx, { kind: 'beeper_user', key: u.id, at, personId: this.mePersonId ?? undefined });
      this.selfUserIds.add(u.id);
    } else {
      const igId = instagramIdOf(u.id);
      id = attachExternalIdentity(this.ctx, {
        kind: igId ? 'instagram_id' : 'beeper_user',
        key: igId ?? u.id,
        raw: u.id,
        displayName: blankToNull(u.fullName),
        at,
        signals: u.isNetworkBot ? { service: 'chatbot' } : undefined,
      });
      if (id && u.username) this.linkUsername(id, igId, u.username, at);
    }
    this.users.set(u.id, id);
    return id;
  }

  /** §1.1: the ig_id ↔ username binding is refreshed every pass; a username now on another IG account is not merged. */
  private linkUsername(identityId: string, igId: string | null, username: string, at: number): void {
    const k = normalizeExternalKey('instagram_username', username);
    const personId = personOfIdentity(this.db, identityId);
    if (!k || !personId) return;
    const existing = findIdentity(this.db, k);
    if (existing && canonicalId(this.db, existing.person_id) !== canonicalId(this.db, personId)) {
      const members = canonicalMembers(this.db, canonicalId(this.db, existing.person_id));
      const otherAccount = this.q(
          `SELECT 1 FROM identities WHERE kind = 'instagram_id' AND status = 'active' AND key IS NOT ?
             AND person_id IN (SELECT value FROM json_each(?)) LIMIT 1`,
        )
        .get(igId, JSON.stringify(members));
      if (otherAccount) {
        this.stats.username_conflicts++;
        touchIdentitySeen(this.db, existing.id, at);
        return;
      }
    }
    attachExternalIdentity(this.ctx, { kind: 'instagram_username', key: k.key, at, personId });
  }

  private promote(identityIds: Iterable<string>): void {
    this.stats.promoted += promoteQualified(this.ctx, identityIds);
  }

  // ---------------------------------------------------------------------------------------- chats

  private async listChats(): Promise<{ toSync: BeeperChat[]; listed: BeeperChat[]; listingComplete: boolean }> {
    const watermark = readCursor(this.db, SOURCE, CHATS_SCOPE)?.high_water_at ?? null;
    const listed: BeeperChat[] = [];
    let cursor: string | null = null;
    let complete = false;
    const max = this.o.maxChats;
    outer: for (;;) {
      if (!this.budgetLeft()) break;
      const page = await this.client.chats({ accountIDs: [...this.igAccountIds], limit: this.o.chatPageSize ?? 100, cursor, direction: 'before' });
      this.stats.chat_pages++;
      this.stats.invalid_items += page.invalid;
      for (const c of page.items) {
        if (!this.igAccountIds.has(c.accountID)) continue;
        const la = isoToMs(c.lastActivity);
        if (watermark !== null && la !== null && la <= watermark) {
          complete = true;
          break outer;
        }
        listed.push(c);
        if (max !== undefined && listed.length >= max) break outer;
      }
      if (!page.hasMore || !page.oldestCursor) {
        complete = true;
        break;
      }
      cursor = page.oldestCursor;
    }
    this.stats.chats_listed = listed.length;
    const toSync: BeeperChat[] = [];
    for (const c of listed) {
      if (c.merge !== undefined && c.merge !== null) {
        this.stats.chats_skipped_merged++;
        continue;
      }
      const meta = cursorMeta<ChatMeta>(readCursor(this.db, SOURCE, c.id));
      const la = isoToMs(c.lastActivity);
      if (!meta.initialized || la === null || meta.lastActivity == null || la > meta.lastActivity) toSync.push(c);
    }
    return { toSync, listed, listingComplete: complete && max === undefined };
  }

  /** Every listed chat synced: the watermark moves to the newest; otherwise to just below the oldest left over. */
  private advanceWatermark(listed: BeeperChat[], complete: boolean, unsynced: number[]): void {
    if (!complete || !listed.length) return;
    const times = listed.map((c) => isoToMs(c.lastActivity)).filter((t): t is number => t !== null);
    if (!times.length) return;
    const next = unsynced.length ? Math.min(...unsynced) - 1 : Math.max(...times);
    const cur = readCursor(this.db, SOURCE, CHATS_SCOPE)?.high_water_at ?? null;
    if (cur !== null && next <= cur) return;
    // writeCursor keeps high_water_at monotonic, which is what a watermark wants.
    writeCursor(this.db, SOURCE, CHATS_SCOPE, new Date(next).toISOString(), this.now, { highWaterAt: next });
  }

  private conversationOf(chatId: string): ConvRef | null {
    const row = this.q('SELECT id, kind FROM conversations WHERE source = ? AND source_conv_id = ?').get(SOURCE, chatId) as
      | ConvRef
      | undefined;
    return row ?? null;
  }

  /** Conversation, roster and the newest message page of a chat whose activity moved (or that is new). */
  private async syncHead(chat: BeeperChat): Promise<ConvRef | null> {
    const kind = chatKind(chat.type);
    let participants = parseItems(BeeperParticipant, chat.participants?.items ?? []);
    let rosterComplete = !(chat.participants?.hasMore ?? false);
    let total = chat.participants?.total ?? participants.items.length;
    if (!rosterComplete && kind === 'group' && this.budgetLeft()) {
      const full = await this.client.chat(chat.id, { maxParticipantCount: MAX_ROSTER });
      participants = parseItems(BeeperParticipant, full.participants?.items ?? []);
      rosterComplete = !(full.participants?.hasMore ?? false);
      total = full.participants?.total ?? total;
    }
    this.stats.invalid_items += participants.invalid;
    if (!this.budgetLeft()) return null;
    const page = await this.client.messages(chat.id);
    this.stats.message_pages++;
    this.stats.invalid_items += page.invalid;
    const la = isoToMs(chat.lastActivity);
    const conv = tx(this.db, () => {
      const c = this.w.upsertConversation({
        source: SOURCE,
        sourceConvId: chat.id,
        kind,
        title: kind === 'group' ? chat.title : null,
        memberCount: total,
        lastAt: la,
      });
      const ref: ConvRef = { id: c.id, kind };
      const at = la ?? this.now;
      const touched = new Set<string>();
      const roster: string[] = [];
      for (const p of participants.items) {
        if (p.isPending) continue;
        const id = this.resolveUser(p, at);
        if (!id || this.isMe(p)) continue;
        roster.push(id);
        touched.add(id);
        this.w.upsertMember(ref.id, id, { source: 'roster', at, role: p.isAdmin ? 'admin' : null });
      }
      if (kind === 'group' && rosterComplete && roster.length) this.w.reconcileRoster(ref.id, roster, this.now);
      this.processPage(chat.id, ref, page, touched);
      const meta = cursorMeta<ChatMeta>(readCursor(this.db, SOURCE, chat.id));
      // Every item counts here, reaction events included: a page of only reactions can still hide a gap.
      const times = page.items.map((m) => Date.parse(m.timestamp));
      const pending = [...(meta.pending ?? [])];
      if (!meta.initialized) {
        if (page.hasMore && page.oldestCursor) pending.push({ cursor: page.oldestCursor, until: null });
      } else if (page.hasMore && page.oldestCursor && meta.newestAt != null && times.length && Math.min(...times) > meta.newestAt) {
        // More new messages than one page since the last pass: walk back to the old high-water mark first.
        pending.unshift({ cursor: page.oldestCursor, until: meta.newestAt });
      }
      const newestAt = times.length ? Math.max(meta.newestAt ?? -Infinity, ...times) : (meta.newestAt ?? null);
      this.saveChat(chat.id, {
        ...meta,
        initialized: true,
        lastActivity: la,
        newestAt,
        pending,
        complete: meta.complete || (!meta.initialized && !page.hasMore),
      });
      this.promote(touched);
      return ref;
    });
    this.stats.chats_synced++;
    return conv;
  }

  /** Older pages, newest chats first, within the budget. */
  private async drainBacklog(heads: Map<string, ConvRef>): Promise<void> {
    const rows = this.q(
        `SELECT scope FROM source_cursors WHERE source = ? AND scope LIKE '!%' AND json_array_length(meta, '$.pending') > 0
         ORDER BY high_water_at DESC`,
      )
      .pluck()
      .all(SOURCE) as string[];
    // Chats just head-synced first (in recency order), then older backlog.
    const order = [...new Set([...[...heads.keys()].filter((id) => rows.includes(id)), ...rows])];
    for (const chatId of order) {
      if (!this.budgetLeft()) return;
      const conv = heads.get(chatId) ?? this.conversationOf(chatId);
      if (!conv) continue;
      let pages = 0;
      const touched = new Set<string>();
      while (pages < this.maxPagesPerChat && this.budgetLeft()) {
        const meta = cursorMeta<ChatMeta>(readCursor(this.db, SOURCE, chatId));
        const job = meta.pending?.[0];
        if (!job) break;
        let page: Page<BeeperMessage>;
        try {
          page = await this.client.messages(chatId, { cursor: job.cursor, direction: 'before' });
        } catch (e) {
          // A cursor the API no longer accepts: drop that walk (the next head re-read starts a fresh gap walk).
          if ((e as { status?: number }).status === 400 || (e as { status?: number }).status === 404) {
            tx(this.db, () => this.saveChat(chatId, { ...meta, pending: (meta.pending ?? []).slice(1) }));
            this.stats.cursor_invalid = (this.stats.cursor_invalid ?? 0) + 1;
            break;
          }
          throw e;
        }
        pages++;
        this.stats.message_pages++;
        this.stats.invalid_items += page.invalid;
        tx(this.db, () => {
          this.processPage(chatId, conv, page, touched);
          const times = page.items.map((m) => Date.parse(m.timestamp));
          const reached = job.until !== null && (!times.length || Math.min(...times) <= job.until);
          const rest = (meta.pending ?? []).slice(1);
          const done = !page.hasMore || !page.oldestCursor || reached;
          this.saveChat(chatId, {
            ...meta,
            pending: done ? rest : [{ cursor: page.oldestCursor!, until: job.until }, ...rest],
            complete: meta.complete || (done && job.until === null && !page.hasMore),
          });
        });
      }
      tx(this.db, () => this.promote(touched));
    }
  }

  private saveChat(chatId: string, meta: ChatMeta): void {
    writeCursor(this.db, SOURCE, chatId, meta.newestAt != null ? new Date(meta.newestAt).toISOString() : '', this.now, {
      highWaterAt: meta.newestAt ?? null,
      meta: meta as Record<string, unknown>,
    });
  }

  // ---------------------------------------------------------------------------------------- messages

  /** One page (newest first from Beeper) → messages + reactions, oldest first. Caller owns the transaction. */
  private processPage(chatId: string, conv: ConvRef, page: Page<BeeperMessage>, touched: Set<string>): void {
    const items = page.items.filter((m) => !m.accountID || this.igAccountIds.has(m.accountID));
    // REACTION items are hidden reaction events: they carry when, the target's reactions[] carries what.
    const reactedAt = new Map<string, number>();
    for (const m of items) {
      if (isReactionEvent(m) && m.linkedMessageID) reactedAt.set(`${m.linkedMessageID}|${m.senderID}`, Date.parse(m.timestamp));
    }
    const msgs = items
      .filter((m) => !isReactionEvent(m))
      .map((m) => ({ m, t: Date.parse(m.timestamp) }))
      .sort((a, b) => a.t - b.t || Number(a.m.sortKey ?? 0) - Number(b.m.sortKey ?? 0));
    let first: number | null = null;
    let last: number | null = null;
    for (const { m, t } of msgs) {
      const id = this.upsertMessage(chatId, conv, m, t, touched);
      if (id === null) continue;
      this.applyReactions(m, messageKey(chatId, m.id), id, t, reactedAt, touched);
      first = first === null ? t : Math.min(first, t);
      last = last === null ? t : Math.max(last, t);
    }
    if (first !== null) this.w.upsertConversation({ source: SOURCE, sourceConvId: chatId, kind: conv.kind, firstAt: first, lastAt: last });
    this.w.linkPendingReplies(SOURCE);
    this.w.resolvePendingReactions(SOURCE);
  }

  private upsertMessage(chatId: string, conv: ConvRef, m: BeeperMessage, t: number, touched: Set<string>): number | null {
    const key = messageKey(chatId, m.id);
    const stored = this.q('SELECT sent_at, retracted_at FROM messages WHERE source = ? AND source_msg_id = ?').get(SOURCE, key) as
      | { sent_at: number; retracted_at: number | null }
      | undefined;
    if (stored && Math.abs(stored.sent_at - t) > ID_REUSE_MS) {
      this.stats.id_conflicts++;
      return null;
    }
    const fromMe = m.isSender === true || this.isMe({ id: m.senderID });
    const sender = fromMe ? null : this.resolveUser({ id: m.senderID, fullName: m.senderName }, t);
    if (sender) touched.add(sender);
    const kind = messageKind(m);
    const text = m.isDeleted ? null : blankToNull(m.text);
    const r = this.w.upsertMessage({
      source: SOURCE,
      sourceMsgId: key,
      conversationId: conv.id,
      senderIdentityId: sender,
      isFromMe: fromMe,
      sentAt: t,
      kind,
      text,
      textSource: text === null ? 'none' : 'text',
      replyToSourceId: m.linkedMessageID ? messageKey(chatId, m.linkedMessageID) : null,
      attachments: attachmentMeta(m),
      editedAt: isoToMs(m.editedTimestamp),
      retractedAt: m.isDeleted ? (stored?.retracted_at ?? this.now) : null,
      service: 'instagram',
      sourceRowRef: m.sortKey ? `sk:${m.sortKey}` : null,
    });
    if (r.created) this.supersedeDyi(conv.id, r.id, t, text, fromMe);
    return r.id;
  }

  /** The target's reactions[] is the current truth: present ones are upserted, stored ones it lacks are removed. */
  private applyReactions(m: BeeperMessage, msgKey: string, messageId: number, t: number, reactedAt: Map<string, number>, touched: Set<string>): void {
    const present = new Set<string>();
    for (const r of m.reactions ?? []) {
      const fromMe = this.isMe({ id: r.participantID });
      const actor = fromMe ? null : this.resolveUser({ id: r.participantID }, t);
      if (actor) touched.add(actor);
      const sourceReactionId = reactionSourceId(msgKey, r.id);
      present.add(reactionKey(SOURCE, sourceReactionId));
      this.w.upsertReaction({
        source: SOURCE,
        sourceReactionId,
        targetSourceMsgId: msgKey,
        actorIdentityId: actor,
        isFromMe: fromMe,
        type: 'emoji',
        emoji: r.reactionKey,
        at: reactedAt.get(`${m.id}|${r.participantID}`) ?? t,
      });
    }
    const prefix = reactionKey(SOURCE, `${msgKey}|`);
    const stored = this.q('SELECT source_reaction_id FROM message_reactions WHERE message_id = ? AND removed = 0 AND substr(source_reaction_id, 1, ?) = ?')
      .pluck()
      .all(messageId, prefix.length, prefix) as string[];
    for (const s of stored) {
      if (present.has(s)) continue;
      this.w.upsertReaction({
        source: SOURCE,
        sourceReactionId: s.slice(SOURCE.length + 1),
        targetSourceMsgId: msgKey,
        actorIdentityId: null,
        isFromMe: false,
        type: 'emoji',
        removal: true,
        at: this.now,
      });
    }
  }

  /** A new Beeper message that an earlier DYI import already holds: the DYI row becomes its duplicate. */
  private supersedeDyi(conversationId: string, messageId: number, t: number, text: string | null, fromMe: boolean): void {
    let has = this.hasDyi.get(conversationId);
    if (has === undefined) {
      has = this.q('SELECT 1 FROM messages WHERE conversation_id = ? AND source = ? LIMIT 1').get(conversationId, DYI_SOURCE) !== undefined;
      this.hasDyi.set(conversationId, has);
    }
    if (!has) return;
    const h = textHash(text);
    const rows = this.q(
        `SELECT id, text, kind FROM messages WHERE conversation_id = ? AND source = ? AND dup_of IS NULL AND is_from_me = ?
           AND sent_at BETWEEN ? AND ? ORDER BY abs(sent_at - ?)`,
      )
      .all(conversationId, DYI_SOURCE, fromMe ? 1 : 0, t - MATCH_WINDOW_MS, t + MATCH_WINDOW_MS, t) as { id: number; text: string | null; kind: string }[];
    const twin = rows.find((r) => (h ? textHash(r.text) === h : r.text === null && r.kind !== 'system'));
    if (!twin) return;
    this.q('UPDATE messages SET dup_of = ?, updated_at = ? WHERE id = ?').run(messageId, this.now, twin.id);
    this.w.touchConversation(conversationId, t);
    this.stats.dyi_superseded++;
  }
}

/** One Beeper → Instagram pass (see the file comment). */
export function ingestBeeperInstagram(db: DB, client: BeeperClient, o: BeeperIngestOptions = {}): Promise<BeeperIngestStats> {
  return new BeeperInstagramIngest(db, client, o).ingest();
}
