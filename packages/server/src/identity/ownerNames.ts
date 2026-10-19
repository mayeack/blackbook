/**
 * Names that read unambiguously to the owner. Copy shortens names to "Sam R." (first name + last initial); that
 * short form is ambiguous when it reads the same as the owner's own ("Sam R." about a friend, read by an owner
 * who is a Sam R. too) or as another person named alongside (two "Sam R."s in one brief). collisionAware keeps
 * the short form otherwise and switches the colliding people to the long form (first name + full last name).
 *
 *   ownerNames      the owner's names: the 'me' row and every person merged into it (first + last, or the
 *                   display name), their Contacts cards (given + family) and Contacts identities' display names;
 *                   the "Me" placeholder the resolver creates never counts. Reads only.
 *   collisionAware  pure: the display name per person given the short and long forms a caller uses.
 */
import { canonicalMembers } from '../db/canon';
import type { DB } from '../db/connection';

export interface OwnerName {
  firstName: string | null;
  lastName: string | null;
  displayName: string;
  nickname: string | null;
}

/** identity/resolver.ts creates the owner's row as "Me": not a name anyone has. */
const PLACEHOLDER = /^me$/i;

const clean = (s: string | null | undefined): string => s?.normalize('NFKC').replace(/\s+/g, ' ').trim() ?? '';

/** A full name as first word + last word ("Sam Rivera"); null for an empty name or the placeholder. */
function fromDisplay(name: string | null | undefined): OwnerName | null {
  const full = clean(name);
  if (!full || PLACEHOLDER.test(full)) return null;
  const words = full.split(' ');
  return { firstName: words[0]!, lastName: words.length > 1 ? words[words.length - 1]! : null, displayName: full, nickname: null };
}

function fromParts(first: string | null, last: string | null, display: string | null, nickname: string | null): OwnerName | null {
  if (!clean(first)) return fromDisplay(display);
  return { firstName: clean(first), lastName: clean(last) || null, displayName: clean(display), nickname: clean(nickname) || null };
}

/** The owner's names (see the header); empty before the first ingest created the owner's row. */
export function ownerNames(db: DB): OwnerName[] {
  const meId = db.prepare(`SELECT id FROM people WHERE kind = 'me' AND status IN ('active','provisional') ORDER BY created_at LIMIT 1`).pluck().get() as
    | string
    | undefined;
  if (!meId) return [];
  const members = JSON.stringify(canonicalMembers(db, meId));
  const out: OwnerName[] = [];
  const add = (n: OwnerName | null) => {
    if (!n) return;
    out.push(n);
    // An owner who goes by a nickname reads it as their own name too.
    if (n.nickname && n.lastName) out.push({ firstName: n.nickname, lastName: n.lastName, displayName: '', nickname: null });
  };
  const rows = db.prepare(`SELECT first_name, last_name, display_name, nickname FROM people WHERE id IN (SELECT value FROM json_each(?))`).all(members) as {
    first_name: string | null;
    last_name: string | null;
    display_name: string;
    nickname: string | null;
  }[];
  for (const r of rows) add(fromParts(r.first_name, r.last_name, r.display_name, r.nickname));
  const cards = db
    .prepare(
      `SELECT c.fields FROM addressbook_cards c JOIN identities i ON i.id = c.identity_id
       WHERE c.removed_at IS NULL AND i.status = 'active' AND i.person_id IN (SELECT value FROM json_each(?))`,
    )
    .pluck()
    .all(members) as string[];
  for (const raw of cards) {
    let f: { displayName?: string | null; given?: string | null; family?: string | null; nickname?: string | null };
    try {
      f = JSON.parse(raw) as typeof f;
    } catch {
      continue;
    }
    add(fromParts(f.given ?? null, f.family ?? null, f.displayName ?? null, f.nickname ?? null));
  }
  const labels = db
    .prepare(
      `SELECT display_name FROM identities WHERE kind = 'addressbook_id' AND status = 'active' AND display_name IS NOT NULL
         AND person_id IN (SELECT value FROM json_each(?))`,
    )
    .pluck()
    .all(members) as string[];
  for (const d of labels) add(fromDisplay(d));
  return out;
}

/** Comparison form of a display name (case, width and spacing don't tell names apart). */
export const nameKey = (s: string): string => clean(s).toLocaleLowerCase('en-US');

export interface NameForms<P> {
  /** "Sam R." */
  short: (p: P) => string | null;
  /** "Sam Rivera" (the short form when there is no last name). */
  long: (p: P) => string | null;
}

export interface CollisionAwareNames<P> {
  /** The name to show: the short form, or the long form when the short one collides (any person, in the set or not). */
  of(p: P): string | null;
  /** Ids of the people in the set whose short form collides. */
  colliding: ReadonlySet<string>;
}

/**
 * Display names for `people` named together (one brief, one suggestion): a short form that reads the same as one
 * of `ownerShorts` or as another person's in the set becomes the long form. People whose long forms still match
 * keep them: there is nothing else in a name to tell them apart by.
 */
export function collisionAware<P extends { id: string }>(people: readonly P[], ownerShorts: Iterable<string | null>, forms: NameForms<P>): CollisionAwareNames<P> {
  const owner = new Set([...ownerShorts].filter((s): s is string => !!s).map(nameKey));
  const holders = new Map<string, Set<string>>();
  for (const p of people) {
    const s = forms.short(p);
    if (!s) continue;
    const k = nameKey(s);
    holders.set(k, (holders.get(k) ?? new Set()).add(p.id));
  }
  const collides = (p: P): boolean => {
    const s = forms.short(p);
    if (!s) return false;
    const k = nameKey(s);
    return owner.has(k) || [...(holders.get(k) ?? [])].some((id) => id !== p.id);
  };
  return {
    of: (p) => (collides(p) ? (forms.long(p) ?? forms.short(p)) : forms.short(p)),
    colliding: new Set(people.filter(collides).map((p) => p.id)),
  };
}
