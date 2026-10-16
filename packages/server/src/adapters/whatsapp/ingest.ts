/**
 * WhatsApp ingest from one collector snapshot (PLAN "Ingestion → WhatsApp"):
 *   1. schema guard: a missing column stops the pass before any write;
 *   2. watermark: messages above the 'zpk' cursor. A store whose MAX(Z_PK) went down, or whose anchor row (the last
 *      one ingested) now holds another message, was re-linked: full re-upsert from 0 (messages are idempotent on
 *      '{chat_jid}:{ZSTANZAID}'). Rows of the last 48 h are re-read too, for in-place deletes and edits;
 *   3. people, before any message is written: every JID in a chat, a group roster or a new message becomes an
 *      identity (a phone JID → the E.164 phone identity it shares with iMessage; an @lid → whatsapp_lid, attached to
 *      the phone's person when LID.ZWAZACCOUNT, ContactsV2.ZLID or LID.ZWAPHONENUMBERLIDPAIR maps it; unmapped LIDs
 *      stay their own provisional person). Names (ContactsV2.ZFULLNAME, ZWACHATSESSION.ZPARTNERNAME,
 *      ZWAPROFILEPUSHNAME.ZPUSHNAME) are alias observations; §1.4 status comes from this snapshot's counts;
 *   4. messages page by page, one transaction per page with its cursor;
 *   5. rosters from ZWAGROUPMEMBER, deduped after LID mapping (ZISACTIVE=0 → former member), the roster-only re-check
 *      and the session/interaction refresh.
 * Not decoded: reactions (a protobuf blob, ZWAMESSAGEINFO.ZRECEIPTINFO) and quoted replies (ZWAMEDIAITEM.ZMETADATA).
 * Stats are counts; nothing here logs names, numbers or text.
 */
import crypto from 'node:crypto';
import { canonicalId } from '../../db/canon';
import type { DB } from '../../db/connection';
import { tx } from '../../db/tx';
import {
  attachExternalIdentity,
  normalizeExternalKey,
  personOfIdentity,
  recordAlias,
  type ExternalKind,
  type ExternalSignals,
} from '../../identity/external';
import { findIdentity, reevaluateRosterOnly, touchIdentitySeen } from '../../identity/resolver';
import { sourceRun, type SourceRun } from '../common/context';
import { cursorMeta, readCursor, writeCursor } from '../common/cursors';
import { episodeWriter, nonZeroStats, type ConversationKind, type EpisodeWriter } from '../common/episodes';
import {
  chatKind,
  cleanWaName,
  coreDataToMs,
  internationalDigits,
  lidDigits,
  lidJid,
  messageKind,
  messageText,
  msToCoreData,
  NAME_KINDS,
  nameAt,
  parseUserJid,
  phoneJid,
  SOURCE,
  sourceMsgId,
  type NameKind,
} from './mapping';
import { SnapshotReader, type MessageRow, type SnapshotFiles } from './reader';

export { SOURCE };

/** source_cursors scope of the Z_PK watermark. */
export const ZPK_SCOPE = 'zpk';
const HOUR = 3_600_000;
/** Already-ingested rows this recent are re-read each pass (deletes and edits rewrite the row in place). */
export const OVERLAP_MS = 48 * HOUR;
const DEFAULT_PAGE = 2000;

export type ZpkMeta = {
  /** Z_PK and hashed '{chat_jid}:{stanza}' of the last row ingested: a re-linked store has another row there. */
  anchor_pk: number | null;
  anchor: string | null;
  /** MAX(Z_PK) of the snapshot the cursor was last written from. */
  max_pk: number;
  source_mtime: number | null;
  /** The pass reached max_pk (an unchanged snapshot then needs no re-read). */
  complete: boolean;
  relinks: number;
};

export interface WhatsappIngestOptions {
  now?: number;
  jobRunId?: number | null;
  pageSize?: number;
  signal?: AbortSignal;
  /** The snapshot's source mtime, recorded so an unchanged snapshot isn't read twice. */
  sourceMtime?: number | null;
}

export type IngestOutcome =
  | { status: 'ok' | 'partial'; stats: Record<string, number>; details: Record<string, number> }
  /** ChatStorage exists but holds no WhatsApp tables yet: the app was never linked. */
  | { status: 'not_linked' }
  | { status: 'contract_broken'; missing: string[] };

/** True when this snapshot was already ingested to the end (the collector said `unchanged`). */
export function snapshotIngested(db: DB, sourceMtime: number | null): boolean {
  const meta = cursorMeta<ZpkMeta>(readCursor(db, SOURCE, ZPK_SCOPE));
  return sourceMtime !== null && meta.complete === true && meta.source_mtime === sourceMtime;
}

const anchorHash = (key: string): string => crypto.createHash('sha256').update(key).digest('base64url').slice(0, 16);
const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Opens the snapshot, guards its schema and ingests it. The copies are only ever read. */
export async function ingestSnapshot(db: DB, files: SnapshotFiles, o: WhatsappIngestOptions = {}): Promise<IngestOutcome> {
  const reader = SnapshotReader.open(files);
  try {
    const check = reader.check();
    if (check.empty) return { status: 'not_linked' };
    if (!check.ok) return { status: 'contract_broken', missing: check.missing };
    return await new WhatsappIngestor(db, reader, o).run();
  } finally {
    reader.close();
  }
}

interface Session {
  pk: number;
  jid: string;
  kind: 'direct' | 'group';
  name: string | null;
}

interface Conv {
  id: string;
  kind: ConversationKind;
}

/** Everything known about one person key before identities are written. */
interface Plan {
  phone: string | null;
  lids: Set<string>;
  /** Canonical JIDs ('<digits>@s.whatsapp.net' / '<digits>@lid') seen for this key. */
  jids: Set<string>;
  fromMe: number;
  theirs: number;
  /** Groups with an active roster row for this key. */
  groups: Set<number>;
  /** Groups this key posted in (new rows). */
  postedIn: Set<number>;
  first: number | null;
  last: number | null;
}

interface Party {
  /** The identity messages and rosters use: the phone identity when there is one. */
  primary: string;
  /** primary plus the person's LID identities. */
  ids: string[];
}

interface Named {
  name: string;
  kind: NameKind;
}

class WhatsappIngestor {
  private readonly now: number;
  private readonly sourceRun: SourceRun;
  private readonly w: EpisodeWriter;
  private readonly stats: Record<string, number> = {};
  private readonly sessions = new Map<number, Session>();
  private readonly convs = new Map<number, Conv>();
  /** LID digits → international phone digits (validated E.164). */
  private readonly lidToPhone = new Map<string, string>();
  /** Canonical JID → names by kind. */
  private readonly names = new Map<string, Partial<Record<NameKind, string>>>();
  private readonly plans = new Map<string, Plan>();
  /** Group session → person keys in its roster or posting in it. */
  private readonly groupKeys = new Map<number, Set<string>>();
  private readonly parties = new Map<string, Party>();

  constructor(
    private readonly db: DB,
    private readonly reader: SnapshotReader,
    private readonly o: WhatsappIngestOptions,
  ) {
    this.now = o.now ?? Date.now();
    this.sourceRun = sourceRun(db, SOURCE, { now: this.now, jobRunId: o.jobRunId ?? null });
    this.w = episodeWriter(db, { now: this.now });
  }

  private bump(key: string, n = 1): void {
    this.stats[key] = (this.stats[key] ?? 0) + n;
  }

  async run(): Promise<IngestOutcome> {
    try {
      const out = await this.pass();
      this.sourceRun.finish(out.status, out.stats);
      return out;
    } catch (e) {
      this.sourceRun.finish('error');
      throw e;
    }
  }

  private async pass(): Promise<Extract<IngestOutcome, { status: 'ok' | 'partial' }>> {
    this.load();
    const cur = readCursor(this.db, SOURCE, ZPK_SCOPE);
    const meta = cursorMeta<ZpkMeta>(cur);
    const max = this.reader.maxPk();
    let after = Number(cur?.cursor ?? 0);
    const relinked = this.relinked(after, max, meta);
    if (relinked) {
      after = 0;
      this.bump('relinked');
    }
    // Rows up to max may already be stored (a re-link, or a cursor reset by hand): their senders' counts are too.
    const rereading = relinked || (after === 0 && this.db.prepare('SELECT 1 FROM messages WHERE source = ? LIMIT 1').get(SOURCE) !== undefined);

    this.plan(after, max);
    tx(this.db, () => {
      this.resolveParties(rereading);
      this.upsertConversations();
    });

    let anchor = relinked ? { pk: null as number | null, hash: null as string | null } : { pk: meta.anchor_pk ?? null, hash: meta.anchor ?? null };
    const nextMeta = (complete: boolean): ZpkMeta => ({
      anchor_pk: anchor.pk,
      anchor: anchor.hash,
      max_pk: max,
      source_mtime: this.o.sourceMtime ?? null,
      complete,
      relinks: (meta.relinks ?? 0) + (relinked ? 1 : 0),
    });

    // New rows, page by page; each page commits with its cursor.
    const limit = this.o.pageSize ?? DEFAULT_PAGE;
    let pos = after;
    let aborted = false;
    for (;;) {
      if (this.o.signal?.aborted) {
        aborted = true;
        break;
      }
      const rows = this.reader.messages(pos, max, limit);
      if (!rows.length) break;
      const last = rows[rows.length - 1]!;
      const key = this.reader.rowKeyAt(last.pk);
      anchor = { pk: last.pk, hash: key === null ? null : anchorHash(key) };
      tx(this.db, () => {
        const highWater = this.writePage(rows);
        writeCursor(this.db, SOURCE, ZPK_SCOPE, String(last.pk), this.now, { highWaterAt: highWater, meta: nextMeta(false) });
      });
      this.bump('pages');
      pos = last.pk;
      if (rows.length < limit) break;
      await yieldToLoop();
    }

    // Recent rows already ingested: deletes ("This message was deleted") and edits rewrite them in place.
    if (after > 0 && !aborted) {
      const since = msToCoreData(this.now - OVERLAP_MS);
      let from = 0;
      for (;;) {
        const rows = this.reader.messages(from, after, limit, since);
        if (!rows.length) break;
        tx(this.db, () => this.writePage(rows));
        this.bump('overlap_rows', rows.length);
        from = rows[rows.length - 1]!.pk;
        if (rows.length < limit) break;
        await yieldToLoop();
      }
    }

    tx(this.db, () => {
      this.writeRosters();
      const r = reevaluateRosterOnly(this.sourceRun.ctx, { identityIds: [...this.parties.values()].flatMap((p) => p.ids) });
      this.bump('promoted', r.promoted);
      this.bump('reclassified_service', r.service);
      if (!aborted) writeCursor(this.db, SOURCE, ZPK_SCOPE, String(max), this.now, { meta: nextMeta(true) });
    });
    this.w.refresh({ sources: [SOURCE] });

    const groups = [...this.sessions.values()].filter((s) => s.kind === 'group').length;
    const lids = [...this.plans.values()].flatMap((p) => [...p.lids].map((l) => this.lidToPhone.has(l)));
    const details = {
      chats: this.sessions.size - groups,
      groups,
      lid_mapped: lids.filter(Boolean).length,
      lid_unmapped: lids.filter((m) => !m).length,
    };
    return { status: aborted ? 'partial' : 'ok', stats: nonZeroStats({ ...this.w.stats, ...this.stats }), details };
  }

  /**
   * A re-linked device starts a new store: MAX(Z_PK) below what we saw, or another row at the anchor. Deleting the
   * newest chat looks the same; the re-read that follows is idempotent, only slower.
   */
  private relinked(after: number, max: number, meta: Partial<ZpkMeta>): boolean {
    if (after === 0 && !meta.max_pk) return false;
    if (max < after || max < (meta.max_pk ?? 0)) return true;
    if (meta.anchor_pk == null || !meta.anchor) return false;
    const key = this.reader.rowKeyAt(meta.anchor_pk);
    return key === null || anchorHash(key) !== meta.anchor;
  }

  // ---------- snapshot → memory ----------

  private load(): void {
    for (const s of this.reader.sessions()) {
      const kind = chatKind(s.type, s.jid);
      if (!kind) {
        this.bump('chats_skipped');
        continue;
      }
      this.sessions.set(s.pk, { pk: s.pk, jid: s.jid.toLowerCase(), kind, name: s.name });
    }
    // LID → phone, highest precedence first (the LID store, then Contacts, then the LID store's pair table); a
    // phone must be a valid E.164 number to be a merge key.
    const contacts = this.reader.contacts();
    const mappings = [
      ...this.reader.lidAccounts().map((r) => ({ lid: lidDigits(r.lid), phone: internationalDigits(r.phone) })),
      ...contacts.map((r) => ({ lid: lidDigits(r.lid), phone: internationalDigits(r.jid) })),
      ...this.reader.lidPairs().map((r) => ({ lid: lidDigits(r.lid), phone: internationalDigits(r.phone) })),
    ];
    for (const { lid, phone } of mappings) {
      if (!lid || !phone) continue;
      if (normalizeExternalKey('whatsapp_jid', phoneJid(phone))?.kind !== 'phone') continue;
      const known = this.lidToPhone.get(lid);
      if (known === undefined) this.lidToPhone.set(lid, phone);
      else if (known !== phone) this.bump('lid_conflicts');
    }
    const addName = (rawJid: string | null, kind: NameKind, raw: string | null) => {
      const jid = canonicalJid(rawJid);
      const name = cleanWaName(raw);
      if (!jid || !name) return;
      const entry = this.names.get(jid) ?? {};
      entry[kind] ??= name;
      this.names.set(jid, entry);
    };
    for (const c of contacts) {
      addName(c.jid, 'contact', c.name);
      const lid = lidDigits(c.lid);
      if (lid) addName(lidJid(lid), 'contact', c.name);
    }
    for (const s of this.sessions.values()) if (s.kind === 'direct') addName(s.jid, 'partner', s.name);
    for (const p of this.reader.pushNames()) addName(p.jid, 'push', p.name);
  }

  /** The person key of a JID: its phone (directly or through the LID map), else the LID itself. */
  private keyOf(raw: string | null | undefined): { key: string; phone: string | null; lid: string | null; jid: string } | null {
    const j = parseUserJid(raw);
    if (!j) return null;
    if (j.kind === 'phone') return { key: `p:${j.digits}`, phone: j.digits, lid: null, jid: phoneJid(j.digits) };
    const phone = this.lidToPhone.get(j.digits) ?? null;
    return { key: phone ? `p:${phone}` : `l:${j.digits}`, phone, lid: j.digits, jid: lidJid(j.digits) };
  }

  private planFor(raw: string | null | undefined, group?: number): Plan | null {
    const k = this.keyOf(raw);
    if (!k) return null;
    if (group !== undefined) {
      const keys = this.groupKeys.get(group) ?? new Set<string>();
      this.groupKeys.set(group, keys.add(k.key));
    }
    let p = this.plans.get(k.key);
    if (!p) {
      p = { phone: k.phone, lids: new Set(), jids: new Set(), fromMe: 0, theirs: 0, groups: new Set(), postedIn: new Set(), first: null, last: null };
      this.plans.set(k.key, p);
    }
    p.jids.add(k.jid);
    if (k.phone) p.jids.add(phoneJid(k.phone));
    if (k.lid) p.lids.add(k.lid);
    return p;
  }

  /** Who appears in this snapshot, with §1.4 counts from the new rows (system rows don't count). */
  private plan(after: number, max: number): void {
    for (const s of this.sessions.values()) if (s.kind === 'direct') this.planFor(s.jid);
    for (const r of this.reader.roster()) {
      if (this.sessions.get(r.sessionPk)?.kind !== 'group') continue;
      const p = this.planFor(r.jid, r.sessionPk);
      if (!p) {
        this.bump('roster_unresolvable');
        continue;
      }
      if (r.active === 1) p.groups.add(r.sessionPk);
    }
    for (const a of this.reader.activity(after, max)) {
      const s = this.sessions.get(a.sessionPk);
      if (!s) continue;
      const fromMe = a.fromMe === 1;
      const p = s.kind === 'direct' ? this.planFor(s.jid) : fromMe ? null : this.planFor(a.memberJid, s.pk);
      if (!p || messageKind(a.type, a.groupEvent, a.hasText === 1).kind === 'system') continue;
      if (fromMe) p.fromMe += a.n;
      else p.theirs += a.n;
      if (s.kind === 'group' && !fromMe) p.postedIn.add(s.pk);
      const first = coreDataToMs(a.first);
      const last = coreDataToMs(a.last);
      if (first !== null) p.first = Math.min(p.first ?? first, first);
      if (last !== null) p.last = Math.max(p.last ?? last, last);
    }
  }

  // ---------- people ----------

  private namesOf(jids: Iterable<string>): Named[] {
    const ordered = [...jids].sort((a, b) => Number(b.endsWith('@s.whatsapp.net')) - Number(a.endsWith('@s.whatsapp.net')) || a.localeCompare(b));
    const out: Named[] = [];
    const seen = new Set<string>();
    for (const kind of NAME_KINDS) {
      for (const jid of ordered) {
        const name = this.names.get(jid)?.[kind];
        if (!name || seen.has(name.toLowerCase())) continue;
        seen.add(name.toLowerCase());
        out.push({ name, kind });
      }
    }
    return out;
  }

  /** attachExternalIdentity with the best name, then the other names as lower-ranked observations. */
  private attach(kind: ExternalKind, key: string, names: Named[], o: { signals?: ExternalSignals; personId?: string } = {}): string | null {
    const ref = normalizeExternalKey(kind, key);
    if (!ref) return null;
    if (!findIdentity(this.db, ref)) this.bump('identities_new');
    const [best, ...rest] = names;
    const id = attachExternalIdentity(this.sourceRun.ctx, {
      kind,
      key,
      displayName: best?.name ?? null,
      at: best ? nameAt(this.now, best.kind) : this.now,
      signals: o.signals,
      personId: o.personId,
    });
    if (id) for (const n of rest) recordAlias(this.db, id, n.name, 'whatsapp', nameAt(this.now, n.kind));
    return id;
  }

  /**
   * Resolves every planned key. Someone whose only claim is posting in a group qualifies (§1.4) when that group
   * has a known person, which may be someone resolved in this pass: they wait for everyone else, then a fixpoint
   * settles them, so each new person is created once with the right status.
   */
  private resolveParties(rereading: boolean): void {
    const keys = [...this.plans.keys()].sort();
    const waits = (k: string) => {
      const p = this.plans.get(k)!;
      return p.postedIn.size > 0 && p.fromMe === 0 && p.theirs < 2 && p.groups.size < 2;
    };
    for (const k of keys.filter((k) => !waits(k))) this.resolveKey(k, rereading, false);
    let pending = keys.filter(waits);
    for (;;) {
      const ready = pending.filter((k) => [...this.plans.get(k)!.postedIn].some((g) => [...(this.groupKeys.get(g) ?? [])].some((o) => o !== k && this.isKnown(o))));
      if (!ready.length) break;
      for (const k of ready) this.resolveKey(k, rereading, true);
      pending = pending.filter((k) => !ready.includes(k));
    }
    for (const k of pending) this.resolveKey(k, rereading, false);
    this.bump('parties', this.parties.size);
  }

  private resolveKey(key: string, rereading: boolean, groupWithKnown: boolean): void {
    const plan = this.plans.get(key)!;
    const party = plan.phone ? this.resolvePhone(plan, rereading, groupWithKnown) : this.resolveLid(plan, rereading, groupWithKnown);
    if (!party) {
      this.bump('parties_unresolvable');
      return;
    }
    if (plan.first !== null) touchIdentitySeen(this.db, party.primary, plan.first, plan.last ?? plan.first);
    this.parties.set(key, party);
  }

  /** A resolved key whose person is a visible (active or provisional) person. */
  private isKnown(key: string): boolean {
    const p = this.parties.get(key);
    const owner = p && personOfIdentity(this.db, p.primary);
    if (!owner) return false;
    const row = this.db.prepare('SELECT kind, status FROM people WHERE id = ?').get(canonicalId(this.db, owner)) as { kind: string; status: string } | undefined;
    return row?.kind === 'person' && (row.status === 'active' || row.status === 'provisional');
  }

  /**
   * §1.4 counts for an identity: this snapshot's new rows (not written yet) add to what the database holds. When
   * re-reading rows that may be stored already, a known identity gets only its roster count (the roster-only
   * re-check after the messages are in settles it); a new one can't have stored messages.
   */
  private signals(plan: Plan, known: boolean, rereading: boolean, groupWithKnown: boolean): ExternalSignals {
    const base = { groups: plan.groups.size, groupWithKnown };
    return known && rereading ? base : { ...base, fromMe: plan.fromMe, theirs: plan.theirs };
  }

  private resolvePhone(plan: Plan, rereading: boolean, groupWithKnown: boolean): Party | null {
    const jid = phoneJid(plan.phone!);
    const ref = normalizeExternalKey('whatsapp_jid', jid);
    if (!ref) return null;
    const known = findIdentity(this.db, ref) !== undefined;
    // A LID seen before its mapping existed already has a person: a new phone identity joins it.
    const lids = [...plan.lids].sort();
    const lidOwner = known
      ? undefined
      : lids.map((l) => findIdentity(this.db, { kind: 'whatsapp_lid', key: lidJid(l) })).find((i) => i?.status === 'active')?.person_id;
    const primary = this.attach('whatsapp_jid', jid, this.namesOf(plan.jids), { signals: this.signals(plan, known, rereading, groupWithKnown), personId: lidOwner });
    if (!primary) return null;
    const owner = personOfIdentity(this.db, primary);
    const ids = [primary];
    for (const lid of lids) {
      const id = this.attach('whatsapp_lid', lidJid(lid), this.namesOf([lidJid(lid)]), { personId: owner ?? undefined });
      if (!id) continue;
      ids.push(id);
      const linked = owner !== null && canonicalId(this.db, personOfIdentity(this.db, id) ?? '') === canonicalId(this.db, owner);
      this.bump(linked ? 'lid_linked' : 'lid_link_held');
    }
    return { primary, ids };
  }

  private resolveLid(plan: Plan, rereading: boolean, groupWithKnown: boolean): Party | null {
    const lid = [...plan.lids][0];
    if (!lid) return null;
    const key = lidJid(lid);
    const known = findIdentity(this.db, { kind: 'whatsapp_lid', key }) !== undefined;
    const id = this.attach('whatsapp_lid', key, this.namesOf(plan.jids), { signals: this.signals(plan, known, rereading, groupWithKnown) });
    return id ? { primary: id, ids: [id] } : null;
  }

  private party(raw: string | null | undefined): Party | null {
    const k = this.keyOf(raw);
    return k ? (this.parties.get(k.key) ?? null) : null;
  }

  // ---------- episodes ----------

  private upsertConversations(): void {
    for (const s of this.sessions.values()) {
      let kind: ConversationKind = s.kind;
      if (s.kind === 'direct') {
        const p = this.party(s.jid);
        if (p && this.w.isMe(p.primary)) kind = 'self';
      }
      const { id } = this.w.upsertConversation({ source: SOURCE, sourceConvId: s.jid, kind, title: s.kind === 'group' ? s.name : null });
      this.convs.set(s.pk, { id, kind });
    }
  }

  /** Writes one page (caller holds the transaction); returns the newest message time. */
  private writePage(rows: readonly MessageRow[]): number | null {
    const span = new Map<number, { first: number; last: number }>();
    let newest: number | null = null;
    for (const r of rows) {
      const sentAt = this.writeMessage(r);
      if (sentAt === null) continue;
      const sp = span.get(r.sessionPk);
      span.set(r.sessionPk, sp ? { first: Math.min(sp.first, sentAt), last: Math.max(sp.last, sentAt) } : { first: sentAt, last: sentAt });
      newest = Math.max(newest ?? sentAt, sentAt);
    }
    for (const [pk, sp] of span) {
      const s = this.sessions.get(pk)!;
      const c = this.convs.get(pk)!;
      this.w.upsertConversation({ source: SOURCE, sourceConvId: s.jid, kind: c.kind, firstAt: sp.first, lastAt: sp.last });
    }
    return newest;
  }

  private writeMessage(r: MessageRow): number | null {
    const s = this.sessions.get(r.sessionPk);
    const c = this.convs.get(r.sessionPk);
    if (!s || !c) return null;
    const sentAt = coreDataToMs(r.date);
    if (sentAt === null) {
      this.bump('skipped_no_date');
      return null;
    }
    const mapped = messageKind(r.type, r.groupEvent, Boolean(r.text?.trim()));
    if (!mapped.known) this.bump(`type_unknown_${r.type ?? 'null'}`);
    const { kind, text } = messageText(mapped.kind, r.text);
    const fromMe = r.fromMe === 1;
    let sender: string | null = null;
    if (!fromMe) {
      sender = this.party(s.kind === 'direct' ? s.jid : r.memberJid)?.primary ?? null;
      if (!sender && kind !== 'system') this.bump('sender_unknown');
    }
    this.w.upsertMessage({
      source: SOURCE,
      sourceMsgId: sourceMsgId(s.jid, r.stanza, { sentAt, type: r.type, fromMe, memberJid: r.memberJid, text }),
      conversationId: c.id,
      senderIdentityId: sender,
      isFromMe: fromMe,
      sentAt,
      kind,
      text: mapped.retracted ? null : text,
      textSource: text && !mapped.retracted ? 'text' : 'none',
      attachments: mapped.attachment ? [{ kind: mapped.attachment }] : null,
      retractedAt: mapped.retracted ? sentAt : null,
      service: SOURCE,
      sourceRowRef: `zpk:${r.pk}`,
    });
    return sentAt;
  }

  /** Group rosters (complete, so absent members have left) and the counterpart of each 1:1 chat. */
  private writeRosters(): void {
    const groups = new Map<number, Map<string, { active: boolean; admin: boolean; ids: Set<string> }>>();
    for (const r of this.reader.roster()) {
      if (this.sessions.get(r.sessionPk)?.kind !== 'group') continue;
      const p = this.party(r.jid);
      if (!p) continue;
      let members = groups.get(r.sessionPk);
      if (!members) groups.set(r.sessionPk, (members = new Map()));
      const m = members.get(p.primary);
      if (m) this.bump('roster_duplicates');
      const entry = m ?? { active: false, admin: false, ids: new Set<string>() };
      entry.active ||= r.active === 1;
      entry.admin ||= r.admin === 1;
      for (const id of p.ids) entry.ids.add(id);
      members.set(p.primary, entry);
    }
    for (const s of this.sessions.values()) {
      const c = this.convs.get(s.pk)!;
      if (s.kind === 'direct') {
        const p = this.party(s.jid);
        if (p && c.kind === 'direct') this.w.upsertMember(c.id, p.primary, { source: 'roster', at: this.now });
        continue;
      }
      const members = groups.get(s.pk);
      if (!members?.size) continue;
      const keep: string[] = [];
      let active = 0;
      for (const [primary, m] of members) {
        if (this.w.isMe(primary)) continue;
        this.w.upsertMember(c.id, primary, { source: 'roster', at: this.now, role: m.admin ? 'admin' : 'member', isActive: m.active });
        if (!m.active) continue;
        active++;
        keep.push(...m.ids);
      }
      this.w.reconcileRoster(c.id, keep, this.now);
      this.w.upsertConversation({ source: SOURCE, sourceConvId: s.jid, kind: 'group', title: s.name, memberCount: active + 1 });
    }
  }
}

/** '<digits>@s.whatsapp.net' / '<digits>@lid' for a person JID in any spelling; null otherwise. */
function canonicalJid(raw: string | null | undefined): string | null {
  const j = parseUserJid(raw);
  if (!j) return null;
  return j.kind === 'phone' ? phoneJid(j.digits) : lidJid(j.digits);
}
