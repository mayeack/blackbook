/**
 * Self-link pass (runs first in the nightly identity matcher): my handles still sitting on another person move to
 * me. An agent-made person (provisional / roster-only) of mine moves to me whole and is retired (linkIdentityToPerson
 * → moveToMe); on an established record (legacy, user-made, a Contacts card) only the handle moves, the way ensureMe
 * moves an exact self handle, because nobody but the owner folds a whole record into me. Every move is a journaled
 * attach_identity batch: undo moves the handle back and blocks it from me, and loadSelf then stops counting it.
 */
import { attachIdentity, maskedHandle, type ResolveContext } from './resolver';
import { linkIdentityToPerson } from './external';
import { loadSelf, type SelfView } from './self';

export interface SelfLinkStats {
  /** Agent-made people of mine moved to me whole. */
  absorbed: number;
  /** Single handles moved off an established record. */
  moved: number;
  held: number;
}

export function linkSelfHandles(ctx: ResolveContext, view: SelfView = loadSelf(ctx.db)): SelfLinkStats {
  const stats: SelfLinkStats = { absorbed: 0, moved: 0, held: 0 };
  const meId = view.meId;
  if (!meId) return stats;
  for (const s of view.strays) {
    const r = linkIdentityToPerson(ctx, s.identityId, meId, { evidence: { via: 'self_handle', identity_kind: s.kind } });
    if (r.outcome === 'linked') {
      stats.absorbed++;
      continue;
    }
    if (r.outcome === 'unchanged') continue; // moved with an earlier stray of the same person
    if (r.reason !== 'me_mismatch') {
      stats.held++;
      continue;
    }
    const k = { kind: s.kind, key: s.key, confidence: 1 };
    const moved = attachIdentity(ctx, k, meId, { title: `Linked ${maskedHandle(k)} to you`, retireEmptied: true });
    if (moved.outcome === 'moved') stats.moved++;
    else stats.held++;
  }
  return stats;
}
