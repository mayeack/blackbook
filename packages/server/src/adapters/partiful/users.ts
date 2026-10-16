/**
 * Partiful profiles (getUsers) and Partiful's own tie counters (getContacts / getMutuals).
 * A profile adds a name observation (alias_obs, Partiful precedence) and, when socials.instagram is set, the
 * deterministic Partiful↔Instagram link of intelligence §1.2: the handle normalizes to an instagram_username
 * identity; if that identity already belongs to a person with a compatible first name (score ≥0.5), the
 * Partiful person is linked to it (a journaled pointer merge, undoable, guarded by G2/G4/G7 and do_not_merge);
 * if nobody has the handle yet it becomes an identity on the Partiful person, so Beeper later lands on the same
 * person. Incompatible names are left to the probabilistic matcher (+8 bits there).
 */
import { firstNameScore } from '@yb/shared';
import { canonicalId, canonicalMembers } from '../../db/canon';
import type { DB } from '../../db/connection';
import { tx } from '../../db/tx';
import { attachExternalIdentity, externalMaskedHandle, linkIdentityToPerson, normalizeExternalKey, personOfIdentity } from '../../identity/external';
import type { ParsedContact, ParsedUser } from './schemas';
import { markProfile, notePartifulUser, type IgLink, type RunScope } from './scope';

export type { IgLink } from './scope';

const PLACEHOLDERS = new Set(['(unknown)', 'Instagram user', 'WhatsApp user', 'Partiful guest', 'Beeper user', 'Contacts card', 'Me']);

/** First-name tokens a person is known by (their name fields and every name observed on their identities). */
function knownFirstNames(db: DB, canonical: string): string[] {
  const members = JSON.stringify(canonicalMembers(db, canonical));
  const people = db
    .prepare(`SELECT first_name, display_name FROM people WHERE id IN (SELECT value FROM json_each(?))`)
    .all(members) as { first_name: string | null; display_name: string }[];
  const aliases = db
    .prepare(
      `SELECT a.name_raw FROM alias_obs a JOIN identities i ON i.id = a.identity_id
       WHERE i.status = 'active' AND i.person_id IN (SELECT value FROM json_each(?))`,
    )
    .pluck()
    .all(members) as string[];
  const out = new Set<string>();
  const add = (name: string | null) => {
    const n = name?.trim();
    if (!n || PLACEHOLDERS.has(n) || /^[@(+]|•/.test(n)) return;
    const first = n.split(/\s+/)[0];
    if (first) out.add(first);
  };
  for (const p of people) {
    add(p.first_name);
    add(p.display_name);
  }
  for (const a of aliases) add(a);
  return [...out];
}

export function firstNameCompatibility(db: DB, canonical: string, name: string | null): number {
  const first = name?.trim().split(/\s+/)[0];
  if (!first) return 0;
  return Math.max(0, ...knownFirstNames(db, canonical).map((n) => firstNameScore(first, n)));
}

/** §1.2 Partiful IG link for one profile. */
export function linkInstagram(s: RunScope, partifulIdentityId: string, u: ParsedUser): IgLink {
  const { db, ctx } = s;
  const k = u.instagram ? normalizeExternalKey('instagram_username', u.instagram) : null;
  if (!k) return 'invalid';
  const mine = personOfIdentity(db, partifulIdentityId);
  if (!mine) return 'held';
  const owner = db.prepare(`SELECT id, person_id, status, shared FROM identities WHERE kind = 'instagram_username' AND key = ?`).get(k.key) as
    | { id: string; person_id: string; status: string; shared: number }
    | undefined;
  if (!owner) {
    const id = attachExternalIdentity(ctx, { kind: 'instagram_username', key: k.key, personId: mine, displayName: null, source: 'partiful' });
    return id && canonicalId(db, personOfIdentity(db, id) ?? mine) === canonicalId(db, mine) ? 'attached' : 'held';
  }
  if (owner.status !== 'active' || owner.shared) return 'held';
  const target = canonicalId(db, owner.person_id);
  if (target === canonicalId(db, mine)) return 'same';
  const kind = db.prepare('SELECT kind FROM people WHERE id = ?').pluck().get(target) as string | undefined;
  if (kind !== 'person') return 'held'; // never fold a stranger into me on a handle alone
  if (firstNameCompatibility(db, target, u.name) < 0.5) return 'incompatible';
  const r = linkIdentityToPerson(ctx, partifulIdentityId, target, {
    method: 'deterministic',
    evidence: { rule: 'partiful_instagram', identity_kind: 'partiful_user' },
    title: `Linked ${u.name ?? externalMaskedHandle({ kind: 'partiful_user', key: u.id })} (Partiful) by Instagram handle`,
  });
  return r.outcome === 'linked' ? 'linked' : r.outcome === 'unchanged' ? 'same' : 'held';
}

export interface ProfileStats {
  users: number;
  ig_handles: number;
  ig_linked: number;
  ig_attached: number;
  ig_incompatible: number;
}

/**
 * Applies one getUsers answer. Returned profiles are marked fetched. Requested ids missing from the answer are
 * marked fetched only when the answer is empty (unknown or private users); a partial answer is a per-call cap
 * (live 2026-10-16: only the first id came back), so the rest stay pending for the next call.
 */
export function applyProfiles(s: RunScope, requested: readonly string[], users: readonly ParsedUser[]): ProfileStats {
  const { db, now } = s;
  const stats: ProfileStats = { users: 0, ig_handles: 0, ig_linked: 0, ig_attached: 0, ig_incompatible: 0 };
  return tx(db, () => {
    const asked = new Set(requested);
    const seen = new Set<string>();
    for (const u of users) {
      // Only profiles we asked for (never a stranger the API volunteers), never mine.
      if (u.id === s.uid || seen.has(u.id) || !asked.has(u.id)) continue;
      seen.add(u.id);
      const identityId = attachExternalIdentity(s.ctx, { kind: 'partiful_user', key: u.id, displayName: u.name, at: now });
      if (!identityId) {
        markProfile(db, u.id, now, { hasInstagram: false, link: null });
        continue;
      }
      notePartifulUser(db, u.id, identityId, now);
      stats.users++;
      let link: IgLink | null = null;
      if (u.instagram) {
        stats.ig_handles++;
        link = linkInstagram(s, identityId, u);
        if (link === 'linked') stats.ig_linked++;
        else if (link === 'attached') stats.ig_attached++;
        else if (link === 'incompatible') stats.ig_incompatible++;
      }
      markProfile(db, u.id, now, { hasInstagram: !!u.instagram, link });
    }
    if (seen.size === 0) {
      const markMissing = db.prepare('UPDATE partiful_users SET profile_fetched_at = ?, updated_at = ? WHERE user_id = ?');
      for (const id of requested) markMissing.run(now, now, id);
    }
    return stats;
  });
}

/**
 * Ids whose profile was never read (or is older than `staleMs`): people in my network (active / provisional)
 * first, then never-read before stale, oldest sightings first.
 */
export function pendingProfiles(db: DB, uid: string, now: number, limit: number, staleMs = 90 * 86_400_000): string[] {
  return db
    .prepare(
      `SELECT u.user_id FROM partiful_users u
       LEFT JOIN identities i ON i.id = u.identity_id
       LEFT JOIN person_canon c ON c.person_id = i.person_id
       LEFT JOIN people p ON p.id = coalesce(c.canonical_id, i.person_id)
       WHERE u.user_id <> ? AND (u.profile_fetched_at IS NULL OR u.profile_fetched_at < ?)
       ORDER BY coalesce(p.status IN ('active','provisional'), 0) DESC, u.profile_fetched_at IS NOT NULL, u.profile_fetched_at, u.first_seen_at
       LIMIT ?`,
    )
    .pluck()
    .all(uid, now - staleMs, limit) as string[];
}

export const countPendingProfiles = (db: DB, uid: string, now: number, staleMs = 90 * 86_400_000): number =>
  db
    .prepare('SELECT count(*) FROM partiful_users WHERE user_id <> ? AND (profile_fetched_at IS NULL OR profile_fetched_at < ?)')
    .pluck()
    .get(uid, now - staleMs) as number;

export interface ContactStats {
  contacts: number;
  with_counts: number;
  /** Single-shared-event strangers, not added. */
  skipped: number;
}

/** getContacts / getMutuals page → identities + partiful_users counters (max of both lists within one pass). */
export function applyContacts(s: RunScope, list: 'contacts' | 'mutuals', contacts: readonly ParsedContact[]): ContactStats {
  const { db, now } = s;
  const stats: ContactStats = { contacts: 0, with_counts: 0, skipped: 0 };
  return tx(db, () => {
    const save = db.prepare(
      `UPDATE partiful_users SET
         shared_event_count = CASE WHEN @count IS NULL THEN shared_event_count
           WHEN counts_updated_at = @now THEN max(coalesce(shared_event_count, 0), @count) ELSE @count END,
         is_contact = max(is_contact, @contact), is_mutual = max(is_mutual, @mutual),
         is_past_guest = coalesce(@past, is_past_guest),
         last_shared_event_id = CASE WHEN @eventAt IS NOT NULL AND @eventAt >= coalesce(last_shared_event_at, 0) THEN @eventId
           ELSE coalesce(last_shared_event_id, @eventId) END,
         last_shared_event_at = CASE WHEN @eventAt IS NOT NULL THEN max(coalesce(last_shared_event_at, 0), @eventAt) ELSE last_shared_event_at END,
         counts_updated_at = CASE WHEN @count IS NULL THEN counts_updated_at ELSE @now END, updated_at = @now
       WHERE user_id = @user`,
    );
    const known = db.prepare(`SELECT 1 FROM identities WHERE kind = 'partiful_user' AND key = ?`);
    for (const c of contacts) {
      if (c.userId === s.uid) continue;
      // Mutuals include everyone from big public events: one shared event adds counters to people already known
      // but never creates a person. 3+ shared events is a relationship on its own.
      if ((c.sharedEventCount ?? 0) < 2 && known.get(c.userId) === undefined) {
        stats.skipped++;
        continue;
      }
      const identityId = attachExternalIdentity(s.ctx, {
        kind: 'partiful_user',
        key: c.userId,
        displayName: c.name,
        at: now,
        signals: { qualifies: (c.sharedEventCount ?? 0) >= 3 },
      });
      if (!identityId) continue;
      notePartifulUser(db, c.userId, identityId, now);
      stats.contacts++;
      if (c.sharedEventCount !== null) stats.with_counts++;
      save.run({
        count: c.sharedEventCount,
        now,
        contact: list === 'contacts' ? 1 : 0,
        mutual: list === 'mutuals' ? 1 : 0,
        past: c.isPastGuest === null ? null : c.isPastGuest ? 1 : 0,
        eventId: c.sharedEventId,
        eventAt: c.sharedEventAt,
        user: c.userId,
      });
    }
    return stats;
  });
}
