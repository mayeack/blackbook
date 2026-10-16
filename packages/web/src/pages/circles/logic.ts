/**
 * Pure helpers for Circles / Tags / Locations (unit-tested; no React here).
 */
import type { CollectionMember, CollectionSummary, CollectionType } from '@yb/shared';

const API: Record<CollectionType, string> = { circle: '/circles', tag: '/tags', location: '/locations' };
const WEB: Record<CollectionType, string> = { circle: '/c', tag: '/tags', location: '/locations' };

/** API path under /api/v1. */
export const collectionApiPath = (type: CollectionType) => API[type];
/** Web route of a collection's detail page. */
export const collectionPath = (type: CollectionType, id: string) => `${WEB[type]}/${encodeURIComponent(id)}`;

export const COLLECTION_TABS: { type: CollectionType; label: string }[] = [
  { type: 'circle', label: 'Circles' },
  { type: 'tag', label: 'Tags' },
  { type: 'location', label: 'Locations' },
];

/** `?tab=tags|locations` (default circles). */
export function parseTab(v: string | null): CollectionType {
  if (v === 'tags' || v === 'tag') return 'tag';
  if (v === 'locations' || v === 'location') return 'location';
  return 'circle';
}
export const tabParam = (t: CollectionType) => (t === 'circle' ? null : t === 'tag' ? 'tags' : 'locations');

const NOUNS: Record<CollectionType, { one: string; title: string }> = {
  circle: { one: 'circle', title: 'Circle' },
  tag: { one: 'tag', title: 'Tag' },
  location: { one: 'place', title: 'Location' },
};
export const collectionNoun = (t: CollectionType) => NOUNS[t];

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

/** Active collections; circles split auto first (biggest first), then the owner's by name. */
export function sortCollections(items: readonly CollectionSummary[]): CollectionSummary[] {
  return items
    .filter((c) => c.status === 'active')
    .sort((a, b) => {
      if (a.type === 'circle' && a.kind !== b.kind) return a.kind === 'auto' ? -1 : 1;
      if (a.kind === 'auto' && b.kind === 'auto') return b.memberCount - a.memberCount || collator.compare(a.name, b.name);
      return collator.compare(a.name, b.name);
    });
}

/** Text filter over collection names and descriptions. */
export function matchCollections(items: readonly CollectionSummary[], q: string): CollectionSummary[] {
  const s = q.trim().toLocaleLowerCase();
  if (!s) return [...items];
  return items.filter((c) => c.name.toLocaleLowerCase().includes(s) || (c.description ?? '').toLocaleLowerCase().includes(s));
}

/** A member's caption: how they got in (and the auto score for soft members). */
export function memberSubtitle(m: Pick<CollectionMember, 'origin' | 'score'>, type: CollectionType): string | null {
  if (m.origin === 'auto') return m.score != null && m.score < 1 ? `Added by the agent · ${Math.round(m.score * 100)}% fit` : 'Added by the agent';
  if (m.origin === 'legacy') return 'From Blackbook';
  if (m.origin === 'user') return type === 'circle' ? 'Added by you' : null;
  return null;
}

export type FacetKey = 'circles' | 'tags' | 'locations';
export const FACET_TYPE: Record<FacetKey, CollectionType> = { circles: 'circle', tags: 'tag', locations: 'location' };
export const FACET_TITLE: Record<FacetKey, string> = { circles: 'Circles', tags: 'Tags', locations: 'Places' };

/** The two facets other than this collection's own type. */
export const otherFacets = (type: CollectionType): FacetKey[] =>
  (['circles', 'tags', 'locations'] as const).filter((f) => FACET_TYPE[f] !== type);

/**
 * Members after facet filters: OR within a facet, AND across facets. `facetMembers` maps a selected facet value
 * (`circles:<id>`) to its member ids; a selected value whose members haven't loaded yet keeps everyone (null).
 */
export function filterByFacets<T extends { person: { id: string } }>(
  members: readonly T[],
  selected: Readonly<Partial<Record<FacetKey, readonly string[]>>>,
  facetMembers: (facet: FacetKey, id: string) => ReadonlySet<string> | null,
): T[] {
  let out = [...members];
  for (const facet of Object.keys(selected) as FacetKey[]) {
    const ids = selected[facet] ?? [];
    if (!ids.length) continue;
    const sets = ids.map((id) => facetMembers(facet, id));
    if (sets.some((s) => s === null)) continue;
    out = out.filter((m) => sets.some((s) => s!.has(m.person.id)));
  }
  return out;
}

/** Name filter over members (display name, any word prefix or substring). */
export function matchMembers<T extends { person: { displayName: string } }>(members: readonly T[], q: string): T[] {
  const s = q.trim().toLocaleLowerCase();
  if (!s) return [...members];
  return members.filter((m) => m.person.displayName.toLocaleLowerCase().includes(s));
}

/** Toggles `id` in a facet's selection. */
export function toggleFacet(
  selected: Readonly<Partial<Record<FacetKey, readonly string[]>>>,
  facet: FacetKey,
  id: string,
): Partial<Record<FacetKey, string[]>> {
  const cur = selected[facet] ?? [];
  const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
  const out: Partial<Record<FacetKey, string[]>> = {};
  for (const [k, v] of Object.entries(selected) as [FacetKey, readonly string[]][]) if (k !== facet && v.length) out[k] = [...v];
  if (next.length) out[facet] = next;
  return out;
}

/** "auto" circles are agent-maintained; legacy groups are locked user circles. */
export function collectionBadges(c: Pick<CollectionSummary, 'type' | 'kind' | 'locked'>): string[] {
  const out: string[] = [];
  if (c.type === 'circle' && c.kind === 'auto') out.push('auto');
  if (c.locked) out.push('from Blackbook');
  return out;
}

/** What the delete action is called and whether it's offered (auto circles are archived, never deleted). */
export function deleteAction(c: Pick<CollectionSummary, 'type' | 'kind'>): { label: string; verb: string } {
  if (c.type === 'circle' && c.kind === 'auto') return { label: 'Archive circle', verb: 'Archive' };
  return { label: `Delete ${collectionNoun(c.type).one}`, verb: 'Delete' };
}
