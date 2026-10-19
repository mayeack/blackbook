/**
 * iMessage ingest from the collector (PLAN.md "Ingestion → iMessage"):
 *   tail     every 10 s: new chats (rosters) by chat rowid, then messages by after_rowid cursor until has_more=false;
 *   overlap  nightly: full roster refresh, a 48 h by-date re-read, the date_edited re-scan, and a re-check of every
 *            roster-only person.
 * Episodes (conversations, members, messages, reactions, membership events) are idempotent on natural keys, so
 * re-reading any range is a no-op. People and identities are journaled through identity/resolver.ts.
 *
 * One page = one SQLite transaction (cursor included). Unknown handles get an identity id up front and their
 * person is created at the end of the page, once the page's messages are in and §1.4 can be judged; foreign keys
 * are deferred for that transaction so rows may reference the not-yet-inserted identity.
 * Self-thread rows that aren't bot rows are staged as inbound_commands (pending); nothing here executes them.
 */
import { uuidv7 } from '@yb/shared';
import type { Chat, Msg } from '@yb/shared/collector/v1';
import { z } from 'zod';
import { rebuildPersonCanon } from '../../db/canon';
import type { Statement } from 'better-sqlite3';
import type { DB } from '../../db/connection';
import { tx } from '../../db/tx';
import {
  createPersonForHandle,
  ensureMe,
  findIdentity,
  handleKey,
  qualification,
  qualifies,
  reevaluateRosterOnly,
  refString,
  serviceReasonFor,
  touchIdentitySeen,
  type HandleKey,
  type MeBinding,
  type ResolveContext,
} from '../../identity/resolver';
import { isPartifulSender, messageServiceSignal, type ServiceReason } from '../../identity/service';
import { startRun, finishRun } from '../../journal/runs';
import { pruneDerivedInteractions, refreshConversations } from '../../pipeline/interactions';
import type { CollectorClient } from './collectorClient';
import {
  cleanText,
  contentKey,
  isBotText,
  isGroupChat,
  membershipAction,
  messageKind,
  outboundTextHash,
  reactionInfo,
  stripPartPrefix,
  URL_ONLY,
  type ConversationKind,
  type MessageKind,
} from './mapping';
import { storePartifulSignal } from './partifulTexts';

export const SOURCE = 'imessage';
const HOUR = 3_600_000;
/** Self-thread rows older than this when first seen are never staged as commands (no replays after a reset). */
export const COMMAND_MAX_AGE_MS = 6 * HOUR;
export const OVERLAP_MS = 48 * HOUR;
/** Parked tapbacks whose target never synced are dropped after this long (nightly pass). */
const PENDING_REACTION_TTL_MS = 30 * 24 * HOUR;
/** A row of mine whose raw text hashes like a send started this close to it is the bot's own (PLAN: 30 s). */
const IN_FLIGHT_MS = 30_000;
/** An iPhone-typed note-to-self can land as two rows; the same text within this window is one command. */
const COMMAND_DUP_WINDOW_MS = 5_000;

interface PendingReactionRow {
  source_reaction_id: string;
  target_source_msg_id: string;
  actor_identity_id: string | null;
  is_from_me: number;
  type: string;
  emoji: string | null;
  removal: number;
  at: number;
}

export interface IngestStats {
  pages: number;
  chats: number;
  messages_new: number;
  messages_updated: number;
  reactions: number;
  reactions_removed: number;
  reactions_pending: number;
  reactions_resolved: number;
  replies_linked: number;
  reactions_expired: number;
  membership_events: number;
  commands_staged: number;
  people_provisional: number;
  people_roster_only: number;
  people_service: number;
  promoted: number;
  reclassified_service: number;
  partiful_signals: number;
  skipped_no_chat: number;
  unresolvable_handles: number;
  sessions_changed: number;
  interactions_upserted: number;
  interactions_deleted: number;
}

const emptyStats = (): IngestStats => ({
  pages: 0,
  chats: 0,
  messages_new: 0,
  messages_updated: 0,
  reactions: 0,
  reactions_removed: 0,
  reactions_pending: 0,
  reactions_resolved: 0,
  replies_linked: 0,
  reactions_expired: 0,
  membership_events: 0,
  commands_staged: 0,
  people_provisional: 0,
  people_roster_only: 0,
  people_service: 0,
  promoted: 0,
  reclassified_service: 0,
  partiful_signals: 0,
  skipped_no_chat: 0,
  unresolvable_handles: 0,
  sessions_changed: 0,
  interactions_upserted: 0,
  interactions_deleted: 0,
});

export interface IngestOptions {
  now?: number;
  jobRunId?: number | null;
  /** Collector page size (≤1000). */
  pageSize?: number;
  /** Pages per pass; the next tick continues from the cursor. */
  maxPages?: number;
  signal?: AbortSignal;
}

// ---------- settings & cursors ----------

const SelfHandlesSetting = z.union([z.array(z.string()), z.object({ handles: z.array(z.string()) }).transform((v) => v.handles)]);

/** settings.self_handles: JSON array of raw handles (or {handles:[…]}), written by `npm run setup:self`. */
export function readSelfHandles(db: DB): HandleKey[] {
  const raw = db.prepare(`SELECT value FROM settings WHERE key = 'self_handles'`).pluck().get() as string | undefined;
  if (!raw) return [];
  const parsed = SelfHandlesSetting.safeParse(JSON.parse(raw));
  if (!parsed.success) return [];
  const keys = parsed.data.map(handleKey).filter((k): k is HandleKey => k !== null && (k.kind === 'phone' || k.kind === 'email'));
  return [...new Map(keys.map((k) => [refString(k), k])).values()];
}

interface CursorRow {
  cursor: string;
  high_water_at: number | null;
  meta: string | null;
}

export function readCursor(db: DB, scope: string): CursorRow | undefined {
  return db.prepare('SELECT cursor, high_water_at, meta FROM source_cursors WHERE source = ? AND scope = ?').get(SOURCE, scope) as
    | CursorRow
    | undefined;
}

function writeCursor(db: DB, scope: string, cursor: string, now: number, highWaterAt: number | null = null, meta?: Record<string, unknown>): void {
  db.prepare(
    `INSERT INTO source_cursors (source, scope, cursor, high_water_at, meta, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (source, scope) DO UPDATE SET cursor = excluded.cursor,
       high_water_at = max(coalesce(source_cursors.high_water_at, 0), coalesce(excluded.high_water_at, 0)),
       meta = coalesce(excluded.meta, source_cursors.meta), updated_at = excluded.updated_at`,
  ).run(SOURCE, scope, cursor, highWaterAt, meta ? JSON.stringify(meta) : null, now);
}

/** Records the iMessage source's freshness for the Sources screen (status ok after a successful pass). */
export function recordSourceHealth(db: DB, now: number, status: 'ok' | 'error' | 'auth_required' | 'contract_broken', error?: string): void {
  const newest = (db.prepare('SELECT sent_at FROM messages WHERE source = ? ORDER BY sent_at DESC LIMIT 1').pluck().get(SOURCE) as number | undefined) ?? null;
  db.prepare(
    `INSERT INTO source_health (source, status, last_ok_at, newest_data_at, last_error, checked_at)
     VALUES (@source, @status, @ok, @newest, @error, @now)
     ON CONFLICT (source) DO UPDATE SET status = excluded.status, last_ok_at = coalesce(excluded.last_ok_at, source_health.last_ok_at),
       newest_data_at = coalesce(excluded.newest_data_at, source_health.newest_data_at), last_error = excluded.last_error,
       checked_at = excluded.checked_at`,
  ).run({ source: SOURCE, status, ok: status === 'ok' ? now : null, newest, error: error ?? null, now });
}

// ---------- page state ----------

interface PendingIdentity {
  id: string;
  k: HandleKey;
  raw: string;
  first: number;
  last: number;
  signal: ServiceReason | null;
}

interface ConvInfo {
  id: string;
  kind: ConversationKind;
}

class PageState {
  readonly pending = new Map<string, PendingIdentity>();
  readonly pendingById = new Map<string, PendingIdentity>();
  readonly identities = new Map<string, string>();
  readonly existingTouched = new Set<string>();
  readonly seen = new Map<string, { first: number; last: number }>();
  readonly signals = new Map<string, ServiceReason>();
  readonly convs = new Map<string, ConvInfo>();
  /** conversation id → message time range and latest title seen in this page (flushed at settle). */
  readonly convActivity = new Map<string, { kind: ConversationKind; first: number; last: number; title: string | null }>();
}

interface ConversationRow {
  id: string;
  kind: string;
  title: string | null;
  member_count: number | null;
  first_message_at: number | null;
  last_message_at: number | null;
}

interface MessageRow {
  id: number;
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
}

/** SQL (inside ensureMember's upsert): this sighting means the member is in the chat again. */
const REJOINS = `conversation_members.is_active = 0 AND (@source = 'roster'
  OR (@source = 'sender' AND excluded.last_seen_at > coalesce(conversation_members.left_at, 0)))`;

// ---------- the ingestor ----------

export class ImessageIngestor {
  readonly stats = emptyStats();
  private readonly now: number;
  private readonly runId: string;
  private readonly ctx: ResolveContext;
  private me: MeBinding = { personId: '', identities: new Map() };
  private meIdentityIds = new Set<string>();
  private selfRefs = new Set<string>();
  private commandFloor = Number.POSITIVE_INFINITY;
  private handleRowids: Map<number, string> | null = null;
  private readonly touched = new Map<string, number | null>();

  constructor(
    private readonly db: DB,
    private readonly client: CollectorClient,
    private readonly o: IngestOptions = {},
  ) {
    this.now = o.now ?? Date.now();
    this.runId = startRun(db, 'ingest', { jobRunId: o.jobRunId ?? null, now: this.now });
    this.ctx = { db, runId: () => this.runId, now: this.now, source: SOURCE };
  }

  private readonly statements = new Map<string, Statement>();

  /** Prepared-statement cache: a backfill runs the same few statements ~100k times. */
  private q(sql: string): Statement {
    let st = this.statements.get(sql);
    if (!st) this.statements.set(sql, (st = this.db.prepare(sql)));
    return st;
  }

  private get pageSize(): number {
    return this.o.pageSize ?? 500;
  }

  /** Me + self handles, and the command-staging floor (the messages cursor's creation time). */
  bootstrap(): void {
    tx(this.db, () => {
      const selfKeys = readSelfHandles(this.db);
      this.me = ensureMe(this.ctx, selfKeys);
      this.meIdentityIds = new Set(this.me.identities.values());
      this.selfRefs = new Set(this.me.identities.keys());
      if (!this.q('SELECT 1 FROM person_canon WHERE person_id = ?').get(this.me.personId)) rebuildPersonCanon(this.db);
      this.adoptSelfConversations();
      const cur = readCursor(this.db, 'messages');
      if (!cur) writeCursor(this.db, 'messages', '0', this.now, null, { init_at: this.now });
      // A cursor without init_at (reset by hand) relies on the 6 h age limit alone.
      const meta = cur ? (cur.meta ? (JSON.parse(cur.meta) as { init_at?: number }) : {}) : { init_at: this.now };
      this.commandFloor = meta.init_at ?? 0;
    });
  }

  /**
   * 1:1 chats whose counterpart identity now belongs to me (self handles configured after they were ingested)
   * become self threads: no member row, no sessions or interactions.
   */
  private adoptSelfConversations(): void {
    if (!this.meIdentityIds.size) return;
    const ids = JSON.stringify([...this.meIdentityIds]);
    const convs = this.q(
        `SELECT DISTINCT cm.conversation_id FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id
         WHERE c.source = ? AND c.kind = 'direct' AND cm.identity_id IN (SELECT value FROM json_each(?))`,
      )
      .pluck()
      .all(SOURCE, ids) as string[];
    for (const id of convs) {
      this.q(`UPDATE conversations SET kind = 'self', updated_at = ? WHERE id = ?`).run(this.now, id);
      this.q('DELETE FROM conversation_members WHERE conversation_id = ? AND identity_id IN (SELECT value FROM json_each(?))').run(id, ids);
      this.touch(id, null);
    }
  }

  /**
   * The 10 s pass: every new message after the cursor, then new chats' rosters. Messages go first so a sender's
   * first person row already reflects what they wrote (rosters alone would create everyone as roster_only).
   */
  async tail(): Promise<IngestStats> {
    this.bootstrap();
    let after = Number(readCursor(this.db, 'messages')?.cursor ?? 0);
    for (let page = 0; page < (this.o.maxPages ?? 200) && !this.o.signal?.aborted; page++) {
      const res = await this.client.messages({ after_rowid: after, limit: this.pageSize });
      const next = res.next_after_rowid ?? res.items.reduce((max, m) => Math.max(max, m.rowid), after);
      if (res.items.length) await this.prefetchHandles(res.items);
      const highWater = res.items.reduce<number | null>((max, m) => Math.max(max ?? 0, m.date), null);
      tx(this.db, () => {
        if (res.items.length) this.processMessages(res.items);
        if (next > after) writeCursor(this.db, 'messages', String(next), this.now, highWater);
      });
      if (!res.has_more || next <= after) break;
      after = next;
    }
    await this.syncChats(false);
    return this.finish(false);
  }

  /** The nightly pass: rosters, 48 h by-date re-read, edits, roster-only re-check, derived cleanup. */
  async overlap(): Promise<IngestStats> {
    this.bootstrap();
    const since = new Date(this.now - OVERLAP_MS).toISOString();
    const until = new Date(this.now).toISOString();
    let after = 0;
    for (let page = 0; !this.o.signal?.aborted; page++) {
      const res = await this.client.messagesByDate({ since, until, after_rowid: after, limit: this.pageSize });
      const next = res.next_after_rowid ?? res.items.reduce((max, m) => Math.max(max, m.rowid), after);
      if (res.items.length) {
        await this.prefetchHandles(res.items);
        tx(this.db, () => this.processMessages(res.items));
      }
      if (!res.has_more || next <= after) break;
      after = next;
    }
    this.throwIfAborted();
    await this.syncEdits();
    this.throwIfAborted();
    await this.syncChats(true);
    this.throwIfAborted();
    tx(this.db, () => {
      const r = reevaluateRosterOnly(this.ctx);
      this.stats.promoted += r.promoted;
      this.stats.reclassified_service += r.service;
      // A target that hasn't synced in 30 days never will (deleted, or older than Messages' retention).
      this.stats.reactions_expired += this.q('DELETE FROM pending_reactions WHERE source = ? AND first_seen_at < ?')
        .run(SOURCE, this.now - PENDING_REACTION_TTL_MS).changes;
    });
    return this.finish(true);
  }

  /** An interrupted nightly pass must fail (and be retried) rather than count as the day's success. */
  private throwIfAborted(): void {
    if (this.o.signal?.aborted) throw new DOMException('imessage overlap pass interrupted', 'AbortError');
  }

  /** Rows whose date_edited moved past the stored high-water mark (minus a minute of slack). */
  async syncEdits(): Promise<void> {
    const cur = readCursor(this.db, 'edited');
    const sinceMs = cur ? Math.max(0, Number(cur.cursor) - 60_000) : this.now - OVERLAP_MS;
    const since = new Date(sinceMs).toISOString();
    let after = 0;
    let highWater = cur ? Number(cur.cursor) : this.now - OVERLAP_MS;
    let complete = false;
    for (let page = 0; !this.o.signal?.aborted; page++) {
      const res = await this.client.edited({ since, after_rowid: after, limit: this.pageSize });
      const next = res.next_after_rowid ?? res.items.reduce((max, m) => Math.max(max, m.rowid), after);
      for (const m of res.items) if (m.date_edited !== null) highWater = Math.max(highWater, m.date_edited);
      if (res.items.length) {
        await this.prefetchHandles(res.items);
        tx(this.db, () => this.processMessages(res.items));
      }
      if (!res.has_more || next <= after) {
        complete = true;
        break;
      }
      after = next;
    }
    // Pages are rowid-ordered, not date_edited-ordered: a partial pass can't advance the mark past rows it never saw.
    if (complete) writeCursor(this.db, 'edited', String(highWater), this.now, highWater);
  }

  /** Chats and their current rosters: new chats only (cursor) or every chat (full, nightly). */
  async syncChats(full: boolean): Promise<void> {
    let after = full ? 0 : Number(readCursor(this.db, 'chats')?.cursor ?? 0);
    for (let page = 0; !this.o.signal?.aborted; page++) {
      const res = await this.client.chats({ after_rowid: after, limit: 500 });
      const next = res.next_after_rowid ?? res.items.reduce((max, c) => Math.max(max, c.chat_rowid), after);
      tx(this.db, () => {
        this.db.pragma('defer_foreign_keys = ON');
        const state = new PageState();
        for (const chat of res.items) this.processChat(chat, state, full);
        this.settle(state);
        if (!full && next > after) writeCursor(this.db, 'chats', String(next), this.now);
      });
      this.stats.chats += res.items.length;
      if (!res.has_more || next <= after) break;
      after = next;
    }
  }

  /**
   * Re-sessionizes every conversation with messages past the 'sessionized' watermark (so a pass that died after
   * committing pages is caught up by the next one) plus those touched in memory (kind changes, re-reads), then
   * finishes the run, dropping it if it journaled nothing.
   */
  private finish(nightly: boolean): IngestStats {
    const mark = Number(readCursor(this.db, 'sessionized')?.cursor ?? 0);
    const fresh = this.q('SELECT conversation_id, min(sent_at) AS from_at FROM messages WHERE source = ? AND id > ? GROUP BY conversation_id')
      .all(SOURCE, mark) as { conversation_id: string; from_at: number }[];
    for (const f of fresh) this.touch(f.conversation_id, f.from_at);
    const maxId = (this.q('SELECT max(id) FROM messages WHERE id > ? AND source = ?').pluck().get(mark, SOURCE) as number | null) ?? mark;
    const r = refreshConversations(this.db, this.touched, { now: this.now });
    if (maxId > mark) writeCursor(this.db, 'sessionized', String(maxId), this.now);
    this.stats.sessions_changed += r.sessionsChanged + r.sessionsRemoved;
    this.stats.interactions_upserted += r.interactionsUpserted;
    this.stats.interactions_deleted += r.interactionsDeleted;
    if (nightly) this.stats.interactions_deleted += pruneDerivedInteractions(this.db);
    this.touched.clear();
    const batches = this.q('SELECT count(*) FROM change_batches WHERE run_id = ?').pluck().get(this.runId) as number;
    if (batches === 0) this.q('DELETE FROM runs WHERE id = ?').run(this.runId);
    else finishRun(this.db, this.runId, 'ok', { now: this.now, summary: { batches } });
    return this.stats;
  }

  /** Call when a pass fails midway: closes (or drops) the run. */
  abort(): void {
    const batches = this.q('SELECT count(*) FROM change_batches WHERE run_id = ?').pluck().get(this.runId) as number;
    if (batches === 0) this.q('DELETE FROM runs WHERE id = ?').run(this.runId);
    else finishRun(this.db, this.runId, 'partial', { now: this.now, summary: { batches } });
  }

  /** Group events may name a member by handle ROWID; the handle table is fetched once per pass when needed. */
  private async prefetchHandles(items: readonly Msg[]): Promise<void> {
    if (this.handleRowids) return;
    if (!items.some((m) => typeof m.other_handle === 'number' && m.other_handle > 0)) return;
    const res = await this.client.handles();
    this.handleRowids = new Map(res.items.map((h) => [h.rowid, h.id]));
  }

  // ---------- per page ----------

  /** Writes one page of messages (caller holds the transaction). */
  processMessages(items: readonly Msg[]): void {
    this.db.pragma('defer_foreign_keys = ON');
    const state = new PageState();
    for (const m of [...items].sort((a, b) => a.rowid - b.rowid)) this.processMessage(m, state);
    this.settle(state);
    this.resolvePending();
    this.stats.pages++;
  }

  /** Applies parked reactions (adds before removals) and links replies whose targets have now arrived. */
  private resolvePending(): void {
    const ready = this.q(
        `SELECT p.*, m.id AS message_id FROM pending_reactions p
         JOIN messages m ON m.source = p.source AND m.source_msg_id = p.target_source_msg_id
         WHERE p.source = ?
         ORDER BY p.removal, p.at`,
      )
      .all(SOURCE) as (PendingReactionRow & { message_id: number })[];
    for (const p of ready) {
      if (!p.removal) {
        this.stats.reactions += this.q(
            `INSERT INTO message_reactions (source_reaction_id, message_id, actor_identity_id, is_from_me, type, emoji, removed, at)
             VALUES (?, ?, ?, ?, ?, ?, 0, ?) ON CONFLICT (source_reaction_id) DO NOTHING`,
          )
          .run(p.source_reaction_id, p.message_id, p.actor_identity_id, p.is_from_me, p.type, p.emoji, p.at).changes;
      } else {
        this.stats.reactions_removed += this.q(
            `UPDATE message_reactions SET removed = 1 WHERE message_id = ? AND type = ? AND is_from_me = ?
               AND coalesce(actor_identity_id, '') = coalesce(?, '') AND at <= ? AND removed = 0`,
          )
          .run(p.message_id, p.type, p.is_from_me, p.actor_identity_id, p.at).changes;
      }
      this.q('DELETE FROM pending_reactions WHERE source_reaction_id = ?').run(p.source_reaction_id);
      this.stats.reactions_resolved++;
    }
    this.stats.replies_linked += this.q(
        `UPDATE messages SET reply_to_msg_id = (
           SELECT t.id FROM messages t WHERE t.source = messages.source AND t.source_msg_id = messages.thread_root_source_id)
         WHERE source = ? AND reply_to_msg_id IS NULL AND thread_root_source_id IS NOT NULL
           AND EXISTS (SELECT 1 FROM messages t WHERE t.source = messages.source AND t.source_msg_id = messages.thread_root_source_id)`,
      )
      .run(SOURCE).changes;
  }

  /** Creates the page's new people (service → provisional fixpoint → roster_only) and re-checks touched ones. */
  private settle(state: PageState): void {
    for (const [sourceConvId, a] of state.convActivity) {
      this.upsertConversation({ sourceConvId, kind: a.kind, title: a.title, memberCount: null, firstAt: a.first, lastAt: a.last });
    }
    for (const [id, s] of state.seen) touchIdentitySeen(this.db, id, s.first, s.last);
    let remaining = [...state.pending.values()];
    let created = 0;
    const create = (p: PendingIdentity, status: 'provisional' | 'roster_only', service: ServiceReason | null) => {
      createPersonForHandle(this.ctx, p.k, { identityId: p.id, status, service, raw: p.raw, firstSeenAt: p.first, lastSeenAt: p.last });
      created++;
      if (service) this.stats.people_service++;
      else if (status === 'provisional') this.stats.people_provisional++;
      else this.stats.people_roster_only++;
    };
    remaining = remaining.filter((p) => {
      const reason = serviceReasonFor(this.db, p.id, p.k, p.signal);
      if (reason) create(p, 'roster_only', reason);
      return !reason;
    });
    // A provisional person can make a group "known" for the next one, so iterate to a fixpoint.
    for (let changed = true; changed; ) {
      changed = false;
      remaining = remaining.filter((p) => {
        if (!qualifies(qualification(this.db, p.id))) return true;
        create(p, 'provisional', null);
        changed = true;
        return false;
      });
    }
    for (const p of remaining) create(p, 'roster_only', null);
    if (state.existingTouched.size) {
      const r = reevaluateRosterOnly(this.ctx, { identityIds: state.existingTouched, signals: state.signals });
      this.stats.promoted += r.promoted;
      this.stats.reclassified_service += r.service;
      created += r.promoted + r.service;
    }
    if (created) rebuildPersonCanon(this.db);
  }

  /** Identity id for a raw handle: me, an existing identity, or one allocated for creation at settle(). */
  private resolve(raw: string, at: number, state: PageState): string | null {
    const k = handleKey(raw);
    if (!k) {
      this.stats.unresolvable_handles++;
      return null;
    }
    const ref = refString(k);
    if (this.selfRefs.has(ref)) return this.me.identities.get(ref) ?? null;
    let id = state.identities.get(ref);
    if (id === undefined) {
      const row = findIdentity(this.db, k);
      if (row) {
        id = row.id;
        state.existingTouched.add(id);
      } else {
        id = uuidv7(this.now);
        const p: PendingIdentity = { id, k, raw, first: at, last: at, signal: null };
        state.pending.set(ref, p);
        state.pendingById.set(id, p);
      }
      state.identities.set(ref, id);
    }
    const p = state.pending.get(ref);
    if (p) {
      p.first = Math.min(p.first, at);
      p.last = Math.max(p.last, at);
    } else {
      const s = state.seen.get(id);
      state.seen.set(id, { first: Math.min(s?.first ?? at, at), last: Math.max(s?.last ?? at, at) });
    }
    return id;
  }

  private isSelfHandle(raw: string | null): boolean {
    const k = raw ? handleKey(raw) : null;
    return k !== null && this.selfRefs.has(refString(k));
  }

  private conversationKind(style: number | null, identifier: string | null): ConversationKind {
    if (isGroupChat(style, identifier)) return 'group';
    const k = identifier ? handleKey(identifier) : null;
    if (k && this.selfRefs.has(refString(k))) return 'self';
    if (k && (k.kind === 'shortcode' || k.kind === 'business_chat' || isPartifulSender(k))) return 'business';
    return 'direct';
  }

  /** Inserts or updates the conversation row (only changed columns) and returns its id. */
  private upsertConversation(c: {
    sourceConvId: string;
    kind: ConversationKind;
    title: string | null;
    memberCount: number | null;
    firstAt: number | null;
    lastAt: number | null;
  }): string {
    const cur = this.q('SELECT id, kind, title, member_count, first_message_at, last_message_at FROM conversations WHERE source = ? AND source_conv_id = ?')
      .get(SOURCE, c.sourceConvId) as ConversationRow | undefined;
    const title = c.title?.trim() || null;
    if (!cur) {
      const id = uuidv7(this.now);
      this.q(
          `INSERT INTO conversations (id, source, source_conv_id, kind, title, title_source, member_count, first_message_at, last_message_at,
             created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, SOURCE, c.sourceConvId, c.kind, title, title ? 'chat' : null, c.memberCount, c.firstAt, c.lastAt, this.now, this.now);
      return id;
    }
    const next = {
      kind: c.kind,
      title: title ?? cur.title,
      member_count: c.memberCount ?? cur.member_count,
      first_message_at: c.firstAt === null ? cur.first_message_at : Math.min(cur.first_message_at ?? c.firstAt, c.firstAt),
      last_message_at: c.lastAt === null ? cur.last_message_at : Math.max(cur.last_message_at ?? c.lastAt, c.lastAt),
    };
    if (
      next.kind !== cur.kind ||
      next.title !== cur.title ||
      next.member_count !== cur.member_count ||
      next.first_message_at !== cur.first_message_at ||
      next.last_message_at !== cur.last_message_at
    ) {
      this.q(
          `UPDATE conversations SET kind = @kind, title = @title, title_source = CASE WHEN @titleChanged THEN 'chat' ELSE title_source END,
             member_count = @member_count, first_message_at = @first_message_at, last_message_at = @last_message_at, updated_at = @now
           WHERE id = @id`,
        )
        .run({ ...next, titleChanged: next.title !== cur.title ? 1 : 0, now: this.now, id: cur.id });
      if (next.kind !== cur.kind) this.touch(cur.id, null);
    }
    return cur.id;
  }

  /**
   * Upserts a member. A current roster (fetched after the messages it covers) is authoritative and reactivates a
   * member marked as left; a post after left_at does too.
   */
  private ensureMember(conversationId: string, identityId: string, source: 'roster' | 'group_event' | 'sender', at: number): void {
    if (this.meIdentityIds.has(identityId)) return;
    this.q(
        `INSERT INTO conversation_members (conversation_id, identity_id, source, is_active, first_seen_at, last_seen_at)
         VALUES (@conv, @ident, @source, 1, @at, @at)
         ON CONFLICT (conversation_id, identity_id) DO UPDATE SET
           first_seen_at = min(first_seen_at, excluded.first_seen_at), last_seen_at = max(last_seen_at, excluded.last_seen_at),
           is_active = CASE WHEN ${REJOINS} THEN 1 ELSE is_active END,
           left_at = CASE WHEN ${REJOINS} THEN NULL ELSE left_at END
         WHERE excluded.first_seen_at < first_seen_at OR excluded.last_seen_at > last_seen_at OR (${REJOINS})`,
      )
      .run({ conv: conversationId, ident: identityId, source, at });
  }

  private touch(conversationId: string, sentAt: number | null): void {
    if (!this.touched.has(conversationId)) {
      this.touched.set(conversationId, sentAt);
      return;
    }
    const cur = this.touched.get(conversationId)!;
    this.touched.set(conversationId, cur === null || sentAt === null ? null : Math.min(cur, sentAt));
  }

  private processChat(chat: Chat, state: PageState, full: boolean): void {
    const kind = this.conversationKind(chat.style, chat.chat_identifier);
    const convId = this.upsertConversation({
      sourceConvId: chat.chat_guid,
      kind,
      title: chat.display_name,
      memberCount: chat.members.length + 1,
      firstAt: null,
      lastAt: chat.last_message_at,
    });
    state.convs.set(chat.chat_guid, { id: convId, kind });
    const at = chat.last_message_at ?? this.now;
    const members = new Set<string>();
    const handles = kind === 'group' ? chat.members : [chat.chat_identifier ?? chat.members[0] ?? ''].filter(Boolean);
    for (const raw of handles) {
      const id = this.resolve(raw, at, state);
      if (!id || this.meIdentityIds.has(id)) continue;
      members.add(id);
      this.ensureMember(convId, id, 'roster', at);
    }
    if (full && kind === 'group' && members.size) {
      // The roster is the current truth: active members missing from it have left.
      const active = this.q('SELECT identity_id FROM conversation_members WHERE conversation_id = ? AND is_active = 1')
        .pluck()
        .all(convId) as string[];
      const leave = this.q(
        'UPDATE conversation_members SET is_active = 0, left_at = coalesce(left_at, ?) WHERE conversation_id = ? AND identity_id = ?',
      );
      for (const id of active) if (!members.has(id)) leave.run(this.now, convId, id);
    }
  }

  private conversationFor(m: Msg, state: PageState): ConvInfo | null {
    const senderKey = m.sender_handle ? handleKey(m.sender_handle) : null;
    const sourceConvId = m.chat_guid ?? (senderKey ? `handle:${refString(senderKey)}` : null);
    if (!sourceConvId) return null;
    let conv = state.convs.get(sourceConvId);
    if (!conv) {
      const identifier = m.chat_identifier ?? (m.chat_guid ? null : m.sender_handle);
      const kind = this.conversationKind(m.chat_style, identifier);
      const id = this.upsertConversation({ sourceConvId, kind, title: m.chat_display_name, memberCount: null, firstAt: m.date, lastAt: m.date });
      conv = { id, kind };
      state.convs.set(sourceConvId, conv);
      if ((kind === 'direct' || kind === 'business') && identifier) {
        const counterpart = this.resolve(identifier, m.date, state);
        if (counterpart) this.ensureMember(conv.id, counterpart, 'roster', m.date);
      }
    }
    const a = state.convActivity.get(sourceConvId);
    state.convActivity.set(sourceConvId, {
      kind: conv.kind,
      first: Math.min(a?.first ?? m.date, m.date),
      last: Math.max(a?.last ?? m.date, m.date),
      title: m.chat_display_name?.trim() || a?.title || null,
    });
    return conv;
  }

  private processMessage(m: Msg, state: PageState): void {
    const conv = this.conversationFor(m, state);
    if (!conv) {
      this.stats.skipped_no_chat++;
      return;
    }
    // chat.db's handle on my own 1:1 sends is the counterpart, so is_from_me rows never take a sender handle; an
    // iPhone-typed note-to-self can arrive with my own handle and is_from_me=0: that row is mine too.
    const selfSender = !m.is_from_me && this.isSelfHandle(m.sender_handle);
    const fromMe = m.is_from_me || selfSender;
    const senderId = fromMe
      ? selfSender
        ? this.resolve(m.sender_handle!, m.date, state)
        : null
      : m.sender_handle
        ? this.resolve(m.sender_handle, m.date, state)
        : null;
    if (!fromMe && senderId) {
      const signal = messageServiceSignal(m);
      if (signal) {
        state.signals.set(senderId, signal);
        const pending = state.pendingById.get(senderId);
        if (pending) pending.signal ??= signal;
      }
    }

    const reaction = m.assoc ? reactionInfo(m.assoc.type) : null;
    if (reaction) {
      this.storeReaction(m, reaction, senderId, fromMe);
      return;
    }

    const text = cleanText(m.text);
    const kind = messageKind(m, text);
    const isBot = this.isBotRow(m, fromMe);
    const messageId = this.upsertMessage(m, conv, senderId, fromMe, text, kind, isBot);
    if (conv.kind === 'group' && senderId && !fromMe) this.ensureMember(conv.id, senderId, 'sender', m.date);
    if (conv.kind === 'group' && kind === 'group_event') this.storeMembershipEvent(m, conv, messageId, senderId, fromMe, state);
    if (!fromMe && senderId && m.sender_handle) {
      const k = handleKey(m.sender_handle);
      if (k && isPartifulSender(k) && storePartifulSignal(this.db, { messageId, conversationId: conv.id, sentAt: m.date, text, now: this.now })) {
        this.stats.partiful_signals++;
      }
    }
    if (conv.kind === 'self') this.maybeStageCommand(m, messageId, text, kind, isBot);
    this.touch(conv.id, m.date);
  }

  /**
   * PLAN "Two-way texting" bot-row rules: the marker, a GUID the sender recorded, or (for my own rows, while a send's
   * GUIDs aren't recorded yet) the raw text's hash matching a send started within 30 s. URL balloons are links.
   */
  private isBotRow(m: Msg, fromMe: boolean): boolean {
    if (isBotText(m.text)) return true;
    if (this.q('SELECT 1 FROM outbound_guids WHERE guid = ?').get(m.guid) !== undefined) return true;
    if (!fromMe || m.text === null) return false;
    return (
      this.q(
        `SELECT 1 FROM outbound_messages WHERE text_hash = ? AND created_at BETWEEN ? AND ?
           AND status IN ('queued','sending','sent','delivered','unverified') LIMIT 1`,
      ).get(outboundTextHash(m.text), m.date - IN_FLIGHT_MS, m.date + IN_FLIGHT_MS) !== undefined
    );
  }

  private messageIdByGuid(guid: string | null): number | null {
    if (!guid) return null;
    return (
      (this.q('SELECT id FROM messages WHERE source = ? AND source_msg_id = ?').pluck().get(SOURCE, stripPartPrefix(guid)) as
        | number
        | undefined) ?? null
    );
  }

  private upsertMessage(
    m: Msg,
    conv: ConvInfo,
    senderId: string | null,
    fromMe: boolean,
    text: string | null,
    kind: MessageKind,
    isBot: boolean,
  ): number {
    const existing = this.q(
        `SELECT id, text, text_source, edited_at, retracted_at, kind, is_bot, is_spam, attachments, content_key, reply_to_msg_id
         FROM messages WHERE source = ? AND source_msg_id = ?`,
      )
      .get(SOURCE, m.guid) as MessageRow | undefined;
    const attachments = m.attachments.length ? JSON.stringify(m.attachments) : null;
    const replyTo = this.messageIdByGuid(m.thread_originator_guid);
    // An unsent message keeps no text; otherwise a re-read never blanks text an earlier read decoded.
    const nextText = m.date_retracted !== null ? text : (text ?? existing?.text ?? null);
    const row = {
      text: nextText,
      text_source: text !== null ? m.text_source : (existing?.text_source ?? m.text_source),
      edited_at: m.date_edited ?? existing?.edited_at ?? null,
      retracted_at: m.date_retracted ?? existing?.retracted_at ?? null,
      kind,
      is_bot: isBot || existing?.is_bot === 1 ? 1 : 0,
      is_spam: m.is_spam ? 1 : 0,
      attachments,
      content_key: contentKey(conv.id, fromMe ? 'me' : (senderId ?? '?'), m.date, nextText) ?? existing?.content_key ?? null,
      reply_to_msg_id: replyTo ?? existing?.reply_to_msg_id ?? null,
    };
    if (!existing) {
      const id = Number(
        this.q(
            `INSERT INTO messages (source, source_msg_id, conversation_id, sender_identity_id, is_from_me, sent_at, edited_at, retracted_at,
               kind, text, text_source, reply_to_msg_id, reply_to_source_id, thread_root_source_id, attachments, service, balloon_bundle_id,
               is_spam, is_bot, content_key, dup_of, source_row_ref, ingested_at, updated_at)
             VALUES (@source, @guid, @conv, @sender, @fromMe, @sentAt, @edited_at, @retracted_at, @kind, @text, @text_source, @reply_to_msg_id,
               @replyGuid, @threadGuid, @attachments, @service, @balloon, @is_spam, @is_bot, @content_key, @dupOf, @rowRef, @now, @now)`,
          )
          .run({
            ...row,
            source: SOURCE,
            guid: m.guid,
            conv: conv.id,
            sender: senderId,
            fromMe: fromMe ? 1 : 0,
            sentAt: m.date,
            replyGuid: m.reply_to_guid,
            threadGuid: m.thread_originator_guid,
            service: m.service,
            balloon: m.balloon_bundle_id,
            dupOf: kind === 'link' && nextText !== null ? this.linkPreviewOf(conv.id, fromMe, senderId, m.date, nextText) : null,
            rowRef: `rowid:${m.rowid}`,
            now: this.now,
          }).lastInsertRowid,
      );
      this.stats.messages_new++;
      return id;
    }
    const changed = (Object.keys(row) as (keyof typeof row)[]).filter((c) => row[c] !== existing[c]);
    if (changed.length) {
      this.q(`UPDATE messages SET ${changed.map((c) => `${c} = @${c}`).join(', ')}, updated_at = @now WHERE id = @id`)
        .run({ ...Object.fromEntries(changed.map((c) => [c, row[c]])), now: this.now, id: existing.id });
      this.stats.messages_updated++;
    }
    return existing.id;
  }

  /**
   * A URL-only row next to (±10 s) a text row of the same sender that already contains the URL is chat.db's
   * link-preview duplicate: kept, but marked dup_of so it never counts as activity.
   */
  private linkPreviewOf(conversationId: string, fromMe: boolean, senderId: string | null, at: number, url: string): number | null {
    return (
      (this.q(
          `SELECT id FROM messages WHERE conversation_id = @conv AND is_from_me = @fromMe AND sender_identity_id IS @sender
             AND kind <> 'link' AND sent_at BETWEEN @at - 10000 AND @at + 10000 AND instr(text, @url) > 0
           ORDER BY abs(sent_at - @at) LIMIT 1`,
        )
        .pluck()
        .get({ conv: conversationId, fromMe: fromMe ? 1 : 0, sender: senderId, at, url: url.trim() }) as number | undefined) ?? null
    );
  }

  private storeReaction(m: Msg, r: { type: string; removal: boolean }, actorId: string | null, fromMe: boolean): void {
    const targetGuid = m.assoc?.target_guid ?? null;
    const target = this.messageIdByGuid(targetGuid);
    if (target === null) {
      // Out-of-order sync: park it until the target arrives (resolvePending, every page).
      if (targetGuid) {
        this.stats.reactions_pending += this.q(
            `INSERT INTO pending_reactions (source_reaction_id, target_source_msg_id, actor_identity_id, is_from_me, type, emoji,
               removal, at, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (source_reaction_id) DO NOTHING`,
          )
          .run(m.guid, stripPartPrefix(targetGuid), actorId, fromMe ? 1 : 0, r.type, m.assoc?.emoji ?? null, r.removal ? 1 : 0, m.date, this.now)
          .changes;
      }
      return;
    }
    if (!r.removal) {
      this.stats.reactions += this.q(
          `INSERT INTO message_reactions (source_reaction_id, message_id, actor_identity_id, is_from_me, type, emoji, removed, at)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?) ON CONFLICT (source_reaction_id) DO NOTHING`,
        )
        .run(m.guid, target, actorId, fromMe ? 1 : 0, r.type, m.assoc?.emoji ?? null, m.date).changes;
      return;
    }
    this.stats.reactions_removed += this.q(
        `UPDATE message_reactions SET removed = 1 WHERE message_id = ? AND type = ? AND is_from_me = ?
           AND coalesce(actor_identity_id, '') = coalesce(?, '') AND at <= ? AND removed = 0`,
      )
      .run(target, r.type, fromMe ? 1 : 0, actorId, m.date).changes;
  }

  private resolveOther(other: number | string | null, at: number, state: PageState): string | null {
    if (other === null || other === 0 || other === '') return null;
    const raw = typeof other === 'number' ? this.handleRowids?.get(other) : other;
    return raw ? this.resolve(raw, at, state) : null;
  }

  private storeMembershipEvent(m: Msg, conv: ConvInfo, messageId: number, senderId: string | null, fromMe: boolean, state: PageState): void {
    const action = membershipAction(m.item_type, m.group_action_type);
    if (!action) return;
    let identityId: string | null = null;
    if (action === 'add' || action === 'remove') identityId = this.resolveOther(m.other_handle, m.date, state);
    else if (action === 'leave') identityId = fromMe ? null : senderId;
    const newTitle = action === 'rename' ? (m.group_title?.trim() || null) : null;
    this.stats.membership_events += this.q(
        `INSERT INTO membership_events (conversation_id, identity_id, actor_identity_id, action, new_title, at, message_id)
         VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (dedupe_key) DO NOTHING`,
      )
      .run(conv.id, identityId, fromMe ? null : senderId, action, newTitle, m.date, messageId).changes;

    if (action === 'rename') {
      if (newTitle) {
        this.q(`UPDATE conversations SET title = ?, title_source = 'group_event', updated_at = ? WHERE id = ? AND title IS NOT ?`)
          .run(newTitle, this.now, conv.id, newTitle);
      }
      return;
    }
    if (!identityId || this.meIdentityIds.has(identityId)) return;
    if (action === 'add') {
      this.ensureMember(conv.id, identityId, 'group_event', m.date);
      // A re-read of an add older than a later leave changes nothing; a re-add after a leave reactivates.
      this.q(
          `UPDATE conversation_members SET is_active = 1, left_at = NULL,
             joined_at = CASE WHEN joined_at IS NULL OR is_active = 0 THEN @t ELSE min(joined_at, @t) END
           WHERE conversation_id = @c AND identity_id = @i AND (left_at IS NULL OR left_at <= @t)
             AND (is_active = 0 OR joined_at IS NULL OR joined_at > @t)`,
        )
        .run({ t: m.date, c: conv.id, i: identityId });
    } else {
      this.q(
          `UPDATE conversation_members SET is_active = 0, left_at = @t
           WHERE conversation_id = @c AND identity_id = @i AND (joined_at IS NULL OR joined_at <= @t) AND (left_at IS NULL OR left_at < @t)`,
        )
        .run({ t: m.date, c: conv.id, i: identityId });
    }
  }

  /**
   * Self-thread rows become pending inbound_commands unless they are bot rows, not plain text (links, balloons,
   * attachment-only rows, reactions), older than COMMAND_MAX_AGE_MS, older than the cursor's creation, or a second
   * copy of a command already staged. A text sent with a screenshot is staged as text; the executor fetches the
   * row's images (or attachment-only rows sent just before it) for the intent step (adapters/imessage/attachments.ts).
   */
  private maybeStageCommand(m: Msg, messageId: number, text: string | null, kind: MessageKind, isBot: boolean): void {
    if (isBot || kind !== 'text' || text === null || m.balloon_bundle_id || URL_ONLY.test(text)) return;
    if (m.date < this.commandFloor || this.now - m.date > COMMAND_MAX_AGE_MS) return;
    const raw = m.text ?? text;
    const dup = this.q(
        `SELECT 1 FROM inbound_commands ic JOIN messages msg ON msg.id = ic.message_id JOIN conversations c ON c.id = msg.conversation_id
         WHERE c.kind = 'self' AND ic.raw_text = ? AND abs(msg.sent_at - ?) <= ? AND ic.message_id <> ?`,
      )
      .get(raw, m.date, COMMAND_DUP_WINDOW_MS, messageId);
    if (dup) return;
    this.stats.commands_staged += this.q(
        `INSERT INTO inbound_commands (id, message_id, raw_text, status, created_at) VALUES (?, ?, ?, 'pending', ?)
         ON CONFLICT (message_id) DO NOTHING`,
      )
      .run(uuidv7(this.now), messageId, raw, this.now).changes;
  }
}

// ---------- job entry points ----------

export async function ingestTail(db: DB, client: CollectorClient, o: IngestOptions = {}): Promise<IngestStats> {
  const ing = new ImessageIngestor(db, client, o);
  try {
    return await ing.tail();
  } catch (e) {
    ing.abort();
    throw e;
  }
}

export async function ingestOverlap(db: DB, client: CollectorClient, o: IngestOptions = {}): Promise<IngestStats> {
  const ing = new ImessageIngestor(db, client, o);
  try {
    return await ing.overlap();
  } catch (e) {
    ing.abort();
    throw e;
  }
}
