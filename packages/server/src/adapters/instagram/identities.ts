/**
 * Identity steps shared by the Beeper (Instagram) ingest and the DYI importer.
 */
import { attachExternalIdentity, type ExternalKind } from '../../identity/external';
import type { ResolveContext } from '../../identity/resolver';

/**
 * §1.4 re-check once a page's messages are in: identities are created before their messages are written, so a
 * new person starts roster_only; re-attaching it lets identity/external.ts judge it on the stored counters and
 * promote it to provisional. (No history-based service filing here: Instagram friends who only send reels are
 * still people.) Returns how many were promoted.
 */
export function promoteQualified(ctx: ResolveContext, identityIds: Iterable<string>): number {
  const ids = JSON.stringify([...new Set(identityIds)]);
  const pending = ctx.db.prepare(
    `SELECT i.id, i.kind, i.key, i.last_seen_at FROM identities i JOIN people p ON p.id = i.person_id
     WHERE i.id IN (SELECT value FROM json_each(?)) AND i.status = 'active' AND p.kind = 'person' AND p.status = 'roster_only'`,
  );
  const statusOf = ctx.db.prepare('SELECT p.status FROM identities i JOIN people p ON p.id = i.person_id WHERE i.id = ?').pluck();
  let promoted = 0;
  // One promotion can qualify another (a group post counts once the group has a known person): run to a fixpoint.
  for (let round = 0; round < 4; round++) {
    const rows = pending.all(ids) as { id: string; kind: ExternalKind; key: string; last_seen_at: number | null }[];
    let n = 0;
    for (const r of rows) {
      // `at` = what is stored, so the re-attach doesn't move last_seen_at.
      attachExternalIdentity(ctx, { kind: r.kind, key: r.key, at: r.last_seen_at });
      if (statusOf.get(r.id) === 'provisional') n++;
    }
    promoted += n;
    if (!n) break;
  }
  return promoted;
}
