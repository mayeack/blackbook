/**
 * Address-book ingest (PLAN "Ingestion → Address book", intelligence §1.2). The collector returns the whole
 * CNContactStore dump with a hash; an unchanged hash is a no-op, otherwise only cards whose content hash changed
 * are applied (so undoing an agent change sticks until the card itself changes). Per card:
 *   1. shared-identity detection runs first, over the whole dump: a phone/email on ≥2 cards whose names are
 *      incompatible (first-name score 0 or a last-name conflict) gets identities.shared = 1, never a merge key;
 *   2. the card's addressbook_id identity decides its person; a new card is linked to an existing person that owns
 *      one of its non-shared keys (phone, email, IG username) when that person can take it (an agent-made
 *      provisional person always can; an established one needs a compatible name; "me" needs ≥2 of my keys),
 *      else it becomes a new active person;
 *   3. every key on the card belongs to the card's person (AB record expansion): new keys attach, keys owned by
 *      someone else are linked through the journaled deterministic merge (identity/external.ts), except shared,
 *      weak (raw phone) or conflicting ones. Two cards listing the same non-shared key with compatible names are
 *      merged deterministically (the only way two cards ever merge: G4);
 *   4. the Contacts card is the highest-precedence name source: name, nickname, company, job title and birthday
 *      (display data only) follow the person's primary card unless the user locked that field in yeackbot.
 * A card that leaves the dump detaches its addressbook_id identity (journaled), unless the dump looks truncated.
 * Never writes to Contacts. Logs and stats carry counts only.
 */
import type { ContactsResponse } from '@yb/shared/collector/v1';
import { canonicalId, canonicalMembers } from '../../db/canon';
import type { DB } from '../../db/connection';
import { tx } from '../../db/tx';
import { attachExternalIdentity, linkIdentityToPerson, normalizeExternalKey, personOfIdentity, recordAlias } from '../../identity/external';
import { coPresentSets } from '../../identity/matcherGuards';
import { namesCompatible, personName } from '../../identity/matcherNames';
import { chooseSurvivor, mergePeople, MergeRefusedError } from '../../identity/merge';
import { selfRefs, type SelfRefs } from '../../identity/self';
import { touchIdentitySeen, type ResolveContext } from '../../identity/resolver';
import { withBatch } from '../../journal/batch';
import { sourceRun } from '../common/context';
import { readCursor, recordSourceHealth, writeCursor } from '../common/cursors';
import { keySig, parseCard, type CardFields, type CardKey, type ParsedCard } from './cards';
import type { ContactsSource } from './client';

export const SOURCE = 'addressbook';
export const DUMP_SCOPE = 'dump';
/** A dump that drops more than this many cards and this share of them looks truncated: removals are held. */
const MASS_REMOVAL_MIN = 10;
const MASS_REMOVAL_SHARE = 0.25;

export interface AddressBookStats {
  cards: number;
  dump_unchanged: number;
  cards_unchanged: number;
  cards_new: number;
  cards_changed: number;
  cards_skipped: number;
  cards_removed: number;
  cards_restored: number;
  removals_held: number;
  people_created: number;
  cards_linked: number;
  keys_attached: number;
  keys_linked: number;
  keys_held: number;
  shared_marked: number;
  people_updated: number;
}

const emptyStats = (): AddressBookStats => ({
  cards: 0,
  dump_unchanged: 0,
  cards_unchanged: 0,
  cards_new: 0,
  cards_changed: 0,
  cards_skipped: 0,
  cards_removed: 0,
  cards_restored: 0,
  removals_held: 0,
  people_created: 0,
  cards_linked: 0,
  keys_attached: 0,
  keys_linked: 0,
  keys_held: 0,
  shared_marked: 0,
  people_updated: 0,
});

interface PersonRow {
  id: string;
  display_name: string;
  first_name: string | null;
  last_name: string | null;
  nickname: string | null;
  company: string | null;
  job_title: string | null;
  birthday: string | null;
  kind: string;
  status: string;
  origin: string;
  is_hidden: number;
  is_priority: number;
  locked_fields: string;
}

interface IdentityRow {
  id: string;
  person_id: string;
  kind: string;
  key: string;
  status: string;
  shared: number;
}

interface StoredCard {
  card_id: string;
  identity_id: string | null;
  content_hash: string;
  removed_at: number | null;
}

const getPerson = (db: DB, id: string) =>
  db
    .prepare(
      `SELECT id, display_name, first_name, last_name, nickname, company, job_title, birthday, kind, status, origin, is_hidden,
              is_priority, locked_fields FROM people WHERE id = ?`,
    )
    .get(id) as PersonRow | undefined;

const findIdent = (db: DB, k: { kind: string; key: string }) =>
  db.prepare('SELECT id, person_id, kind, key, status, shared FROM identities WHERE kind = ? AND key = ?').get(k.kind, k.key) as
    | IdentityRow
    | undefined;

const inSet = (ids: readonly string[]) => JSON.stringify(ids);

/** An agent-made weak person: its observed names never stand in the way of a Contacts card. */
const isAutoCreated = (p: PersonRow) =>
  p.kind === 'person' && (p.status === 'provisional' || p.status === 'roster_only') && p.origin !== 'legacy' && p.origin !== 'user';

/**
 * Whether a (non-me) person may carry this card: not retired, and an agent-made person or a compatible name. A
 * card without a person's name (a business card) never lands on a named person: it would rename them.
 */
function acceptsCard(p: PersonRow | undefined, card: ParsedCard): boolean {
  if (!p || p.kind !== 'person' || p.status === 'suppressed' || p.status === 'service' || p.status === 'merged') return false;
  if (isAutoCreated(p)) return true;
  const name = personName(p);
  return card.name ? namesCompatible(card.name, name) : !name;
}

const KIND_LABEL: Record<string, string> = { phone: 'phone number', email: 'email address', instagram_username: 'Instagram username' };

/** Phone/email keys listed on ≥2 cards whose names are incompatible: never merge keys. */
export function sharedKeys(keyCards: Map<string, ParsedCard[]>): Set<string> {
  const out = new Set<string>();
  for (const [sig, cards] of keyCards) {
    if (cards.length < 2 || sig.startsWith('instagram_username')) continue;
    const ok = cards.every((x, i) => cards.slice(i + 1).every((y) => namesCompatible(x.name, y.name) && !!x.name === !!y.name));
    if (!ok) out.add(sig);
  }
  return out;
}

function keyIndex(cards: ParsedCard[]): Map<string, ParsedCard[]> {
  const m = new Map<string, ParsedCard[]>();
  for (const c of cards) {
    for (const k of c.keys) {
      const sig = keySig(k.norm);
      const list = m.get(sig);
      if (list) list.push(c);
      else m.set(sig, [c]);
    }
  }
  return m;
}

class CardPass {
  readonly stats = emptyStats();
  /** Canonical people whose card fields need re-applying. */
  readonly affected = new Set<string>();
  /** My handles, read once per pass. */
  private readonly self: SelfRefs;

  constructor(
    private readonly ctx: ResolveContext,
    private readonly keyCards: Map<string, ParsedCard[]>,
    private readonly shared: Set<string>,
  ) {
    this.self = selfRefs(ctx.db);
  }

  private get db() {
    return this.ctx.db;
  }

  private batch(title: string, subjectPersonId: string, fn: Parameters<typeof withBatch>[2]): void {
    withBatch(this.db, { runId: this.ctx.runId(), kind: 'person_update', title, subjectPersonId, actor: 'agent' }, fn, { now: this.ctx.now });
  }

  markShared(identityId: string): void {
    const ident = this.db.prepare('SELECT kind, person_id, shared FROM identities WHERE id = ?').get(identityId) as
      | { kind: string; person_id: string; shared: number }
      | undefined;
    if (!ident || ident.shared) return;
    // My own handles are mine by configuration: never flagged, never linked through a card anyway.
    if (getPerson(this.db, canonicalId(this.db, ident.person_id))?.kind === 'me') return;
    this.batch(
      `Marked a ${KIND_LABEL[ident.kind] ?? 'contact detail'} as shared (it is on several Contacts cards)`,
      canonicalId(this.db, ident.person_id),
      (t) => t.update('identities', { id: identityId }, { shared: 1 }),
    );
    this.stats.shared_marked++;
  }

  /** Before any card: shared keys that already exist are flagged, so no card pass can link through them. */
  markExistingShared(): void {
    for (const sig of this.shared) {
      const [kind, key] = sig.split('\u0000') as [string, string];
      const ident = findIdent(this.db, { kind, key });
      if (ident?.status === 'active') this.markShared(ident.id);
    }
  }

  /**
   * The existing person a new card belongs to: the first owner of one of its non-shared keys that can take it. A
   * person already backed by another card qualifies only through a key that card lists in this dump (G4).
   */
  private cardTarget(card: ParsedCard): string | null {
    const owners = new Map<string, { n: number; sigs: string[] }>();
    const mine = new Map<string, number>();
    for (const k of card.keys) {
      const sig = keySig(k.norm);
      const ident = k.norm.confidence < 1 ? undefined : findIdent(this.db, k.norm);
      // My own card carries at least two of my handles (even one also listed on a partner's card); a card with
      // just one of them (a partner's "home" line) is theirs. A handle of mine not bound to me yet (a Gmail alias,
      // my number first seen on a stray record) counts too: selfLink.ts moves it to me.
      if (this.self.meId && k.norm.confidence === 1 && this.self.isMine(k.norm.kind, k.norm.key)) {
        mine.set(this.self.meId, (mine.get(this.self.meId) ?? 0) + 1);
        continue;
      }
      if (!ident || ident.status !== 'active') continue;
      const owner = canonicalId(this.db, ident.person_id);
      if (getPerson(this.db, owner)?.kind === 'me') {
        mine.set(owner, (mine.get(owner) ?? 0) + 1);
        continue;
      }
      if (this.shared.has(sig) || ident.shared) continue;
      const o = owners.get(owner) ?? { n: 0, sigs: [] };
      o.n++;
      o.sigs.push(sig);
      owners.set(owner, o);
    }
    for (const [me, n] of mine) if (n >= 2) return me;
    for (const [owner, o] of owners) {
      const p = getPerson(this.db, owner);
      if (!acceptsCard(p, card)) continue;
      const cards = this.activeCards(owner);
      if (!cards.length || o.sigs.some((sig) => this.listedByOtherCard(sig, cards))) return owner;
    }
    return null;
  }

  /** One of `cards` lists the key in this dump. */
  private listedByOtherCard(sig: string, cards: readonly string[]): boolean {
    const listing = new Set((this.keyCards.get(sig) ?? []).map((c) => c.id));
    return cards.some((c) => listing.has(c));
  }

  private activeCards(personId: string): string[] {
    return this.db
      .prepare(`SELECT key FROM identities WHERE kind = 'addressbook_id' AND status = 'active' AND person_id IN (SELECT value FROM json_each(?))`)
      .pluck()
      .all(inSet(canonicalMembers(this.db, personId))) as string[];
  }

  /** Two cards listing the same non-shared key, names compatible: one person (deterministic, undoable). */
  private mergeCards(x: string, y: string, key: CardKey): boolean {
    if (coPresentSets(this.db, canonicalMembers(this.db, x), canonicalMembers(this.db, y))) return false;
    const { survivorId, mergedId } = chooseSurvivor(this.db, x, y, this.ctx.now);
    const s = getPerson(this.db, survivorId)!;
    const m = getPerson(this.db, mergedId)!;
    try {
      mergePeople(this.db, {
        survivorId,
        mergedId,
        method: 'deterministic',
        runId: this.ctx.runId(),
        actor: 'agent',
        evidence: { via: 'addressbook', identity_kind: key.norm.kind, cards: 2 },
        title: `Merged ${m.display_name} into ${s.display_name} (same ${KIND_LABEL[key.norm.kind] ?? 'detail'} on both Contacts cards)`,
        now: this.ctx.now,
      });
      return true;
    } catch (e) {
      if (e instanceof MergeRefusedError) return false;
      throw e;
    }
  }

  /** One key of the card onto the card's person (canonical id, re-resolved per key: a link can move the root). */
  private attachKey(cardPersonId: string, card: ParsedCard, key: CardKey): void {
    const db = this.db;
    const sig = keySig(key.norm);
    const isShared = this.shared.has(sig);
    const cardPerson = canonicalId(db, cardPersonId);
    const found = findIdent(db, key.norm);
    if (!found) {
      const id = attachExternalIdentity(this.ctx, { kind: key.kind, key: key.raw, personId: cardPerson, at: this.ctx.now });
      if (!id) return;
      this.stats.keys_attached++;
      if (isShared) this.markShared(id);
      return;
    }
    touchIdentitySeen(db, found.id, this.ctx.now);
    if (found.status !== 'active') return; // a service sender, a detached or superseded identity
    if (isShared && !found.shared) this.markShared(found.id);
    const owner = canonicalId(db, found.person_id);
    if (owner === cardPerson) return;
    if (isShared || found.shared || key.norm.confidence < 1) {
      this.stats.keys_held++;
      return;
    }
    const ownerP = getPerson(db, owner);
    const cardP = getPerson(db, cardPerson);
    let linked = false;
    if (ownerP?.kind === 'me' || cardP?.kind === 'me') {
      // My card picks up my keys seen on agent-made people; nobody else's card ever takes one of mine.
      if (cardP?.kind === 'me' && ownerP && isAutoCreated(ownerP)) {
        linked = linkIdentityToPerson(this.ctx, found.id, cardPerson, { evidence: { via: 'addressbook', identity_kind: key.norm.kind } }).outcome === 'linked';
      }
    } else if (acceptsCard(ownerP, card)) {
      const ownerCards = this.activeCards(owner);
      if (ownerCards.length) {
        // G4: two cards merge only through a non-shared key both of them list in this dump.
        linked = this.listedByOtherCard(sig, ownerCards) && this.mergeCards(owner, cardPerson, key);
      } else {
        const r = linkIdentityToPerson(this.ctx, found.id, cardPerson, {
          method: 'deterministic',
          evidence: { via: 'addressbook', identity_kind: key.norm.kind },
        });
        linked = r.outcome === 'linked';
      }
    }
    if (linked) this.stats.keys_linked++;
    else this.stats.keys_held++;
  }

  private upsertCard(card: ParsedCard, identityId: string | null): void {
    this.db
      .prepare(
        `INSERT INTO addressbook_cards (card_id, identity_id, content_hash, fields, modified_at, first_seen_at, last_seen_at, removed_at)
         VALUES (@id, @ident, @hash, @fields, @modified, @now, @now, NULL)
         ON CONFLICT (card_id) DO UPDATE SET identity_id = excluded.identity_id, content_hash = excluded.content_hash,
           fields = excluded.fields, modified_at = excluded.modified_at, last_seen_at = excluded.last_seen_at, removed_at = NULL`,
      )
      .run({ id: card.id, ident: identityId, hash: card.hash, fields: JSON.stringify(card.fields), modified: card.modifiedAt, now: this.ctx.now });
  }

  applyCard(card: ParsedCard, stored: StoredCard | undefined): void {
    const db = this.db;
    const abKey = normalizeExternalKey('addressbook_id', card.id);
    if (!abKey) {
      this.stats.cards_skipped++;
      return;
    }
    let ab = findIdent(db, abKey);
    let personId: string;
    if (ab) {
      if (ab.status === 'detached' && stored?.removed_at != null) {
        const id = ab.id;
        this.batch('Contacts card is back', canonicalId(db, ab.person_id), (t) => t.update('identities', { id }, { status: 'active' }));
        this.stats.cards_restored++;
        ab = findIdent(db, abKey)!;
      }
      const owner = getPerson(db, canonicalId(db, ab.person_id));
      // An identity the agent can't use, or a person the user removed (undone creation): leave both alone.
      if (ab.status !== 'active' || !owner || owner.status === 'suppressed' || owner.status === 'service') {
        this.stats.cards_skipped++;
        this.upsertCard(card, ab.id);
        return;
      }
      if (card.fields.displayName) recordAlias(db, ab.id, card.fields.displayName, 'addressbook', this.ctx.now);
      touchIdentitySeen(db, ab.id, this.ctx.now);
      personId = ab.person_id;
      if (stored) this.stats.cards_changed++;
      else this.stats.cards_new++;
    } else {
      const target = this.cardTarget(card);
      const id = attachExternalIdentity(this.ctx, {
        kind: 'addressbook_id',
        key: card.id,
        raw: card.id,
        displayName: card.fields.displayName,
        personId: target ?? undefined,
        at: this.ctx.now,
      });
      if (!id) {
        this.stats.cards_skipped++;
        return;
      }
      ab = findIdent(db, abKey)!;
      personId = personOfIdentity(db, id)!;
      if (target && canonicalId(db, personId) === canonicalId(db, target)) this.stats.cards_linked++;
      else this.stats.people_created++;
      this.stats.cards_new++;
    }
    for (const k of card.keys) this.attachKey(personId, card, k);
    this.upsertCard(card, ab.id);
    this.affected.add(canonicalId(db, personId));
  }

  /** The person's primary card (latest modified, then fullest, then id) drives its display fields. */
  applyFields(personId: string): void {
    const db = this.db;
    const id = canonicalId(db, personId);
    const p = getPerson(db, id);
    if (!p || p.kind !== 'person' || p.status === 'suppressed' || p.status === 'service' || p.status === 'merged') return;
    const rows = db
      .prepare(
        `SELECT c.card_id, c.fields, c.modified_at FROM addressbook_cards c JOIN identities i ON i.id = c.identity_id
         WHERE c.removed_at IS NULL AND i.status = 'active' AND i.person_id IN (SELECT value FROM json_each(?))`,
      )
      .all(inSet(canonicalMembers(db, id))) as { card_id: string; fields: string; modified_at: number | null }[];
    if (!rows.length) return;
    const filled = (f: CardFields) => Object.values(f).filter((v) => v !== null).length;
    const cards = rows.map((r) => ({ ...r, f: JSON.parse(r.fields) as CardFields }));
    cards.sort(
      (a, b) =>
        (b.modified_at ?? -Infinity) - (a.modified_at ?? -Infinity) || filled(b.f) - filled(a.f) || (a.card_id < b.card_id ? -1 : 1),
    );
    const f = cards[0]!.f;
    const locked = new Set(JSON.parse(p.locked_fields || '[]') as string[]);
    const patch: Record<string, unknown> = {};
    const set = (col: keyof PersonRow, v: string | null) => {
      if (v && !locked.has(col) && p[col] !== v) patch[col] = v;
    };
    set('display_name', f.displayName);
    set('first_name', f.given);
    set('last_name', f.family);
    set('nickname', f.nickname);
    set('company', f.org);
    set('job_title', f.job);
    set('birthday', f.birthday);
    // A Contacts card is the user's own record: the person is a real contact now.
    if (p.status === 'provisional' || p.status === 'roster_only') patch.status = 'active';
    if (!Object.keys(patch).length) return;
    const next = patch.display_name as string | undefined;
    this.batch(next ? `Named ${p.display_name} “${next}” from Contacts` : `Updated ${p.display_name} from Contacts`, id, (t) =>
      t.update('people', { id }, patch),
    );
    this.stats.people_updated++;
  }

  /** Cards gone from the dump: removed_at plus a journaled detach of their addressbook_id identity. */
  removeCards(gone: StoredCard[]): void {
    for (const g of gone) {
      tx(this.db, () => {
        this.db.prepare('UPDATE addressbook_cards SET removed_at = ? WHERE card_id = ?').run(this.ctx.now, g.card_id);
        const ident = g.identity_id
          ? (this.db.prepare('SELECT id, person_id, status FROM identities WHERE id = ?').get(g.identity_id) as
              | { id: string; person_id: string; status: string }
              | undefined)
          : undefined;
        if (ident?.status === 'active') {
          this.batch('Contacts card removed', canonicalId(this.db, ident.person_id), (t) =>
            t.update('identities', { id: ident.id }, { status: 'detached' }),
          );
        }
        this.stats.cards_removed++;
      });
    }
  }
}

export interface ApplyOptions {
  now?: number;
  jobRunId?: number | null;
  /** Re-apply every card even when the dump hash is unchanged. */
  force?: boolean;
}

/** Applies one collector dump. Every agent write is a journaled batch of one 'ingest' run. */
export function applyContacts(db: DB, resp: ContactsResponse, o: ApplyOptions = {}): AddressBookStats {
  const now = o.now ?? Date.now();
  const byId = new Map<string, ParsedCard>();
  for (const item of resp.items) if (!byId.has(item.id)) byId.set(item.id, parseCard(item));
  const cards = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  const health = (stats: AddressBookStats) =>
    recordSourceHealth(db, SOURCE, now, 'ok', {
      newestDataAt: resp.generated_at ?? now,
      details: { cards: cards.length, shared: stats.shared_marked, removals_held: stats.removals_held },
    });

  const prev = readCursor(db, SOURCE, DUMP_SCOPE);
  if (!o.force && prev?.cursor === resp.hash) {
    const stats = emptyStats();
    stats.cards = cards.length;
    stats.dump_unchanged = 1;
    tx(db, () => {
      db.prepare('UPDATE addressbook_cards SET last_seen_at = ? WHERE removed_at IS NULL').run(now);
      writeCursor(db, SOURCE, DUMP_SCOPE, resp.hash, now);
    });
    health(stats);
    return stats;
  }

  const keyCards = keyIndex(cards);
  const shared = sharedKeys(keyCards);
  const stored = new Map(
    (db.prepare('SELECT card_id, identity_id, content_hash, removed_at FROM addressbook_cards').all() as StoredCard[]).map((s) => [s.card_id, s]),
  );
  const run = sourceRun(db, SOURCE, { now, jobRunId: o.jobRunId ?? null });
  const pass = new CardPass(run.ctx, keyCards, shared);
  const stats = pass.stats;
  stats.cards = cards.length;
  try {
    tx(db, () => pass.markExistingShared());
    const abStatus = (card: ParsedCard) => {
      const k = normalizeExternalKey('addressbook_id', card.id);
      return k ? findIdent(db, k)?.status : undefined;
    };
    for (const card of cards) {
      const st = stored.get(card.id);
      if (st && st.content_hash === card.hash && st.removed_at === null && abStatus(card) === 'active') {
        stats.cards_unchanged++;
        continue;
      }
      tx(db, () => pass.applyCard(card, st));
    }

    const live = [...stored.values()].filter((s) => s.removed_at === null);
    const gone = live.filter((s) => !byId.has(s.card_id));
    const truncated = gone.length > 0 && (cards.length === 0 || (gone.length > MASS_REMOVAL_MIN && gone.length > live.length * MASS_REMOVAL_SHARE));
    if (truncated) stats.removals_held = gone.length;
    else pass.removeCards(gone);

    for (const id of pass.affected) tx(db, () => pass.applyFields(id));
    tx(db, () => {
      db.prepare(
        `UPDATE addressbook_cards SET last_seen_at = ? WHERE removed_at IS NULL AND card_id IN (SELECT value FROM json_each(?))`,
      ).run(now, inSet(cards.map((c) => c.id)));
      writeCursor(db, SOURCE, DUMP_SCOPE, resp.hash, now, { meta: { cards: cards.length } });
    });
    run.finish('ok', { cards: cards.length });
  } catch (e) {
    run.finish('error');
    throw e;
  }
  health(stats);
  return stats;
}

/** One pass: fetch the dump from the collector and apply it. */
export async function ingestAddressBook(db: DB, source: ContactsSource, o: ApplyOptions = {}): Promise<AddressBookStats> {
  const resp = await source.contacts();
  return applyContacts(db, resp, o);
}
