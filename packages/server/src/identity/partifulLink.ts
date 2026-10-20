/**
 * Partiful guests ↔ contacts: the "two records for one person" gap. A Partiful guest arrives as its own person (a
 * partiful_user identity, usually roster-only). When only the name connects it to a contact, the probabilistic
 * matcher keeps them apart on purpose (a name alone never merges, G1), so the invite suggestions, briefs and person
 * pages see two people. This pass (run by the nightly matcher before scoring) links the two when the name is
 * unambiguous in the owner's whole book AND both records are people in his life:
 *   - the guest record holds only partiful_user identities, was made by the agent (provisional / roster-only, not
 *     hidden, priority, legacy or user-made, no merged members) and is on the list of a Partiful event the owner
 *     hosted or went to;
 *   - exactly one other person in the book has the same first + last name (normalized; two words or more, both
 *     ≥ 2 letters, no initials) and no other Partiful-only record shares it: one candidate each way;
 *   - that person is a real contact: visible, with a Contacts card, a 1:1 conversation or a logged interaction;
 *   - the matcher's guards pass (G2: two names on one guest list are two people; G3 do_not_merge; G4 distinct
 *     cards; G5; G7), the owner never dismissed the pair, and the nightly merge cap (G6) has room.
 * Each link is a journaled pointer merge into the contact (method 'probabilistic', evidence rule
 * 'partiful_unique_name'), so undo splits them and writes do_not_merge, which G3 respects on every later night. Ids
 * and counts only in evidence.
 */
import { normalizeNamePart } from '@yb/shared';
import { canonicalId, canonicalMembers } from '../db/canon';
import type { DB } from '../db/connection';
import { tx } from '../db/tx';
import { guardFailures } from './matcherGuards';
import { mergePeople, MergeRefusedError } from './merge';
import type { ResolveContext } from './resolver';

export const PARTIFUL_LINK_RULE = 'partiful_unique_name';
/** Recorded on the merge: a unique full name plus both sides in the owner's life, not a calibrated p. */
export const PARTIFUL_LINK_CONFIDENCE = 0.9;

export interface PartifulLinkStats {
  /** Partiful-only guest records looked at. */
  considered: number;
  linked: number;
  /** Same name, but another person (or another Partiful record) has it too. */
  ambiguous: number;
  /** One match, but not a real contact (no card, no 1:1 history). */
  not_acquainted: number;
  blocked: number;
  /** Left for a later night by the merge cap. */
  held: number;
}

interface Row {
  id: string;
  display_name: string;
  first_name: string | null;
  last_name: string | null;
}

/** "first last" (normalized) when the name is a full one, else null: two words or more, both ≥ 2 letters, no initials. */
export function fullNameKey(r: Pick<Row, 'display_name' | 'first_name' | 'last_name'>): string | null {
  const words = (s: string | null) => (s ?? '').split(/\s+/).map((w) => w.trim()).filter(Boolean);
  let first: string | undefined;
  let last: string | undefined;
  if (r.first_name?.trim() && r.last_name?.trim()) {
    first = words(r.first_name)[0];
    last = words(r.last_name).at(-1);
  } else {
    const w = words(r.display_name);
    if (w.length < 2) return null;
    first = w[0];
    last = w.at(-1);
  }
  if (!first || !last || /\.$/.test(first) || /\.$/.test(last)) return null;
  const f = normalizeNamePart(first).replace(/[^\p{L}'-]+/gu, '');
  const l = normalizeNamePart(last).replace(/[^\p{L}'-]+/gu, '');
  if ([...f].length < 2 || [...l].length < 2) return null;
  return `${f} ${l}`;
}

const inSet = (ids: readonly string[]) => JSON.stringify([...ids]);

/** Guest records only Partiful knows, from events the owner hosted or went to. */
function partifulOnly(db: DB): Row[] {
  return db
    .prepare(
      `SELECT p.id, p.display_name, p.first_name, p.last_name FROM people p
       WHERE p.kind = 'person' AND p.merged_into_id IS NULL AND p.status IN ('provisional','roster_only')
         AND p.is_hidden = 0 AND p.is_priority = 0 AND p.origin NOT IN ('legacy','user')
         AND NOT EXISTS (SELECT 1 FROM people m WHERE m.merged_into_id = p.id)
         AND EXISTS (SELECT 1 FROM identities i WHERE i.person_id = p.id AND i.status = 'active' AND i.kind = 'partiful_user')
         AND NOT EXISTS (SELECT 1 FROM identities i WHERE i.person_id = p.id AND i.status = 'active' AND i.kind <> 'partiful_user')
         AND EXISTS (
           SELECT 1 FROM event_attendees a JOIN events e ON e.id = a.event_id
           WHERE a.person_id = p.id AND (lower(coalesce(e.my_role, '')) IN ('host','co_host','cohost')
             OR lower(coalesce(e.my_rsvp, '')) IN ('going','approved','checked_in','attended')))
       ORDER BY p.id`,
    )
    .all() as Row[];
}

/** A visible contact with real history: a Contacts card, a logged or derived 1:1 interaction, or a direct conversation. */
function acquainted(db: DB, personId: string): boolean {
  if (!db.prepare('SELECT 1 FROM person_visible WHERE id = ?').get(personId)) return false;
  const members = inSet(canonicalMembers(db, personId));
  return !!db
    .prepare(
      `SELECT 1 WHERE EXISTS (SELECT 1 FROM identities WHERE kind = 'addressbook_id' AND status = 'active' AND person_id IN (SELECT value FROM json_each(@m)))
         OR EXISTS (SELECT 1 FROM interactions WHERE person_id IN (SELECT value FROM json_each(@m)) AND retracted_at IS NULL
                    AND kind IN ('dm_session','call','manual','text_log','legacy_text'))
         OR EXISTS (SELECT 1 FROM identities i JOIN conversation_members cm ON cm.identity_id = i.id
                    JOIN conversations c ON c.id = cm.conversation_id AND c.kind = 'direct'
                    WHERE i.person_id IN (SELECT value FROM json_each(@m)))`,
    )
    .get({ m: members });
}

/**
 * Links Partiful-only guest records to the one contact that shares their full name (see the header). `budget` is
 * the merges left under the nightly cap; the caller counts these merges against it (they are 'probabilistic').
 */
export function linkPartifulGuests(ctx: ResolveContext, o: { budget: number; signal?: AbortSignal }): PartifulLinkStats {
  const { db, now } = ctx;
  const stats: PartifulLinkStats = { considered: 0, linked: 0, ambiguous: 0, not_acquainted: 0, blocked: 0, held: 0 };
  const guests = partifulOnly(db);
  if (!guests.length) return stats;
  const guestIds = new Set(guests.map((g) => g.id));

  // Every full name in the book (canonical roots of real people), to know when a name is unambiguous.
  const byName = new Map<string, string[]>();
  const all = db
    .prepare(
      `SELECT id, display_name, first_name, last_name FROM people
       WHERE kind = 'person' AND merged_into_id IS NULL AND status IN ('active','provisional','roster_only')`,
    )
    .all() as Row[];
  for (const r of all) {
    const k = fullNameKey(r);
    if (k) byName.set(k, [...(byName.get(k) ?? []), r.id]);
  }
  const dismissed = new Set(db.prepare(`SELECT a_id || '|' || b_id FROM match_candidates WHERE status = 'dismissed'`).pluck().all() as string[]);
  let budget = Math.max(0, o.budget);

  for (const g of guests) {
    if (o.signal?.aborted) break;
    const key = fullNameKey(g);
    if (!key) continue;
    stats.considered++;
    const others = (byName.get(key) ?? []).filter((id) => id !== g.id);
    const contacts = others.filter((id) => !guestIds.has(id));
    if (contacts.length !== 1 || others.length !== 1) {
      if (others.length) stats.ambiguous++;
      continue;
    }
    const contact = canonicalId(db, contacts[0]!);
    const guest = canonicalId(db, g.id);
    if (guest === contact) continue;
    if (!acquainted(db, contact)) {
      stats.not_acquainted++;
      continue;
    }
    const [a, b] = guest < contact ? [guest, contact] : [contact, guest];
    if (dismissed.has(`${a}|${b}`) || guardFailures(db, guest, contact).length) {
      stats.blocked++;
      continue;
    }
    if (budget <= 0) {
      stats.held++;
      continue;
    }
    // The contact (the owner's record) always survives; the guest record is a weak auto-made one.
    const survivorId = contact;
    const mergedId = guest;
    const names = db.prepare('SELECT id, display_name FROM people WHERE id IN (?, ?)').all(survivorId, mergedId) as { id: string; display_name: string }[];
    const nameOf = (id: string) => names.find((n) => n.id === id)?.display_name ?? '(unknown)';
    const events = db
      .prepare(`SELECT count(DISTINCT a.event_id) FROM event_attendees a WHERE a.person_id = ? AND a.event_id IS NOT NULL`)
      .pluck()
      .get(guest) as number;
    try {
      tx(db, () =>
        mergePeople(db, {
          survivorId,
          mergedId,
          method: 'probabilistic',
          runId: ctx.runId(),
          actor: 'agent',
          score: PARTIFUL_LINK_CONFIDENCE,
          confidence: PARTIFUL_LINK_CONFIDENCE,
          evidence: { rule: PARTIFUL_LINK_RULE, families: ['name', 'partiful'], counts: { partiful_events: events } },
          title: `Merged ${nameOf(mergedId)} into ${nameOf(survivorId)} (same full name, Partiful guest of yours)`,
          now,
        }),
      );
      stats.linked++;
      budget--;
    } catch (e) {
      if (!(e instanceof MergeRefusedError)) throw e;
      stats.blocked++;
    }
  }
  return stats;
}
