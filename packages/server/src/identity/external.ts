/**
 * Identities from the non-iMessage sources (intelligence §1.1–1.4, deterministic part only):
 *   attachExternalIdentity  a source key (WhatsApp JID/LID, IG id/username, Partiful user, Beeper user, Contacts
 *                           card, phone, email) → its identity, creating it on a new person when unseen. The
 *                           person's status follows §1.4 (service / provisional / roster_only; a Contacts card is
 *                           the user's own record, so active). Names are observations in alias_obs; the person's
 *                           display name follows the §1.4 precedence and only replaces names derived from those
 *                           observations (or a masked handle), never a legacy, user or locked name.
 *   linkIdentityToPerson    deterministic evidence that an identity belongs to a person: a journaled pointer MERGE
 *                           of the identity's (provisional) person with the target, so undo splits them again and
 *                           writes do_not_merge. Guards: identity_blocks, shared identities, do_not_merge, G2
 *                           co-presence, G4 distinct Contacts cards, G7 (a priority/hidden person is never absorbed).
 * Probabilistic matching lives elsewhere (identity/matcherJobs.ts). Nothing here logs names or keys.
 */
import { normalizeNamePart, normalizePhone, uuidv7 } from '@yb/shared';
import { canonicalId, canonicalMembers } from '../db/canon';
import type { DB } from '../db/connection';
import { tx } from '../db/tx';
import { withBatch } from '../journal/batch';
import { instagramUsername } from '../migration/convert';
import { recordHeldLink } from './linkHolds';
import { coPresentSets } from './matcherGuards';
import { mergePeople, MergeRefusedError, type MergeMethod, type MergeRefusal } from './merge';
import {
  findIdentity,
  handleKey,
  maskedHandle,
  NAME_PRECEDENCE,
  pickDisplayName,
  qualification,
  qualifies,
  touchIdentitySeen,
  type NameSource,
  type Qualification,
  type ResolveContext,
} from './resolver';
import { classifyIdentity, serviceKind, type IdentityRef, type ServiceReason } from './service';

export type ExternalKind =
  | 'phone'
  | 'email'
  | 'whatsapp_jid'
  | 'whatsapp_lid'
  | 'instagram_id'
  | 'instagram_username'
  | 'instagram_name'
  | 'partiful_user'
  | 'addressbook_id'
  | 'beeper_user';

/** A normalized identity key: what identities(kind, key) stores. The kind can differ from the input kind. */
export interface ExternalKey extends IdentityRef {
  confidence: number;
}

const MAX_OPAQUE_KEY = 256;

/** WhatsApp "user[.agent][:device]@server" → bare user digits + server; null when the user part isn't numeric. */
function parseJid(raw: string): { digits: string; server: string } | null {
  const s = raw.normalize('NFKC').trim().toLowerCase();
  const at = s.lastIndexOf('@');
  const user = at >= 0 ? s.slice(0, at) : s;
  const server = at >= 0 ? s.slice(at + 1) : '';
  const m = /^\+?(\d{3,20})(?:[.:]\d+)*$/.exec(user);
  return m ? { digits: m[1]!, server } : null;
}

/** "<digits>@s.whatsapp.net" → E.164 phone (so it lands on the same identity as iMessage); "@lid" → whatsapp_lid. */
function whatsappKey(raw: string, assume: 'jid' | 'lid'): ExternalKey | null {
  const j = parseJid(raw);
  if (!j) return null;
  const server = j.server || (assume === 'lid' ? 'lid' : 's.whatsapp.net');
  if (server === 'lid') return { kind: 'whatsapp_lid', key: `${j.digits}@lid`, confidence: 1 };
  if (server !== 's.whatsapp.net' && server !== 'c.us') return null; // g.us groups, broadcast lists, newsletters
  const p = normalizePhone(`+${j.digits}`);
  if (p?.kind === 'e164') return { kind: 'phone', key: p.key, confidence: 1 };
  return { kind: 'whatsapp_jid', key: `${j.digits}@s.whatsapp.net`, confidence: 0.5 };
}

const opaque = (kind: string, raw: string, confidence = 1): ExternalKey | null => {
  const key = raw.normalize('NFKC').trim();
  return key && key.length <= MAX_OPAQUE_KEY ? { kind, key, confidence } : null;
};

/** Per-kind normalization (intelligence §1.1). Null when the value isn't a usable key for that kind. */
export function normalizeExternalKey(kind: ExternalKind, raw: string): ExternalKey | null {
  switch (kind) {
    case 'phone': {
      const k = handleKey(raw);
      return k && (k.kind === 'phone' || k.kind === 'shortcode') ? k : null;
    }
    case 'email': {
      const k = handleKey(raw);
      return k?.kind === 'email' ? k : null;
    }
    case 'whatsapp_jid':
      return whatsappKey(raw, 'jid');
    case 'whatsapp_lid':
      return whatsappKey(raw, 'lid');
    case 'instagram_username': {
      const u = instagramUsername(raw.normalize('NFKC'));
      return u ? { kind, key: u, confidence: 1 } : null;
    }
    case 'instagram_id': {
      const s = raw.trim();
      return /^\d{1,30}$/.test(s) ? { kind, key: s, confidence: 1 } : null;
    }
    case 'instagram_name': {
      // DYI participants without a Beeper match: keyed `ig_dyi:<thread>:<name>` by the importer, weak by nature.
      const s = raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
      return s && s.length <= MAX_OPAQUE_KEY ? { kind, key: s, confidence: 0.5 } : null;
    }
    case 'partiful_user':
    case 'addressbook_id':
    case 'beeper_user':
      return opaque(kind, raw);
  }
}

/** Display-name source (NAME_PRECEDENCE) for a source name. */
export function nameSourceFor(source: string): NameSource {
  switch (source) {
    case 'addressbook':
      return 'addressbook';
    case 'whatsapp':
      return 'whatsapp';
    case 'beeper':
    case 'instagram':
      return 'beeper';
    case 'partiful':
      return 'partiful';
    default:
      return 'ig_dyi';
  }
}

/** The lowest-precedence display name: a masked phone/email, a public IG handle, or a generic label. */
export function externalMaskedHandle(k: IdentityRef): string {
  switch (k.kind) {
    case 'phone':
    case 'email':
    case 'shortcode':
    case 'business_chat':
      return maskedHandle(k);
    case 'instagram_username':
      return `@${k.key}`;
    case 'instagram_id':
    case 'instagram_name':
      return 'Instagram user';
    case 'whatsapp_jid':
    case 'whatsapp_lid':
      return 'WhatsApp user';
    case 'partiful_user':
      return 'Partiful guest';
    case 'beeper_user':
      return 'Beeper user';
    case 'addressbook_id':
      return 'Contacts card';
    default:
      return '(unknown)';
  }
}

const cleanName = (s: string | null | undefined): string | null => {
  const t = s?.normalize('NFKC').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, 200) : null;
};

/**
 * What the adapter knows that `messages` doesn't (yet): counters for this page, or a qualifying relationship.
 * They add to the §1.4 counters read from the database, so don't pass counts for messages already written.
 */
export interface ExternalSignals {
  fromMe?: number;
  theirs?: number;
  /** Posted in a group that has ≥1 known person. */
  groupWithKnown?: boolean;
  /** Group rosters this identity is in (the larger of this and the stored count is used). */
  groups?: number;
  /** A relationship that qualifies on its own (e.g. a Partiful RSVP to my event). */
  qualifies?: boolean;
  /** A §1.3 service signal from the source (business account, bot, spam flag). */
  service?: ServiceReason | null;
}

export interface ExternalIdentityInput {
  kind: ExternalKind;
  /** The source's value; normalized per kind (a WhatsApp phone JID becomes an E.164 'phone' identity). */
  key: string;
  /** identities.raw (default: `key` as given). */
  raw?: string | null;
  displayName?: string | null;
  /** Where `displayName` ranks (default from `source`). */
  nameSource?: NameSource;
  /** identities.source / people.origin (default ctx.source). */
  source?: string;
  /** When the source saw it (default ctx.now). */
  at?: number | null;
  signals?: ExternalSignals;
  /**
   * Same-payload / same-card evidence that this identity belongs to a known person (an IG id and username from
   * one Beeper participant, every key on one Contacts card): attach it there instead of creating a person.
   */
  personId?: string;
  /** Pre-allocated id for a new identity (rows referencing it may already sit in a deferred-FK transaction). */
  identityId?: string;
}

interface IdentityFull {
  id: string;
  person_id: string;
  kind: string;
  key: string;
  status: string;
  shared: number;
}

interface PersonRow {
  id: string;
  display_name: string;
  kind: string;
  status: string;
  is_hidden: number;
  is_priority: number;
  locked_fields: string;
  origin: string;
}

const getPerson = (db: DB, id: string) =>
  db.prepare('SELECT id, display_name, kind, status, is_hidden, is_priority, locked_fields, origin FROM people WHERE id = ?').get(id) as
    | PersonRow
    | undefined;

const getIdentity = (db: DB, id: string) =>
  db.prepare('SELECT id, person_id, kind, key, status, shared FROM identities WHERE id = ?').get(id) as IdentityFull | undefined;

/** The person (pre-canon) an identity is bound to. */
export const personOfIdentity = (db: DB, identityId: string): string | null =>
  (db.prepare('SELECT person_id FROM identities WHERE id = ?').pluck().get(identityId) as string | undefined) ?? null;

/** Upserts a name observation (class E). A re-read of the same sighting doesn't bump seen_count. */
export function recordAlias(db: DB, identityId: string, name: string, source: NameSource | string, at: number): boolean {
  const raw = cleanName(name);
  const norm = raw ? normalizeNamePart(raw) : '';
  if (!raw || !norm) return false;
  return (
    db
      .prepare(
        `INSERT INTO alias_obs (identity_id, name_raw, name_norm, source, first_seen_at, last_seen_at, seen_count)
         VALUES (?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT (identity_id, name_norm, source) DO UPDATE SET
           name_raw = CASE WHEN excluded.last_seen_at >= alias_obs.last_seen_at THEN excluded.name_raw ELSE alias_obs.name_raw END,
           first_seen_at = min(alias_obs.first_seen_at, excluded.first_seen_at),
           seen_count = alias_obs.seen_count + (excluded.last_seen_at > alias_obs.last_seen_at),
           last_seen_at = max(alias_obs.last_seen_at, excluded.last_seen_at)
         WHERE excluded.last_seen_at > alias_obs.last_seen_at OR excluded.first_seen_at < alias_obs.first_seen_at
           OR (excluded.last_seen_at = alias_obs.last_seen_at AND excluded.name_raw IS NOT alias_obs.name_raw)`,
      )
      .run(identityId, raw, norm, source, at, at).changes > 0
  );
}

const rankOf = (source: string) => {
  const i = (NAME_PRECEDENCE as readonly string[]).indexOf(source);
  return i === -1 ? NAME_PRECEDENCE.length : i;
};

const inSet = (ids: readonly string[]) => JSON.stringify(ids);

/**
 * Re-picks the display name of an identity's canonical person from the alias observations of all its identities
 * (precedence, then most recent, then most seen). Replaces the current name only if it was itself derived: a
 * masked handle or an observed name of equal or lower precedence. Locked, legacy and user-typed names stay.
 */
export function refreshDisplayName(ctx: ResolveContext, personId: string): boolean {
  const db = ctx.db;
  const canonical = canonicalId(db, personId);
  const p = getPerson(db, canonical);
  if (!p || p.kind !== 'person' || p.status === 'service' || p.status === 'suppressed') return false;
  if ((JSON.parse(p.locked_fields || '[]') as string[]).includes('display_name')) return false;
  const members = inSet(canonicalMembers(db, canonical));
  const idents = db
    .prepare(`SELECT id, kind, key FROM identities WHERE status = 'active' AND person_id IN (SELECT value FROM json_each(?))`)
    .all(members) as { id: string; kind: string; key: string }[];
  if (!idents.length) return false;
  const aliases = db
    .prepare(
      `SELECT name_raw, source, last_seen_at, seen_count FROM alias_obs WHERE identity_id IN (SELECT value FROM json_each(?))`,
    )
    .all(inSet(idents.map((i) => i.id))) as { name_raw: string; source: string; last_seen_at: number; seen_count: number }[];
  if (!aliases.length) return false;
  const best = [...aliases].sort(
    (a, b) => rankOf(a.source) - rankOf(b.source) || b.last_seen_at - a.last_seen_at || b.seen_count - a.seen_count,
  )[0]!;
  const next = best.name_raw.trim();
  if (!next || next === p.display_name) return false;
  const bestRank = rankOf(best.source);
  const derived = new Set<string>(['(unknown)', ...idents.map(externalMaskedHandle)]);
  for (const a of aliases) if (rankOf(a.source) >= bestRank) derived.add(a.name_raw.trim());
  if (!derived.has(p.display_name)) return false;
  const { changes } = withBatch(
    db,
    {
      runId: ctx.runId(),
      kind: 'person_update',
      title: `Named ${p.display_name} “${next}”`,
      subjectPersonId: canonical,
      actor: ctx.actor ?? 'agent',
    },
    (t) => t.update('people', { id: canonical }, { display_name: next }),
    { now: ctx.now },
  );
  return changes > 0;
}

type NewStatus = { status: 'active' | 'provisional' | 'roster_only'; service: ServiceReason | null };

/** §1.3 then §1.4 for a key (and, for a pre-allocated id, whatever is already stored against it). */
function judge(db: DB, k: ExternalKey, identityId: string | null, s: ExternalSignals = {}): NewStatus {
  const service = classifyIdentity(k) ?? s.service ?? null;
  if (service) return { status: 'roster_only', service };
  if (k.kind === 'addressbook_id') return { status: 'active', service: null };
  const q: Qualification = identityId ? qualification(db, identityId) : { fromMe: 0, theirs: 0, groupWithKnown: 0, groups: 0 };
  const combined: Qualification = {
    fromMe: q.fromMe + (s.fromMe ?? 0),
    theirs: q.theirs + (s.theirs ?? 0),
    groupWithKnown: q.groupWithKnown + (s.groupWithKnown ? 1 : 0),
    groups: Math.max(q.groups, s.groups ?? 0),
  };
  return { status: s.qualifies || qualifies(combined) ? 'provisional' : 'roster_only', service: null };
}

/** create_person batch: a new person plus the identity that introduced it. person_canon gets its own root row. */
function createPersonWithIdentity(
  ctx: ResolveContext,
  k: ExternalKey,
  o: { identityId: string; source: string; raw: string | null; displayName: string | null; nameSource: NameSource; at: number; verdict: NewStatus },
): string {
  const personId = uuidv7(ctx.now);
  const name = pickDisplayName({ [o.nameSource]: o.displayName, handle: externalMaskedHandle(k) }) ?? '(unknown)';
  const { status, service } = o.verdict;
  const title = service
    ? `Filed ${name} as a service sender (${service.replaceAll('_', ' ')})`
    : status === 'active'
      ? `Added ${name} from ${o.source}`
      : status === 'provisional'
        ? `New person ${name} from ${o.source}`
        : `Noted ${name} from ${o.source} (not yet a contact)`;
  withBatch(
    ctx.db,
    { runId: ctx.runId(), kind: 'create_person', title, subjectPersonId: personId, actor: ctx.actor ?? 'agent', confidence: k.confidence },
    (t) => {
      t.insert('people', {
        id: personId,
        display_name: name,
        kind: service ? serviceKind(service) : 'person',
        status: service ? 'service' : status,
        origin: o.source,
        created_by_run: ctx.runId(),
      });
      t.insert('identities', {
        id: o.identityId,
        person_id: personId,
        kind: k.kind,
        key: k.key,
        raw: o.raw,
        display_name: o.displayName,
        source: o.source,
        match_method: k.kind === 'addressbook_id' ? 'addressbook' : 'deterministic',
        confidence: k.confidence,
        status: service ? 'service' : 'active',
        first_seen_at: o.at,
        last_seen_at: o.at,
        created_by_run: ctx.runId(),
      });
    },
    { now: ctx.now },
  );
  // A new unmerged person is its own root: no need to rebuild all of person_canon.
  ctx.db.prepare('INSERT OR REPLACE INTO person_canon (person_id, canonical_id) VALUES (?, ?)').run(personId, personId);
  return personId;
}

/** A roster_only person whose identity is now a service sender or qualifies (§1.4) is re-filed. */
function reclassify(ctx: ResolveContext, ident: IdentityFull, k: ExternalKey, s: ExternalSignals | undefined): void {
  const p = getPerson(ctx.db, ident.person_id);
  if (!p || p.kind !== 'person' || p.status !== 'roster_only') return;
  const v = judge(ctx.db, k, ident.id, s);
  const base = { runId: ctx.runId(), kind: 'person_update', subjectPersonId: p.id, actor: ctx.actor ?? 'agent' } as const;
  if (v.service) {
    const reason = v.service;
    withBatch(
      ctx.db,
      { ...base, title: `Filed ${p.display_name} as a service sender (${reason.replaceAll('_', ' ')})` },
      (t) => {
        t.update('identities', { id: ident.id }, { status: 'service' });
        t.update('people', { id: p.id }, { status: 'service', kind: serviceKind(reason) });
      },
      { now: ctx.now },
    );
  } else if (v.status !== 'roster_only') {
    const title = `New person ${p.display_name} from ${ctx.source}`;
    withBatch(ctx.db, { ...base, title }, (t) => t.update('people', { id: p.id }, { status: 'provisional' }), { now: ctx.now });
  }
}

/**
 * The identity for a source key, created (on a new person, or on `personId`) when unseen. Returns null when the
 * key doesn't normalize (a WhatsApp group JID, a malformed username). Joins the caller's transaction.
 */
export function attachExternalIdentity(ctx: ResolveContext, input: ExternalIdentityInput): string | null {
  const k = normalizeExternalKey(input.kind, input.key);
  if (!k) return null;
  const source = input.source ?? ctx.source;
  const at = input.at ?? ctx.now;
  const nameSource = input.nameSource ?? nameSourceFor(source);
  const displayName = cleanName(input.displayName);
  const raw = input.raw === undefined ? input.key : input.raw;
  const sctx: ResolveContext = { ...ctx, source };
  return tx(ctx.db, () => {
    const found = findIdentity(ctx.db, k);
    if (found) {
      const ident = getIdentity(ctx.db, found.id)!;
      touchIdentitySeen(ctx.db, ident.id, at);
      if (displayName) recordAlias(ctx.db, ident.id, displayName, nameSource, at);
      if (ident.status !== 'active') return ident.id;
      const linkTo = input.personId && getPerson(ctx.db, input.personId) ? input.personId : null;
      if (linkTo && canonicalId(ctx.db, linkTo) !== canonicalId(ctx.db, ident.person_id)) {
        linkIdentityToPerson(sctx, ident.id, linkTo, { method: 'deterministic' });
      } else {
        reclassify(sctx, ident, k, input.signals);
      }
      if (displayName) refreshDisplayName(sctx, ident.person_id);
      return ident.id;
    }
    const attached = input.personId ? attachToKnownPerson(sctx, k, input.personId, { identityId: input.identityId, raw, displayName, at }) : null;
    if (attached) {
      if (displayName) {
        recordAlias(ctx.db, attached, displayName, nameSource, at);
        refreshDisplayName(sctx, input.personId!);
      }
      return attached;
    }
    const identityId = input.identityId ?? uuidv7(ctx.now);
    createPersonWithIdentity(sctx, k, {
      identityId,
      source,
      raw,
      displayName,
      nameSource,
      at,
      verdict: judge(ctx.db, k, input.identityId ?? null, input.signals),
    });
    if (displayName) recordAlias(ctx.db, identityId, displayName, nameSource, at);
    return identityId;
  });
}

/**
 * A brand-new identity bound straight to a known person (one attach_identity batch: undo moves it to a new
 * provisional person and blocks it from this one). Null when the person can't take it (blocked, service, gone).
 */
function attachToKnownPerson(
  ctx: ResolveContext,
  k: ExternalKey,
  personId: string,
  o: { identityId?: string; raw: string | null; displayName: string | null; at: number },
): string | null {
  const owner = getPerson(ctx.db, personId);
  const target = owner && getPerson(ctx.db, canonicalId(ctx.db, personId));
  if (!owner || !target || owner.status === 'suppressed' || target.status === 'suppressed' || target.status === 'service') return null;
  if (target.kind !== 'person' && target.kind !== 'me') return null;
  if (classifyIdentity(k) || isBlockedForSet(ctx.db, k, canonicalMembers(ctx.db, target.id))) return null;
  const id = o.identityId ?? uuidv7(ctx.now);
  withBatch(
    ctx.db,
    {
      runId: ctx.runId(),
      kind: 'attach_identity',
      title: `Linked ${externalMaskedHandle(k)} to ${target.kind === 'me' ? 'you' : target.display_name}`,
      subjectPersonId: target.id,
      actor: ctx.actor ?? 'agent',
      confidence: k.confidence,
    },
    (t) =>
      t.insert('identities', {
        id,
        person_id: personId,
        kind: k.kind,
        key: k.key,
        raw: o.raw,
        display_name: o.displayName,
        source: ctx.source,
        match_method: k.kind === 'addressbook_id' ? 'addressbook' : 'deterministic',
        confidence: k.confidence,
        first_seen_at: o.at,
        last_seen_at: o.at,
        created_by_run: ctx.runId(),
      }),
    { now: ctx.now },
  );
  return id;
}

const isBlockedForSet = (db: DB, k: IdentityRef, personIds: readonly string[]): boolean =>
  db
    .prepare('SELECT 1 FROM identity_blocks WHERE kind = ? AND key = ? AND person_id IN (SELECT value FROM json_each(?)) LIMIT 1')
    .get(k.kind, k.key, inSet(personIds)) !== undefined;

// ---------------------------------------------------------------------------------------------- linking

export type LinkHoldReason =
  | 'not_found'
  | 'service'
  | 'shared'
  | 'blocked'
  | 'target_unavailable'
  | 'distinct_cards'
  | 'co_presence'
  | MergeRefusal;

export type LinkResult =
  | { outcome: 'linked'; via: 'merge' | 'attach'; batchId: string; survivorId: string; mergedId: string }
  | { outcome: 'unchanged' }
  | { outcome: 'held'; reason: LinkHoldReason };

export interface LinkOptions {
  /** 'deterministic' (default) for source evidence; 'user' skips the G2/G4 holds (the user decided). */
  method?: MergeMethod;
  confidence?: number | null;
  /** Ids and counts for "why" (never raw handles or message text). */
  evidence?: unknown;
  title?: string;
}

/** G4: both sides carry Contacts cards, and different ones (the user kept them apart on purpose). */
function distinctCards(db: DB, a: readonly string[], b: readonly string[]): boolean {
  const cards = (ids: readonly string[]) =>
    db
      .prepare(`SELECT key FROM identities WHERE kind = 'addressbook_id' AND status = 'active' AND person_id IN (SELECT value FROM json_each(?))`)
      .pluck()
      .all(inSet(ids)) as string[];
  const ca = cards(a);
  const cb = new Set(cards(b));
  return ca.length > 0 && cb.size > 0 && !ca.some((c) => cb.has(c));
}

const AUTO_CREATED = new Set(['provisional', 'roster_only']);

/** An agent-made weak person (never a legacy/user record, never priority or hidden). */
const isAutoCreated = (p: PersonRow) =>
  p.kind === 'person' && AUTO_CREATED.has(p.status) && !p.is_hidden && !p.is_priority && p.origin !== 'legacy' && p.origin !== 'user';

/**
 * My own account seen on another source (e.g. my Instagram in Beeper): its auto-created person's identities move
 * to me and the emptied person is retired, in one attach_identity batch (undo moves them back and blocks them).
 */
function moveToMe(ctx: ResolveContext, from: PersonRow, me: PersonRow): LinkResult {
  if (!isAutoCreated(from)) return { outcome: 'held', reason: 'me_mismatch' };
  const members = canonicalMembers(ctx.db, from.id);
  const idents = ctx.db
    .prepare(`SELECT id, kind, key FROM identities WHERE status = 'active' AND person_id IN (SELECT value FROM json_each(?))`)
    .all(inSet(members)) as { id: string; kind: string; key: string }[];
  if (idents.some((i) => isBlockedForSet(ctx.db, i, [me.id]))) return { outcome: 'held', reason: 'blocked' };
  const { batchId } = withBatch(
    ctx.db,
    { runId: ctx.runId(), kind: 'attach_identity', title: `Linked ${from.display_name} to you`, subjectPersonId: me.id, actor: ctx.actor ?? 'agent' },
    (t) => {
      for (const i of idents) t.update('identities', { id: i.id }, { person_id: me.id });
      // Only the root is retired: people merged into it keep their pointer (status 'merged' must match it).
      const left = ctx.db.prepare('SELECT count(*) FROM identities WHERE person_id = ?').pluck().get(from.id) as number;
      if (left === 0) t.tombstone('people', { id: from.id });
    },
    { now: ctx.now },
  );
  return { outcome: 'linked', via: 'attach', batchId, survivorId: me.id, mergedId: from.id };
}

/**
 * Deterministic link of an identity to a person: a journaled pointer merge of the identity's canonical person
 * and the target's (the target survives unless G7 says otherwise), so undo restores the separation and writes
 * do_not_merge. Holds (no merge) instead of throwing when a guard says no; a G2/G4/G7 hold is kept as a held
 * match candidate and raises the 'identity-link' alert (intelligence §1.2), the owner's own blocks and
 * do_not_merge stay silent.
 */
export function linkIdentityToPerson(ctx: ResolveContext, identityId: string, personId: string, o: LinkOptions = {}): LinkResult {
  const db = ctx.db;
  return tx(db, () => {
    const ident = getIdentity(db, identityId);
    if (!ident || !getPerson(db, personId)) return { outcome: 'held', reason: 'not_found' } as const;
    if (ident.status === 'service') return { outcome: 'held', reason: 'service' } as const;
    if (ident.status !== 'active') return { outcome: 'held', reason: 'not_found' } as const; // detached / superseded
    if (ident.shared) return { outcome: 'held', reason: 'shared' } as const;
    const targetId = canonicalId(db, personId);
    const sourceId = canonicalId(db, ident.person_id);
    if (targetId === sourceId) return { outcome: 'unchanged' } as const;
    const target = getPerson(db, targetId)!;
    const from = getPerson(db, sourceId)!;
    if (target.status === 'suppressed' || target.status === 'service' || (target.kind !== 'person' && target.kind !== 'me')) {
      return { outcome: 'held', reason: 'target_unavailable' } as const;
    }
    const targetSet = canonicalMembers(db, targetId);
    const sourceSet = canonicalMembers(db, sourceId);
    if (isBlockedForSet(db, ident, targetSet)) return { outcome: 'held', reason: 'blocked' } as const;
    if (target.kind === 'me') return moveToMe(ctx, from, target);
    if (from.kind === 'me') return { outcome: 'held', reason: 'me_mismatch' } as const;
    const method = o.method ?? 'deterministic';
    const hold = (reason: 'distinct_cards' | 'co_presence' | 'priority_absorbed') => {
      recordHeldLink(db, sourceId, targetId, { reason, identityKind: ident.kind, source: ctx.source, confidence: o.confidence ?? null, now: ctx.now });
      return { outcome: 'held', reason } as const;
    };
    if (method !== 'user') {
      if (distinctCards(db, sourceSet, targetSet)) return hold('distinct_cards');
      // G2 as the matcher defines it: an inferred or withdrawn occasion row is no guest list.
      if (coPresentSets(db, sourceSet, targetSet)) return hold('co_presence');
    }
    // G7: a priority or hidden person absorbs the other side, never the reverse.
    const keepsSource = (from.is_priority || from.is_hidden) && !(target.is_priority || target.is_hidden);
    const [survivor, merged] = keepsSource ? [from, target] : [target, from];
    try {
      const r = mergePeople(db, {
        survivorId: survivor.id,
        mergedId: merged.id,
        method,
        runId: ctx.runId(),
        actor: ctx.actor ?? 'agent',
        score: o.confidence ?? null,
        confidence: o.confidence ?? null,
        evidence: o.evidence ?? { identity_kind: ident.kind, method },
        title: o.title ?? `Linked ${from.display_name} (${externalMaskedHandle(ident)}) to ${target.display_name}`,
        now: ctx.now,
      });
      return { outcome: 'linked', via: 'merge', batchId: r.batchId, survivorId: r.survivorId, mergedId: r.mergedId } as const;
    } catch (e) {
      if (!(e instanceof MergeRefusedError)) throw e;
      return e.reason === 'priority_absorbed' && method !== 'user' ? hold('priority_absorbed') : ({ outcome: 'held', reason: e.reason } as const);
    }
  });
}
