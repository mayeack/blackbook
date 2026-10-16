import { describe, expect, it } from 'vitest';
import type { CollectionSummary } from '@yb/shared';
import {
  collectionApiPath,
  collectionBadges,
  collectionPath,
  deleteAction,
  filterByFacets,
  matchCollections,
  matchMembers,
  memberSubtitle,
  otherFacets,
  parseTab,
  sortCollections,
  tabParam,
  toggleFacet,
} from '../src/pages/circles/logic';

const coll = (o: Partial<CollectionSummary>): CollectionSummary => ({
  type: 'circle',
  id: 'x',
  name: 'X',
  kind: 'user',
  description: null,
  color: null,
  icon: null,
  memberCount: 0,
  locked: false,
  status: 'active',
  updatedAt: 0,
  ...o,
});

describe('collections', () => {
  it('routes and tabs', () => {
    expect(collectionApiPath('tag')).toBe('/tags');
    expect(collectionPath('circle', 'a b')).toBe('/c/a%20b');
    expect(collectionPath('location', 'l1')).toBe('/locations/l1');
    expect(parseTab(null)).toBe('circle');
    expect(parseTab('tags')).toBe('tag');
    expect(parseTab('locations')).toBe('location');
    expect(tabParam('circle')).toBeNull();
    expect(tabParam('location')).toBe('locations');
    expect(otherFacets('tag')).toEqual(['circles', 'locations']);
  });

  it('sorts auto circles first (biggest first), then the owner’s by name; drops inactive', () => {
    const out = sortCollections([
      coll({ id: 'u2', name: 'zeta' }),
      coll({ id: 'a1', kind: 'auto', name: 'Ski', memberCount: 4 }),
      coll({ id: 'u1', name: 'Alpha' }),
      coll({ id: 'a2', kind: 'auto', name: 'Book club', memberCount: 9 }),
      coll({ id: 'gone', name: 'Old', status: 'retracted' }),
    ]);
    expect(out.map((c) => c.id)).toEqual(['a2', 'a1', 'u1', 'u2']);
    expect(matchCollections(out, 'BOOK').map((c) => c.id)).toEqual(['a2']);
  });

  it('badges and delete wording: auto circles are archived, never deleted', () => {
    expect(collectionBadges(coll({ kind: 'auto' }))).toEqual(['auto']);
    expect(collectionBadges(coll({ locked: true }))).toEqual(['from Blackbook']);
    expect(deleteAction(coll({ kind: 'auto' })).verb).toBe('Archive');
    expect(deleteAction(coll({ type: 'tag', kind: null })).label).toBe('Delete tag');
    expect(deleteAction(coll({ type: 'location', kind: null })).label).toBe('Delete place');
  });

  it('member captions', () => {
    expect(memberSubtitle({ origin: 'auto', score: 0.62 }, 'circle')).toBe('Added by the agent · 62% fit');
    expect(memberSubtitle({ origin: 'auto', score: 1 }, 'circle')).toBe('Added by the agent');
    expect(memberSubtitle({ origin: 'user', score: null }, 'circle')).toBe('Added by you');
    expect(memberSubtitle({ origin: 'user', score: null }, 'tag')).toBeNull();
    expect(memberSubtitle({ origin: 'legacy', score: null }, 'tag')).toBe('From Blackbook');
  });

  it('facet filters: OR within a facet, AND across, unloaded facets keep everyone', () => {
    const members = ['a', 'b', 'c', 'd'].map((id) => ({ person: { id, displayName: id.toUpperCase() } }));
    const sets: Record<string, Set<string>> = { 'tags:t1': new Set(['a', 'b']), 'tags:t2': new Set(['c']), 'locations:l1': new Set(['a', 'c', 'd']) };
    const lookup = (f: string, id: string) => sets[`${f}:${id}`] ?? null;
    expect(filterByFacets(members, { tags: ['t1', 't2'] }, lookup).map((m) => m.person.id)).toEqual(['a', 'b', 'c']);
    expect(filterByFacets(members, { tags: ['t1', 't2'], locations: ['l1'] }, lookup).map((m) => m.person.id)).toEqual(['a', 'c']);
    expect(filterByFacets(members, { tags: ['unloaded'] }, lookup)).toHaveLength(4);
    expect(matchMembers(members, 'b').map((m) => m.person.id)).toEqual(['b']);
  });

  it('toggles facet selections and drops empty facets', () => {
    let s = toggleFacet({}, 'tags', 't1');
    expect(s).toEqual({ tags: ['t1'] });
    s = toggleFacet(s, 'locations', 'l1');
    s = toggleFacet(s, 'tags', 't1');
    expect(s).toEqual({ locations: ['l1'] });
  });
});
