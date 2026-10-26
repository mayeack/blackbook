/**
 * Standing preferences the owner states by text ("prioritize inviting Sam to parties", "deprioritize Jake", "stop
 * suggesting Jess"). The intent parser names an ACTION per person; each action sets the person's priority / hidden
 * flags and moves them in or out of reserved USER circles (one per kind, found by its signature `pref:<kind>` rather
 * than its name), so every preference shows on /circles like any circle and the owner can rename it or remove people
 * (removal is sticky, as for every circle). Writes join the caller's journal batch: undo retracts a circle it
 * created, excludes the members it added, restores the members it removed and the flags it changed. Readers (the
 * suggestions stage, event intel) get canonical member ids.
 *
 *   action         circles: add / remove                          flags
 *   invite_first   + Party invites, − Not for party invites
 *   stop_inviting  + Not for party invites, − Party invites
 *   prioritize     − Deprioritized, − Don't suggest              priority on
 *   deprioritize   + Deprioritized, − Party invites              priority off
 *   mute           + Don't suggest
 *   unmute         − Don't suggest
 *   hide           (none)                                        hidden (Settings → Hidden contacts brings them back)
 */
import { uuidv7 } from '@yb/shared';
import type { DB } from '../../db/connection';
import type { JournalTx } from '../../journal/batch';
import { addMembers, removeMembers } from './collections';
import { circleColor } from './run';

export const PREFERENCE_KINDS = ['party_invites', 'no_party_invites', 'deprioritized', 'no_suggestions'] as const;
export type PreferenceKind = (typeof PREFERENCE_KINDS)[number];

export const PREFERENCES: Readonly<Record<PreferenceKind, { name: string; description: string }>> = {
  party_invites: { name: 'Party invites', description: 'People to invite to parties and events first (you asked by text).' },
  no_party_invites: { name: 'Not for party invites', description: 'Never suggested as party invites (you asked by text).' },
  deprioritized: { name: 'Deprioritized', description: 'Suggested less often and never as party regulars (you asked by text).' },
  no_suggestions: { name: 'Don’t suggest', description: 'Never suggested (you asked by text).' },
};

export const PREFERENCE_ACTIONS = ['invite_first', 'stop_inviting', 'prioritize', 'deprioritize', 'mute', 'unmute', 'hide'] as const;
export type PreferenceAction = (typeof PREFERENCE_ACTIONS)[number];

interface ActionEffect {
  add?: PreferenceKind;
  remove?: readonly PreferenceKind[];
  priority?: boolean;
  hidden?: boolean;
  /** "✓ <done(names)>." when the action is the whole reply; the journal title uses it too (never for hide). */
  done: (names: string) => string;
  /** The line under a reply that already names them ("✓ Noted for Sam R." + "Prioritized for party invites."). */
  short: string;
}

export const ACTION_EFFECTS: Readonly<Record<PreferenceAction, ActionEffect>> = {
  invite_first: {
    add: 'party_invites',
    remove: ['no_party_invites'],
    done: (n) => `Prioritized ${n} for party invites`,
    short: 'prioritized for party invites',
  },
  stop_inviting: {
    add: 'no_party_invites',
    remove: ['party_invites'],
    done: (n) => `I'll stop suggesting ${n} for party invites`,
    short: 'no more party invite suggestions',
  },
  prioritize: { remove: ['deprioritized', 'no_suggestions'], priority: true, done: (n) => `Prioritized ${n}`, short: 'prioritized' },
  deprioritize: { add: 'deprioritized', remove: ['party_invites'], priority: false, done: (n) => `Deprioritized ${n}`, short: 'deprioritized' },
  mute: { add: 'no_suggestions', done: (n) => `I'll stop suggesting ${n}`, short: 'no more suggestions about them' },
  unmute: { remove: ['no_suggestions'], done: (n) => `I'll suggest ${n} again`, short: 'suggested again' },
  hide: { hidden: true, done: (n) => `Hid ${n}. Settings → Hidden contacts brings them back`, short: 'hidden (Settings → Hidden contacts brings them back)' },
};

/** The journal title for an action: never names a person it hides (the feed must not leak a hidden name). */
export function preferenceTitle(action: PreferenceAction, names: string): string {
  return action === 'hide' ? 'Hid a person (text)' : `${ACTION_EFFECTS[action].done(names)} (text)`;
}

/** Preferences stored before actions existed (open clarifications) carry the circle kind instead. */
export function legacyAction(p: { action?: PreferenceAction; kind?: string }): PreferenceAction | null {
  if (p.action && (PREFERENCE_ACTIONS as readonly string[]).includes(p.action)) return p.action;
  return p.kind === 'party_invites' ? 'invite_first' : null;
}

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

/** Takes people out of the kind's circle (sticky); 0 when there is no such circle or they weren't in it. */
export function removeFromPreference(t: JournalTx, kind: PreferenceKind, personIds: readonly string[]): number {
  const row = circleOf(t.db, kind);
  return row ? removeMembers(t, 'circle', row.id, personIds) : 0;
}

export interface PreferenceApplied {
  /** People the action changed anything for. */
  changed: number;
  /** People taken out of each circle (e.g. Party invites, by deprioritize). */
  removed: Partial<Record<PreferenceKind, number>>;
}

/** Applies one action to people (canonical, visible ids) inside the caller's batch. */
export function applyPreference(t: JournalTx, action: PreferenceAction, personIds: readonly string[]): PreferenceApplied {
  const e = ACTION_EFFECTS[action];
  const changed = new Set<string>();
  const removed: PreferenceApplied['removed'] = {};
  for (const id of new Set(personIds)) {
    if (e.priority !== undefined && t.update('people', { id }, { is_priority: e.priority ? 1 : 0 })) changed.add(id);
    if (e.hidden && t.update('people', { id }, { is_hidden: 1 })) changed.add(id);
    for (const kind of e.remove ?? []) {
      const n = removeFromPreference(t, kind, [id]);
      if (n) {
        removed[kind] = (removed[kind] ?? 0) + n;
        changed.add(id);
      }
    }
    if (e.add && addToPreference(t, e.add, [id]).added) changed.add(id);
  }
  return { changed: changed.size, removed };
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
