/**
 * Guards against false probabilistic merges (intelligence §1.6), checked on the current canonical sets so merges
 * earlier in the same night are taken into account. G1 (name-only never merges) is a decision rule in matcher.ts;
 * G6 (nightly cap) is enforced there too.
 *   G2  co-presence: two distinct identities of one kind both active in one conversation, or both people on one
 *       event (distinct identities of one kind, or both rows from an explicit guest list; rows the agent inferred
 *       from messages or calendar text never count, nor do rejected, possible or withdrawn ones). Deterministic
 *       links (identity/external.ts) use this same definition;
 *   G3  do_not_merge between the two sets (transitive through earlier merges);
 *   G4  both sides backed by Contacts cards, and different ones;
 *   G5  cluster sanity: every pair of names in the merged cluster compatible; ≤4 phones, ≤4 emails, ≤2 IG ids;
 *   G7  both sides priority/hidden (one of them would be absorbed).
 */
import { canonicalId, canonicalMembers } from '../db/canon';
import type { DB } from '../db/connection';
import { namesCompatible, personName, type NamedRow } from './matcherNames';
import { doNotMergeApplies } from './merge';

export type GuardId = 'G2' | 'G3' | 'G4' | 'G5' | 'G7';

export const CLUSTER_LIMITS: Readonly<Record<string, number>> = { phone: 4, email: 4, instagram_id: 2 };

const inSet = (ids: readonly string[]) => JSON.stringify(ids);

/** G2 on two sets of permanent person ids. */
export function coPresentSets(db: DB, a: readonly string[], b: readonly string[]): boolean {
  const p = { a: inSet(a), b: inSet(b) };
  const conv = db
    .prepare(
      `SELECT 1 FROM conversation_members ma
       JOIN identities ia ON ia.id = ma.identity_id
       JOIN conversation_members mb ON mb.conversation_id = ma.conversation_id AND mb.identity_id <> ma.identity_id AND mb.is_active = 1
       JOIN identities ib ON ib.id = mb.identity_id AND ib.kind = ia.kind
       WHERE ma.is_active = 1 AND ia.person_id IN (SELECT value FROM json_each(@a)) AND ib.person_id IN (SELECT value FROM json_each(@b))
       LIMIT 1`,
    )
    .get(p);
  if (conv) return true;
  const event = db
    .prepare(
      `WITH att AS (
         SELECT a.id, a.person_id, a.identity_id, a.source, i.kind,
                coalesce('event:' || coalesce(a.event_id, o.event_id), 'occ:' || a.occasion_id) AS ek
         FROM event_attendees a LEFT JOIN occasions o ON o.id = a.occasion_id LEFT JOIN identities i ON i.id = a.identity_id
         WHERE a.status NOT IN ('rejected','possible','withdrawn')
           AND (a.person_id IN (SELECT value FROM json_each(@a)) OR a.person_id IN (SELECT value FROM json_each(@b))))
       SELECT 1 FROM att x JOIN att y ON y.ek = x.ek AND y.id <> x.id
       WHERE x.person_id IN (SELECT value FROM json_each(@a)) AND y.person_id IN (SELECT value FROM json_each(@b))
         AND ((x.kind IS NOT NULL AND x.kind = y.kind AND x.identity_id <> y.identity_id)
           OR (x.source IN ('partiful','user','legacy') AND y.source IN ('partiful','user','legacy')))
       LIMIT 1`,
    )
    .get(p);
  return event !== undefined;
}

/** G4: both sides carry active Contacts cards and share none. */
export function distinctCardSets(db: DB, a: readonly string[], b: readonly string[]): boolean {
  const cards = (ids: readonly string[]) =>
    new Set(
      db
        .prepare(`SELECT key FROM identities WHERE kind = 'addressbook_id' AND status = 'active' AND person_id IN (SELECT value FROM json_each(?))`)
        .pluck()
        .all(inSet(ids)) as string[],
    );
  const ca = cards(a);
  const cb = cards(b);
  return ca.size > 0 && cb.size > 0 && ![...ca].some((c) => cb.has(c));
}

/** G5 on the union of two sets. */
export function clusterSane(db: DB, ids: readonly string[]): boolean {
  const rows = db
    .prepare('SELECT display_name, first_name, last_name FROM people WHERE id IN (SELECT value FROM json_each(?))')
    .all(inSet(ids)) as NamedRow[];
  const names = rows.map(personName).filter((n) => n !== null);
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) if (!namesCompatible(names[i]!, names[j]!)) return false;
  const counts = db
    .prepare(
      `SELECT kind, count(*) AS n FROM identities WHERE status = 'active' AND person_id IN (SELECT value FROM json_each(?)) GROUP BY kind`,
    )
    .all(inSet(ids)) as { kind: string; n: number }[];
  return counts.every((c) => c.n <= (CLUSTER_LIMITS[c.kind] ?? Infinity));
}

const isProtected = (db: DB, id: string) =>
  db.prepare('SELECT is_priority OR is_hidden FROM people WHERE id = ?').pluck().get(id) === 1;

/** Guards a probabilistic merge of the two people (any member ids) would fail, in G order. */
export function guardFailures(db: DB, x: string, y: string): GuardId[] {
  const a = canonicalId(db, x);
  const b = canonicalId(db, y);
  const sa = canonicalMembers(db, a);
  const sb = canonicalMembers(db, b);
  const out: GuardId[] = [];
  if (coPresentSets(db, sa, sb)) out.push('G2');
  if (doNotMergeApplies(db, a, b)) out.push('G3');
  if (distinctCardSets(db, sa, sb)) out.push('G4');
  if (!clusterSane(db, [...sa, ...sb])) out.push('G5');
  if (isProtected(db, a) && isProtected(db, b)) out.push('G7');
  return out;
}
