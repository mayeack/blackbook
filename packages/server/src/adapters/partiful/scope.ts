/** What every Partiful write step shares, plus the partiful_users bookkeeping (class S). */
import type { DB } from '../../db/connection';
import type { ResolveContext } from '../../identity/resolver';

export interface RunScope {
  db: DB;
  ctx: ResolveContext;
  now: number;
  /** My Partiful user id. */
  uid: string;
  /** The 'me' person (null before self handles are set up). */
  mePersonId: string | null;
}

/** Records a Partiful user (its profile is fetched later by getUsers, unless a guest record carried it). */
export function notePartifulUser(db: DB, userId: string, identityId: string | null, now: number): void {
  db.prepare(
    `INSERT INTO partiful_users (user_id, identity_id, first_seen_at, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET identity_id = coalesce(excluded.identity_id, partiful_users.identity_id), updated_at = excluded.updated_at
     WHERE excluded.identity_id IS NOT NULL AND partiful_users.identity_id IS NOT excluded.identity_id`,
  ).run(userId, identityId, now, now);
}

export type IgLink = 'linked' | 'attached' | 'same' | 'held' | 'incompatible' | 'invalid';

/** A profile was read (getUsers, or a guest record that embeds the user with its socials). */
export function markProfile(db: DB, userId: string, now: number, o: { hasInstagram: boolean; link: IgLink | null }): void {
  db.prepare(
    `UPDATE partiful_users SET profile_fetched_at = @now, has_instagram = @ig, ig_link = coalesce(@link, ig_link), updated_at = @now
     WHERE user_id = @user`,
  ).run({ now, ig: o.hasInstagram ? 1 : 0, link: o.link, user: userId });
}
