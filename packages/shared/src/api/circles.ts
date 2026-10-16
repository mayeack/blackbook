/**
 * Circles / Tags / Locations (routes/circles.ts). Auto circles are agent-maintained (badged "auto"): the agent
 * adds/updates members but never deletes a circle or touches manual collections; deletes only happen when the owner
 * asks. Removing a member of an auto circle is sticky (circle_members.excluded).
 *
 *   GET    /api/v1/circles?kind=auto|user|all     → CollectionList   (type circle)
 *   GET    /api/v1/circles/:id                    → CollectionDetail
 *   POST   /api/v1/circles                        CollectionCreate → CollectionWriteResult   (user circle)
 *   PATCH  /api/v1/circles/:id                    CollectionUpdate → BatchRef
 *   POST   /api/v1/circles/:id/members            CollectionMembersEdit → BatchRef
 *   DELETE /api/v1/circles/:id                    {} → BatchRef   (tombstone; user circles only)
 *   … the same six routes under /api/v1/tags and /api/v1/locations.
 */
import { z } from 'zod';
import { CollectionType, Ms, PersonChip } from './common';

export const CollectionSummary = z.object({
  type: CollectionType,
  id: z.string(),
  name: z.string(),
  /** Circles: 'auto' | 'user'; tags/locations: null. */
  kind: z.enum(['auto', 'user']).nullable(),
  description: z.string().nullable(),
  color: z.string().nullable(),
  icon: z.string().nullable(),
  memberCount: z.number().int(),
  /** Legacy groups are locked user circles (the agent never renames them). */
  locked: z.boolean(),
  status: z.enum(['active', 'retracted', 'archived']),
  updatedAt: Ms,
});
export type CollectionSummary = z.infer<typeof CollectionSummary>;

export const CollectionListQuery = z.object({ kind: z.enum(['auto', 'user', 'all']).default('all') });
export type CollectionListQuery = z.infer<typeof CollectionListQuery>;

export const CollectionList = z.object({ items: z.array(CollectionSummary) });
export type CollectionList = z.infer<typeof CollectionList>;

export const CollectionMember = z.object({
  person: PersonChip,
  /** 'auto' | 'user' | 'legacy' (tags/locations: how the row was made). */
  origin: z.string(),
  /** Auto-circle membership score (soft members ≥0.4). */
  score: z.number().nullable(),
  addedAt: Ms,
});
export type CollectionMember = z.infer<typeof CollectionMember>;

export const FacetCount = z.object({ id: z.string(), name: z.string(), count: z.number().int() });
export type FacetCount = z.infer<typeof FacetCount>;

export const CollectionDetail = z.object({
  collection: CollectionSummary,
  /** Sorted by last name A–Z (Intl.Collator), first name tiebreaker, blank last names last. */
  members: z.array(CollectionMember),
  /** Auto suggestions ("Suggested additions"). */
  suggestedAdditions: z.array(z.object({ person: PersonChip, score: z.number(), reason: z.string() })),
  /** Filter chips for the other two facets. */
  facets: z.object({ circles: z.array(FacetCount), tags: z.array(FacetCount), locations: z.array(FacetCount) }),
  /** Locations: people whose current-location fact matches but aren't members. */
  fromFacts: z.array(PersonChip),
  lastActivityAt: Ms.nullable(),
});
export type CollectionDetail = z.infer<typeof CollectionDetail>;

export const CollectionCreate = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(240).optional(),
  color: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
  icon: z.string().max(16).optional(),
  memberIds: z.array(z.string()).max(500).default([]),
});
export type CollectionCreate = z.infer<typeof CollectionCreate>;

export const CollectionUpdate = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(240).nullable(),
    color: z.string().regex(/^#[0-9a-f]{6}$/i).nullable(),
    icon: z.string().max(16).nullable(),
  })
  .partial();
export type CollectionUpdate = z.infer<typeof CollectionUpdate>;

export const CollectionMembersEdit = z.object({
  add: z.array(z.string()).max(500).default([]),
  remove: z.array(z.string()).max(500).default([]),
});
export type CollectionMembersEdit = z.infer<typeof CollectionMembersEdit>;

export const CollectionWriteResult = z.object({ collection: CollectionSummary, batchId: z.string().nullable() });
export type CollectionWriteResult = z.infer<typeof CollectionWriteResult>;
