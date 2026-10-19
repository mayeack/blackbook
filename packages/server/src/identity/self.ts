/**
 * The owner's own records. My handles are settings.self_handles (npm run setup:self) plus the phones and emails
 * already on me (my Contacts card, my legacy record, records I merged into me); emails compare by emailMatchKey,
 * so a Gmail alias of mine (dots, +tag) is mine too. An identity the owner unlinked from me (an identity_blocks
 * row for me) or one marked shared never counts.
 *
 *   selfRefs     my handles in matching form (cheap: settings + my own identities), for routing a new key to me;
 *   loadSelf     adds every person that is me, was merged into me, or still holds one of my handles (`people`), and
 *                those stray handles themselves (`strays`, which the matcher's self-link pass moves to me).
 * Suggestion generators, tie stats, circles and intel skip `people`: nobody is ever suggested to the owner as
 * someone else. Nothing here logs or returns handles beyond this process.
 */
import { emailMatchKey } from '@yb/shared';
import { canonicalId, canonicalMembers } from '../db/canon';
import type { DB } from '../db/connection';
import { readSetting } from '../settings/registry';
import { handleKey } from './resolver';

/** The owner's person id (kind 'me'), or null before the first ingest created it. */
export function ownerPersonId(db: DB): string | null {
  return (
    (db.prepare(`SELECT id FROM people WHERE kind = 'me' AND status IN ('active','provisional') ORDER BY created_at LIMIT 1`).pluck().get() as
      | string
      | undefined) ?? null
  );
}

/** The matching form of a phone or email key ('phone:+1…', 'email:<match key>'); null for other kinds and raw phones. */
export function selfMatchRef(kind: string, key: string): string | null {
  if (kind === 'phone') return key.startsWith('+') ? `phone:${key}` : null;
  if (kind === 'email') {
    const k = emailMatchKey(key);
    return k ? `email:${k}` : null;
  }
  return null;
}

export interface SelfRefs {
  meId: string | null;
  /** me and every person merged into me. */
  members: readonly string[];
  refs: ReadonlySet<string>;
  /** 'kind:key' of identities the owner unlinked from me. */
  blocked: ReadonlySet<string>;
  /** A phone/email key of mine (exact key, or an alias by emailMatchKey) that the owner never unlinked from me. */
  isMine(kind: string, key: string): boolean;
}

export function selfRefs(db: DB): SelfRefs {
  const meId = ownerPersonId(db);
  const members = meId ? canonicalMembers(db, meId) : [];
  const json = JSON.stringify(members);
  const refs = new Set<string>();
  for (const h of readSetting(db, 'self_handles')) {
    const k = handleKey(h);
    const r = k && k.confidence === 1 ? selfMatchRef(k.kind, k.key) : null;
    if (r) refs.add(r);
  }
  const own = db
    .prepare(`SELECT kind, key FROM identities WHERE status = 'active' AND kind IN ('phone','email') AND person_id IN (SELECT value FROM json_each(?))`)
    .all(json) as { kind: string; key: string }[];
  for (const i of own) {
    const r = selfMatchRef(i.kind, i.key);
    if (r) refs.add(r);
  }
  const blocked = new Set(
    db.prepare(`SELECT kind || ':' || key FROM identity_blocks WHERE person_id IN (SELECT value FROM json_each(?))`).pluck().all(json) as string[],
  );
  return {
    meId,
    members,
    refs,
    blocked,
    isMine(kind, key) {
      if (!meId || blocked.has(`${kind}:${key}`)) return false;
      const r = selfMatchRef(kind, key);
      return r !== null && refs.has(r);
    },
  };
}

/** One of my handles on someone other than me. */
export interface StrayHandle {
  identityId: string;
  personId: string;
  kind: 'phone' | 'email';
  key: string;
}

export interface SelfView extends SelfRefs {
  /** Every person id (roots and merged members) that is me or holds one of my handles. */
  people: ReadonlySet<string>;
  strays: readonly StrayHandle[];
}

export function loadSelf(db: DB): SelfView {
  const base = selfRefs(db);
  const people = new Set<string>(base.members);
  const strays: StrayHandle[] = [];
  if (!base.meId || !base.refs.size) return { ...base, people, strays };
  const mine = new Set(base.members);
  const rows = db
    .prepare(
      `SELECT i.id, i.person_id, i.kind, i.key FROM identities i JOIN people p ON p.id = i.person_id
       WHERE i.status = 'active' AND i.shared = 0 AND i.kind IN ('phone','email') AND p.kind = 'person' AND p.status <> 'suppressed'
       ORDER BY i.id`,
    )
    .all() as { id: string; person_id: string; kind: 'phone' | 'email'; key: string }[];
  for (const r of rows) {
    if (mine.has(r.person_id) || !base.isMine(r.kind, r.key)) continue;
    strays.push({ identityId: r.id, personId: r.person_id, kind: r.kind, key: r.key });
    if (people.has(r.person_id)) continue;
    for (const m of canonicalMembers(db, canonicalId(db, r.person_id))) people.add(m);
  }
  return { ...base, people, strays };
}

/** Person ids that are me or hold one of my handles (see loadSelf). */
export const selfPeople = (db: DB): ReadonlySet<string> => loadSelf(db).people;
