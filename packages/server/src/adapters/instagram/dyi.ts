/**
 * Instagram "Download your information" importer (PLAN "Ingestion → Instagram → DYI importer", intelligence §1.1).
 * Reads JSON-format exports dropped in IMPORTS_DIR (zip or extracted folder; dyiFiles.ts), mojibake fixed first:
 *   personal_information   my name and username: names mark my own messages, the username binds to 'me'.
 *   threads                each thread is mapped once (ig_dyi_threads): onto the Beeper conversation that shares ≥3
 *                          messages with it (±2 s, same normalized-text hash), whose senders then inherit the Beeper
 *                          identities, or onto its own instagram_dyi conversation with weak per-thread identities
 *                          (`ig_dyi:<thread>:<name>`, instagram_name, provisional at most). Display names are alias
 *                          observations, never keys. Messages Beeper already has are skipped; the rest are
 *                          episodes with source 'instagram_dyi' (idempotent natural keys).
 *   followers / following  instagram_username identities (hidden roster_only people until they qualify) plus
 *                          instagram_follows rows with the follow dates (the earliest one ever exported is kept).
 * Re-imports are no-ops (import_files by content hash); the owner's files are never moved or deleted.
 * Stats and health are counts only.
 */
import crypto from 'node:crypto';
import { normalizeNamePart } from '@yb/shared';
import type { Statement } from 'better-sqlite3';
import { z } from 'zod';
import type { DB } from '../../db/connection';
import { tx } from '../../db/tx';
import { attachExternalIdentity, normalizeExternalKey, recordAlias } from '../../identity/external';
import { ensureMe } from '../../identity/resolver';
import { sourceRun, type SourceRun } from '../common/context';
import { cursorMeta, readCursor, recordSourceHealth, writeCursor } from '../common/cursors';
import { episodeWriter, nonZeroStats, type ConversationKind, type EpisodeMessageKind, type EpisodeWriter } from '../common/episodes';
import { URL_ONLY } from '../imessage/mapping';
import {
  DYI_SOURCE,
  importFileBySha,
  knownByStat,
  MAX_ATTEMPTS,
  openUnit,
  recordImportFile,
  scanImports,
  sha256File,
  touchImportFile,
  type DyiEntry,
  type DyiUnit,
  type OpenedUnit,
} from './dyiFiles';
import { promoteQualified } from './identities';
import { MATCH_WINDOW_MS, parseDyiJson, textHash } from './text';

export { DYI_SOURCE };

/** Beeper's Instagram messages (what a DYI thread is matched and deduplicated against). */
const BEEPER_SOURCE = 'instagram';
/** Messages a thread needs in common with one Beeper conversation to be mapped onto it. */
export const MIN_THREAD_MATCHES = 3;
/** Text messages per thread compared against Beeper (newest first; enough to decide, bounded for huge threads). */
const MATCH_SAMPLE = 2_000;
const SELF_SCOPE = 'self';

// ---------------------------------------------------------------------------------------- export shapes

const optStr = z.string().nullish();
const media = z.array(z.unknown()).nullish();

const DyiReaction = z.looseObject({ reaction: z.string(), actor: z.string(), timestamp: z.number().nullish() });

export const DyiMessage = z.looseObject({
  sender_name: optStr,
  timestamp_ms: z.number(),
  content: optStr,
  photos: media,
  videos: media,
  audio_files: media,
  gifs: media,
  files: media,
  sticker: z.unknown().optional(),
  share: z.looseObject({ link: optStr, share_text: optStr }).nullish(),
  reactions: z.array(DyiReaction).nullish(),
  call_duration: z.number().nullish(),
  is_unsent: z.boolean().nullish(),
});
export type DyiMessage = z.output<typeof DyiMessage>;

const DyiThread = z.looseObject({
  participants: z.array(z.looseObject({ name: z.string() })).nullish(),
  messages: z.array(z.unknown()).nullish(),
  title: optStr,
  thread_path: optStr,
  is_still_participant: z.boolean().nullish(),
});

const RelationshipEntry = z.looseObject({
  title: optStr,
  string_list_data: z.array(z.looseObject({ href: optStr, value: optStr, timestamp: z.number().nullish() })).nullish(),
});

const PersonalInfo = z.looseObject({
  profile_user: z.array(z.looseObject({ string_map_data: z.record(z.string(), z.looseObject({ value: optStr })).nullish() })).nullish(),
});

export class DyiFormatError extends Error {
  constructor(readonly what: string) {
    super(`export file is not in the expected Instagram JSON shape (${what})`);
    this.name = 'DyiFormatError';
  }
}

// ---------------------------------------------------------------------------------------- pure mapping

/** Stable thread key: the numeric thread id at the end of the folder name ("<name>_<digits>"), else the folder. */
export function threadKeyOf(folder: string, threadPath?: string | null): string {
  for (const s of [folder, threadPath?.split('/').pop() ?? '']) {
    const m = /_(\d{6,})$/.exec(s);
    if (m) return `t${m[1]}`;
  }
  return `f:${folder.toLowerCase()}`;
}

const SYSTEM_CONTENT = [
  /^liked a message\.?$/i,
  /^reacted .{1,24} to (?:your|a) message\.?$/i,
  /^.{1,80} (?:started|ended|joined|missed) (?:an? )?(?:audio|video) (?:call|chat)\.?$/i,
  /^(?:this message was unsent|.{1,80} unsent a message)\.?$/i,
  /^.{1,80} (?:named the group|changed the group|added .{1,80} to the group|left the group|removed .{1,80} from the group)/i,
];
const ATTACHMENT_NOTICE = /^.{1,80} sent an attachment\.?$/i;

export interface MappedDyiMessage {
  kind: EpisodeMessageKind;
  text: string | null;
  attachments: Record<string, unknown>[];
  retracted: boolean;
}

/** DYI message → kind, text and attachment metadata (types only: never media paths). */
export function mapDyiMessage(m: DyiMessage): MappedDyiMessage {
  const content = m.content?.trim() ? m.content.trim() : null;
  const attachments: Record<string, unknown>[] = [];
  const add = (type: string, list: unknown[] | null | undefined) => {
    for (let i = 0; i < (list?.length ?? 0); i++) attachments.push({ type });
  };
  add('img', m.photos);
  add('video', m.videos);
  add('audio', m.audio_files);
  add('gif', m.gifs);
  add('file', m.files);
  if (m.sticker) attachments.push({ type: 'img', is_sticker: true });
  if (m.is_unsent) return { kind: 'system', text: null, attachments: [], retracted: true };
  if (m.call_duration !== undefined && m.call_duration !== null) return { kind: 'system', text: content, attachments, retracted: false };
  if (content && SYSTEM_CONTENT.some((r) => r.test(content))) return { kind: 'system', text: content, attachments, retracted: false };
  if (content && ATTACHMENT_NOTICE.test(content) && !m.share) return { kind: 'attachment', text: null, attachments, retracted: false };
  const link = m.share?.link?.trim() || null;
  if (link) return { kind: 'link', text: content ?? link, attachments, retracted: false };
  if (content) return { kind: URL_ONLY.test(content) ? 'link' : 'text', text: content, attachments, retracted: false };
  if (m.sticker) return { kind: 'sticker', text: null, attachments, retracted: false };
  if (attachments.length) return { kind: 'attachment', text: null, attachments, retracted: false };
  return { kind: 'system', text: null, attachments, retracted: false };
}

const MEDIA_KINDS = new Set(['attachment', 'sticker', 'link']);

/** Natural key of a DYI message: thread, time, sender, content, and its rank among identical ones. */
export function dyiMessageKey(threadKey: string, m: DyiMessage, mapped: MappedDyiMessage, occurrence: number): string {
  const h = crypto
    .createHash('sha256')
    .update([threadKey, m.timestamp_ms, normalizeNamePart(m.sender_name), mapped.text ?? '', mapped.kind, mapped.attachments.length, occurrence].join('|'))
    .digest('base64url')
    .slice(0, 24);
  return `dyi:${h}`;
}

/** The relationship list of a followers/following file (top-level array or a relationships_* property). */
export function relationshipEntries(json: unknown): { username: string; at: number | null }[] {
  let list: unknown[] = [];
  if (Array.isArray(json)) list = json;
  else if (json && typeof json === 'object') {
    for (const [k, v] of Object.entries(json)) if (/^relationships_/i.test(k) && Array.isArray(v)) list = list.concat(v);
  }
  const out: { username: string; at: number | null }[] = [];
  for (const raw of list) {
    const e = RelationshipEntry.safeParse(raw);
    if (!e.success) continue;
    const d = e.data.string_list_data?.[0];
    const candidates = [d?.value, e.data.title, d?.href?.replace(/\/_u\//, '/')];
    const username = candidates.map((c) => (c ? normalizeExternalKey('instagram_username', c)?.key : null)).find(Boolean);
    if (username) out.push({ username, at: d?.timestamp ? Math.round(d.timestamp * 1000) : null });
  }
  return out;
}

/** My name and username from personal_information.json. */
export function personalInfo(json: unknown): { name: string | null; username: string | null } {
  const p = PersonalInfo.safeParse(json);
  const map = p.success ? (p.data.profile_user?.[0]?.string_map_data ?? {}) : {};
  const get = (re: RegExp) => Object.entries(map).find(([k]) => re.test(k))?.[1]?.value?.trim() || null;
  return { name: get(/^name$/i), username: get(/^username$/i) };
}

// ---------------------------------------------------------------------------------------- importer

export interface DyiImportOptions {
  importsDir: string;
  now?: number;
  jobRunId?: number | null;
  signal?: AbortSignal;
}

export interface DyiImportStats {
  folder_missing: number;
  files_seen: number;
  files_known: number;
  files_imported: number;
  files_failed: number;
  files_ignored: number;
  html_exports: number;
  threads: number;
  threads_matched: number;
  threads_new_conversations: number;
  dyi_messages: number;
  duplicates_skipped: number;
  invalid_items: number;
  follows: number;
  self_names: number;
  promoted: number;
  [k: string]: number;
}

interface SelfState {
  names: string[];
  usernames: string[];
}

interface ThreadRow {
  conversation_id: string;
  matched: number;
}

type Target = string; // identity id, or ME
const ME = 'me';

interface Evidence {
  votes: Map<string, number>;
  /** per conversation: DYI sender (normalized) → Beeper target → matched messages */
  names: Map<string, Map<string, Map<Target, number>>>;
}

export class DyiImporter {
  readonly stats: DyiImportStats = {
    folder_missing: 0,
    files_seen: 0,
    files_known: 0,
    files_imported: 0,
    files_failed: 0,
    files_ignored: 0,
    html_exports: 0,
    threads: 0,
    threads_matched: 0,
    threads_new_conversations: 0,
    dyi_messages: 0,
    duplicates_skipped: 0,
    invalid_items: 0,
    follows: 0,
    self_names: 0,
    promoted: 0,
  };
  private readonly now: number;
  private readonly run: SourceRun;
  private readonly w: EpisodeWriter;
  private readonly self: { names: Set<string>; usernames: Set<string> };
  private mePersonId: string | null = null;
  private readonly statements = new Map<string, Statement>();

  constructor(
    private readonly db: DB,
    private readonly o: DyiImportOptions,
  ) {
    this.now = o.now ?? Date.now();
    this.run = sourceRun(db, DYI_SOURCE, { now: this.now, jobRunId: o.jobRunId ?? null, kind: 'import' });
    this.w = episodeWriter(db, { now: this.now });
    const s = cursorMeta<SelfState>(readCursor(db, DYI_SOURCE, SELF_SCOPE));
    this.self = { names: new Set(s.names ?? []), usernames: new Set(s.usernames ?? []) };
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

  private me(): string {
    this.mePersonId ??= ensureMe(this.ctx, []).personId;
    return this.mePersonId;
  }

  private isSelfName(norm: string): boolean {
    return norm !== '' && this.self.names.has(norm);
  }

  private saveSelf(): void {
    writeCursor(this.db, DYI_SOURCE, SELF_SCOPE, '', this.now, { meta: { names: [...this.self.names], usernames: [...this.self.usernames] } });
    this.stats.self_names = this.self.names.size;
  }

  async importAll(): Promise<DyiImportStats> {
    const scan = await scanImports(this.o.importsDir);
    if (scan.folderMissing) {
      this.stats.folder_missing = 1;
      return this.stats;
    }
    this.stats.files_seen = scan.units.length;
    const todo: { u: DyiUnit; sha: string }[] = [];
    for (const u of scan.units) {
      if (knownByStat(this.db, u)) {
        this.stats.files_known++;
        continue;
      }
      const sha = await sha256File(u.path);
      const known = importFileBySha(this.db, sha);
      if (known && (known.status !== 'failed' || known.attempts >= MAX_ATTEMPTS)) {
        touchImportFile(this.db, sha, u, this.now);
        this.stats.files_known++;
        continue;
      }
      todo.push({ u, sha });
    }
    if (!todo.length) return this.stats;

    let status: 'ok' | 'partial' | 'error' = 'error';
    const opened: { u: DyiUnit; sha: string; unit: OpenedUnit; error: string | null }[] = [];
    const errors = new Set<string>();
    try {
      for (const t of todo) {
        try {
          opened.push({ ...t, unit: await openUnit(t.u, this.o.importsDir), error: null });
        } catch (e) {
          this.fail(t.u, t.sha, e, errors);
        }
      }
      const work = opened.flatMap((o) => o.unit.entries.map((entry) => ({ o, entry })));
      const rank = { personal: 0, followers: 1, following: 1, thread: 2 } as const;
      work.sort((a, b) => rank[a.entry.type] - rank[b.entry.type] || a.entry.rel.localeCompare(b.entry.rel));

      for (const { o, entry } of work.filter((x) => x.entry.type === 'personal')) await this.guard(o, () => this.importPersonal(entry));
      if (!this.self.names.size) await this.guessSelf(work.filter((x) => x.entry.type === 'thread').map((x) => x.entry));
      for (const { o, entry } of work) {
        if (this.o.signal?.aborted) break;
        if (entry.type === 'followers' || entry.type === 'following') await this.guard(o, () => this.importFollows(entry));
        else if (entry.type === 'thread') await this.guard(o, () => this.importThread(entry));
      }
      tx(this.db, () => this.w.refresh());

      for (const o of opened) {
        o.unit.close();
        if (o.error) {
          this.fail(o.u, o.sha, o.error, errors);
        } else if (!o.unit.entries.length) {
          this.stats.files_ignored++;
          if (o.unit.htmlEntries) this.stats.html_exports++;
          recordImportFile(this.db, o.sha, o.u, this.now, 'ignored', { error: o.unit.htmlEntries ? 'html_export' : 'not_an_instagram_export' });
        } else if (!this.o.signal?.aborted) {
          this.stats.files_imported++;
          recordImportFile(this.db, o.sha, o.u, this.now, 'imported', { stats: { entries: o.unit.entries.length } });
        }
      }
      Object.assign(this.stats, nonZeroStats(this.w.stats));
      this.stats.dyi_messages = this.w.stats.messages_new;
      status = this.stats.files_failed ? 'partial' : 'ok';
      this.recordHealth(errors);
      return this.stats;
    } finally {
      for (const o of opened) o.unit.close();
      this.run.finish(status, { messages_new: this.w.stats.messages_new, follows: this.stats.follows });
    }
  }

  /** Runs one entry; a failure marks its file failed (error class only) and the rest of the import goes on. */
  private async guard(o: { error: string | null }, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      o.error ??= errorClass(e);
    }
  }

  private fail(u: DyiUnit, sha: string, e: unknown, errors: Set<string>): void {
    const cls = typeof e === 'string' ? e : errorClass(e);
    errors.add(cls);
    this.stats.files_failed++;
    recordImportFile(this.db, sha, u, this.now, 'failed', { error: cls });
  }

  private recordHealth(errors: Set<string>): void {
    const details = {
      files_imported: this.stats.files_imported,
      files_failed: this.stats.files_failed,
      threads: this.stats.threads,
      threads_matched: this.stats.threads_matched,
      messages_new: this.stats.dyi_messages,
      follows: this.stats.follows,
    };
    if (this.stats.files_failed) {
      recordSourceHealth(this.db, DYI_SOURCE, this.now, 'error', {
        error: `${this.stats.files_failed} export file(s) could not be imported (${[...errors].slice(0, 3).join(', ')})`,
        details,
      });
    } else if (this.stats.html_exports && !this.stats.files_imported) {
      recordSourceHealth(this.db, DYI_SOURCE, this.now, 'error', {
        error: 'That Instagram export is in HTML format: request a new one with Format = JSON.',
        details,
      });
    } else {
      recordSourceHealth(this.db, DYI_SOURCE, this.now, 'ok', { details });
    }
  }

  // -------------------------------------------------------------------------------------- self

  private async importPersonal(entry: DyiEntry): Promise<void> {
    const info = personalInfo(parseDyiJson(await entry.read()));
    tx(this.db, () => {
      if (info.name && normalizeNamePart(info.name)) this.self.names.add(normalizeNamePart(info.name));
      const k = info.username ? normalizeExternalKey('instagram_username', info.username) : null;
      if (k) {
        this.self.usernames.add(k.key);
        attachExternalIdentity(this.ctx, { kind: 'instagram_username', key: k.key, source: DYI_SOURCE, personId: this.me() });
      }
      this.saveSelf();
    });
  }

  /** No personal_information: my name is the one in (nearly) every thread. */
  private async guessSelf(threads: DyiEntry[]): Promise<void> {
    if (threads.length < 2) return;
    const counts = new Map<string, number>();
    let n = 0;
    for (const t of threads) {
      let p: ReturnType<typeof DyiThread.safeParse>;
      try {
        p = DyiThread.safeParse(parseDyiJson(await t.read()));
      } catch {
        continue; // unreadable: its own import reports it
      }
      if (!p.success) continue;
      n++;
      for (const name of new Set((p.data.participants ?? []).map((x) => normalizeNamePart(x.name)).filter(Boolean))) {
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
    const top = [...counts].filter(([, c]) => c >= Math.max(2, Math.ceil(n * 0.8)));
    if (top.length !== 1) return;
    this.self.names.add(top[0]![0]);
    tx(this.db, () => this.saveSelf());
  }

  // -------------------------------------------------------------------------------------- follows

  private async importFollows(entry: DyiEntry): Promise<void> {
    const direction = entry.type === 'followers' ? 'follower' : 'following';
    const rows = relationshipEntries(parseDyiJson(await entry.read()));
    // followed_at keeps the EARLIEST follow time ever exported (intel/metAt reads it as when the owner connected): a
    // later export after an unfollow + re-follow, or the same username twice in one file, never moves it later.
    const upsert = this.q(
      `INSERT INTO instagram_follows (identity_id, direction, followed_at, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (identity_id, direction) DO UPDATE SET
         followed_at = min(coalesce(excluded.followed_at, instagram_follows.followed_at), coalesce(instagram_follows.followed_at, excluded.followed_at)),
         last_seen_at = max(instagram_follows.last_seen_at, excluded.last_seen_at)
       WHERE (excluded.followed_at IS NOT NULL AND (instagram_follows.followed_at IS NULL OR excluded.followed_at < instagram_follows.followed_at))
          OR excluded.last_seen_at > instagram_follows.last_seen_at`,
    );
    tx(this.db, () => {
      for (const r of rows) {
        if (this.self.usernames.has(r.username)) continue;
        const id = attachExternalIdentity(this.ctx, { kind: 'instagram_username', key: r.username, source: DYI_SOURCE, at: r.at });
        if (!id) continue;
        this.stats.follows += upsert.run(id, direction, r.at, this.now, this.now).changes;
      }
    });
  }

  // -------------------------------------------------------------------------------------- threads

  private async importThread(entry: DyiEntry): Promise<void> {
    const parsed = DyiThread.safeParse(parseDyiJson(await entry.read()));
    if (!parsed.success) throw new DyiFormatError('thread');
    const thread = parsed.data;
    const msgs: DyiMessage[] = [];
    for (const raw of thread.messages ?? []) {
      const m = DyiMessage.safeParse(raw);
      if (m.success) msgs.push(m.data);
      else this.stats.invalid_items++;
    }
    const threadKey = threadKeyOf(entry.folder!, thread.thread_path);
    // Exports list messages newest first; keep that order for matching (it overlaps Beeper most), sort for writing.
    const newestFirst = [...msgs].sort((a, b) => b.timestamp_ms - a.timestamp_ms);
    tx(this.db, () => this.writeThread(threadKey, thread, newestFirst));
    this.stats.threads++;
  }

  private writeThread(threadKey: string, thread: z.output<typeof DyiThread>, newestFirst: DyiMessage[]): void {
    const names = (thread.participants ?? []).map((p) => p.name.trim()).filter(Boolean);
    const others = [...new Set(names.filter((n) => !this.isSelfName(normalizeNamePart(n))))];
    let row = this.q('SELECT conversation_id, matched FROM ig_dyi_threads WHERE thread_key = ?').get(threadKey) as ThreadRow | undefined;
    const evidence = !row || row.matched ? this.matchBeeper(newestFirst) : null;
    if (!row) row = this.decide(threadKey, thread, others, newestFirst, evidence!);
    const conv = this.q('SELECT id, source, source_conv_id, kind FROM conversations WHERE id = ?').get(row.conversation_id) as {
      id: string;
      source: string;
      source_conv_id: string;
      kind: ConversationKind;
    };
    const matched = row.matched === 1;
    if (matched) this.stats.threads_matched++;

    // Senders that matched my own Beeper messages are me (learned once, kept).
    const nameMap = evidence?.names.get(conv.id);
    let learned = false;
    for (const [name, targets] of nameMap ?? []) {
      if ((targets.get(ME) ?? 0) >= 2 && !this.self.names.has(name)) {
        this.self.names.add(name);
        learned = true;
      }
    }
    if (learned) this.saveSelf();

    const firstAt = newestFirst.length ? newestFirst[newestFirst.length - 1]!.timestamp_ms : null;
    const lastAt = newestFirst.length ? newestFirst[0]!.timestamp_ms : null;
    const resolved = new Map<string, string | null>();
    const seen = new Set<string>();
    const resolve = (raw: string | null | undefined): Target | null => {
      const name = raw?.trim();
      const norm = normalizeNamePart(name);
      if (!name || !norm) return null;
      if (this.isSelfName(norm)) return ME;
      if (resolved.has(norm)) return resolved.get(norm)!;
      let id: string | null = null;
      if (matched) {
        const best = bestTarget(nameMap?.get(norm));
        if (best === ME) {
          resolved.set(norm, ME);
          return ME;
        }
        id = best ?? this.memberByAlias(conv.id, norm);
      }
      if (id) recordAlias(this.db, id, name, 'ig_dyi', lastAt ?? this.now);
      else {
        id = attachExternalIdentity(this.ctx, {
          kind: 'instagram_name',
          key: `ig_dyi:${threadKey}:${name}`,
          displayName: name,
          nameSource: 'ig_dyi',
          source: DYI_SOURCE,
          at: firstAt,
        });
      }
      if (id) seen.add(id);
      resolved.set(norm, id);
      return id;
    };

    if (!matched) {
      for (const n of others) {
        const id = resolve(n);
        if (id && id !== ME) this.w.upsertMember(conv.id, id, { source: 'roster', at: lastAt ?? this.now });
      }
    }

    const occurrences = new Map<string, number>();
    const oldestFirst = [...newestFirst].reverse();
    for (const m of oldestFirst) {
      const mapped = mapDyiMessage(m);
      const tuple = `${m.timestamp_ms}|${normalizeNamePart(m.sender_name)}|${mapped.text ?? ''}|${mapped.kind}`;
      const occurrence = occurrences.get(tuple) ?? 0;
      occurrences.set(tuple, occurrence + 1);
      const target = resolve(m.sender_name);
      const fromMe = target === ME;
      if (matched && this.beeperHas(conv.id, m.timestamp_ms, mapped, fromMe)) {
        this.stats.duplicates_skipped++;
        continue;
      }
      const key = dyiMessageKey(threadKey, m, mapped, occurrence);
      this.w.upsertMessage({
        source: DYI_SOURCE,
        sourceMsgId: key,
        conversationId: conv.id,
        senderIdentityId: fromMe ? null : target,
        isFromMe: fromMe,
        sentAt: m.timestamp_ms,
        kind: mapped.kind,
        text: mapped.text,
        textSource: mapped.text === null ? 'none' : 'text',
        attachments: mapped.attachments,
        retractedAt: mapped.retracted ? m.timestamp_ms : null,
        service: 'instagram',
      });
      for (const r of m.reactions ?? []) {
        const actor = resolve(r.actor);
        this.w.upsertReaction({
          source: DYI_SOURCE,
          sourceReactionId: `${key}|${normalizeNamePart(r.actor)}|${r.reaction}`,
          targetSourceMsgId: key,
          actorIdentityId: actor === ME ? null : actor,
          isFromMe: actor === ME,
          type: 'emoji',
          emoji: r.reaction,
          at: r.timestamp ? Math.round(r.timestamp * 1000) : m.timestamp_ms,
        });
      }
    }
    if (firstAt !== null) {
      this.w.upsertConversation({ source: conv.source, sourceConvId: conv.source_conv_id, kind: conv.kind, firstAt, lastAt });
    }
    this.w.resolvePendingReactions(DYI_SOURCE);
    this.q('UPDATE ig_dyi_threads SET updated_at = ? WHERE thread_key = ?').run(this.now, threadKey);
    this.stats.promoted += promoteQualified(this.ctx, seen);
  }

  /** Text messages of the thread vs Beeper's Instagram messages: votes per conversation and sender evidence. */
  private matchBeeper(newestFirst: DyiMessage[]): Evidence {
    const ev: Evidence = { votes: new Map(), names: new Map() };
    const near = this.q(
      `SELECT conversation_id, sender_identity_id, is_from_me, text FROM messages
       WHERE source = ? AND sent_at BETWEEN ? AND ? AND text IS NOT NULL AND dup_of IS NULL`,
    );
    let sampled = 0;
    for (const m of newestFirst) {
      if (sampled >= MATCH_SAMPLE) break;
      const mapped = mapDyiMessage(m);
      if (mapped.kind !== 'text' && mapped.kind !== 'link') continue;
      const h = textHash(mapped.text);
      if (!h) continue;
      sampled++;
      const rows = near.all(BEEPER_SOURCE, m.timestamp_ms - MATCH_WINDOW_MS, m.timestamp_ms + MATCH_WINDOW_MS) as {
        conversation_id: string;
        sender_identity_id: string | null;
        is_from_me: number;
        text: string;
      }[];
      const hits = rows.filter((r) => textHash(r.text) === h);
      for (const conv of new Set(hits.map((r) => r.conversation_id))) ev.votes.set(conv, (ev.votes.get(conv) ?? 0) + 1);
      const sender = normalizeNamePart(m.sender_name);
      if (!sender) continue;
      for (const r of hits) {
        const target = r.is_from_me ? ME : r.sender_identity_id;
        if (!target) continue;
        let byName = ev.names.get(r.conversation_id);
        if (!byName) ev.names.set(r.conversation_id, (byName = new Map()));
        let t = byName.get(sender);
        if (!t) byName.set(sender, (t = new Map()));
        t.set(target, (t.get(target) ?? 0) + 1);
      }
    }
    return ev;
  }

  /** First import of a thread: map it onto a Beeper conversation (clear winner with ≥3 matches) or its own. */
  private decide(threadKey: string, thread: z.output<typeof DyiThread>, others: string[], newestFirst: DyiMessage[], ev: Evidence): ThreadRow {
    const ranked = [...ev.votes].sort((a, b) => b[1] - a[1]);
    const [best, second] = ranked;
    let conversationId: string;
    let matched = 0;
    let votes = 0;
    if (best && best[1] >= MIN_THREAD_MATCHES && (!second || second[1] * 2 < best[1])) {
      conversationId = best[0];
      matched = 1;
      votes = best[1];
    } else {
      const kind: ConversationKind = others.length > 1 ? 'group' : 'direct';
      const c = this.w.upsertConversation({
        source: DYI_SOURCE,
        sourceConvId: threadKey,
        kind,
        title: kind === 'group' ? thread.title : null,
        titleSource: 'dyi',
        memberCount: others.length + 1,
        firstAt: newestFirst.at(-1)?.timestamp_ms ?? null,
        lastAt: newestFirst[0]?.timestamp_ms ?? null,
      });
      conversationId = c.id;
      if (c.created) this.stats.threads_new_conversations++;
    }
    this.q('INSERT INTO ig_dyi_threads (thread_key, conversation_id, matched, votes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(threadKey, conversationId, matched, votes, this.now, this.now);
    return { conversation_id: conversationId, matched };
  }

  /** A conversation member whose observed name is exactly this one (and only one is). */
  private memberByAlias(conversationId: string, norm: string): string | null {
    const ids = this.q(
        `SELECT DISTINCT cm.identity_id FROM conversation_members cm JOIN alias_obs a ON a.identity_id = cm.identity_id
         WHERE cm.conversation_id = ? AND a.name_norm = ? LIMIT 2`,
      )
      .pluck()
      .all(conversationId, norm) as string[];
    return ids.length === 1 ? ids[0]! : null;
  }

  /** Beeper already holds this message: same direction within ±2 s, and the same text (or both media). */
  private beeperHas(conversationId: string, t: number, mapped: MappedDyiMessage, fromMe: boolean): boolean {
    const rows = this.q(
        `SELECT text, kind FROM messages WHERE conversation_id = ? AND source = ? AND is_from_me = ? AND sent_at BETWEEN ? AND ?`,
      )
      .all(conversationId, BEEPER_SOURCE, fromMe ? 1 : 0, t - MATCH_WINDOW_MS, t + MATCH_WINDOW_MS) as { text: string | null; kind: string }[];
    if (!rows.length) return false;
    const h = textHash(mapped.text);
    return rows.some((r) => (h !== null && textHash(r.text) === h) || (MEDIA_KINDS.has(mapped.kind) && MEDIA_KINDS.has(r.kind)));
  }
}

/** The Beeper target with the most matched messages for a name (ties: none). */
function bestTarget(targets: Map<Target, number> | undefined): Target | null {
  if (!targets?.size) return null;
  const ranked = [...targets].sort((a, b) => b[1] - a[1]);
  return ranked.length > 1 && ranked[1]![1] === ranked[0]![1] ? null : ranked[0]![0];
}

function errorClass(e: unknown): string {
  if (e instanceof DyiFormatError) return `format_${e.what}`;
  if (e instanceof SyntaxError) return 'invalid_json';
  const code = (e as NodeJS.ErrnoException)?.code;
  if (typeof code === 'string' && /^[A-Z_]{2,40}$/.test(code)) return code.toLowerCase();
  return (e as Error)?.name && /^\w{1,40}$/.test((e as Error).name) ? (e as Error).name : 'error';
}

/** One importer pass over IMPORTS_DIR (cheap when nothing is new: a directory walk and a few stats). */
export function importInstagramDyi(db: DB, o: DyiImportOptions): Promise<DyiImportStats> {
  return new DyiImporter(db, o).importAll();
}
