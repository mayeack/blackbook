/**
 * Standing preferences the owner states by text ("prioritize inviting Sam to parties"). Each kind is one reserved
 * USER circle, found by its signature (`pref:<kind>`) rather than its name, so it shows on /circles like any circle
 * and the owner can rename it or remove people (removal is sticky, as for every circle). Writes join the caller's
 * journal batch: undo retracts a circle it created and excludes the members it added. Readers (the suggestions
 * stage, event intel) get canonical member ids.
 */
import { uuidv7 } from '@yb/shared';
import type { DB } from '../../db/connection';
import type { JournalTx } from '../../journal/batch';
import { addMembers } from './collections';
import { circleColor } from './run';

export const PREFERENCE_KINDS = ['party_invites'] as const;
export type PreferenceKind = (typeof PREFERENCE_KINDS)[number];

export const PREFERENCES: Readonly<Record<PreferenceKind, { name: string; description: string; ack: string }>> = {
  party_invites: {
    name: 'Party invites',
    description: 'People to invite to parties and events first (you asked by text).',
    ack: 'prioritized for party invites',
  },
};

export const preferenceSignature = (kind: PreferenceKind): string => `pref:${kind}`;

/** The kind's circle in any status (the newest, should there ever be two). */
function circleOf(db: DB, kind: PreferenceKind): { id: string; status: string } | undefined {
  return db
    .prepare(`SELECT id, status FROM circles WHERE kind = 'user' AND signature = ? ORDER BY created_at DESC, id DESC LIMIT 1`)
    .get(preferenceSignature(kind)) as { id: string; status: string } | undefined;
}

/**
 * Adds people (canonical ids) to the kind's circle inside the caller's batch, creating it (or reviving one the owner
 * deleted) first. `added` counts people who weren't in it already.
 */
export function addToPreference(t: JournalTx, kind: PreferenceKind, personIds: readonly string[]): { circleId: string; added: number; created: boolean } {
  const row = circleOf(t.db, kind);
  let id = row?.id;
  let created = false;
  if (!id) {
    id = uuidv7(t.now);
    t.insert('circles', {
      id,
      name: PREFERENCES[kind].name,
      kind: 'user',
      signature: preferenceSignature(kind),
      description: PREFERENCES[kind].description,
      color_hex: circleColor(id),
      icon: null,
      locked: 0,
      status: 'active',
    });
    created = true;
  } else if (row!.status !== 'active') {
    t.update('circles', { id }, { status: 'active' });
  }
  return { circleId: id, added: addMembers(t, 'circle', id, personIds, 'user'), created };
}

/** Canonical ids of the people in the kind's (active) circle; empty when there is none. */
export function preferredPeople(db: DB, kind: PreferenceKind): Set<string> {
  const ids = db
    .prepare(
      `SELECT DISTINCT coalesce(pc.canonical_id, cm.person_id) FROM circles c
       JOIN circle_members cm ON cm.circle_id = c.id AND cm.excluded = 0
       LEFT JOIN person_canon pc ON pc.person_id = cm.person_id
       WHERE c.kind = 'user' AND c.signature = ? AND c.status = 'active'`,
    )
    .pluck()
    .all(preferenceSignature(kind)) as string[];
  return new Set(ids);
}
