/**
 * Circles / Tags / Locations (DTOs: @yb/shared api/circles.ts; logic: pipeline/circles/collections.ts):
 *
 *   GET    /circles?kind=auto|user|all   /tags   /locations          → CollectionList
 *   GET    /{circles|tags|locations}/:id                             → CollectionDetail
 *   POST   /{circles|tags|locations}         CollectionCreate        → CollectionWriteResult   (user collection)
 *   PATCH  /{circles|tags|locations}/:id     CollectionUpdate        → BatchRef
 *   POST   /{circles|tags|locations}/:id/members CollectionMembersEdit → BatchRef   (removing is sticky)
 *   DELETE /{circles|tags|locations}/:id                             → BatchRef   (tombstone; an auto circle is archived)
 *
 * Every write is the owner's (actor 'user'), journaled and undoable from Today. The agent maintains auto circles
 * (weekly) but never deletes a collection or touches the owner's own ones.
 */
import { Router } from 'express';
import { z } from 'zod';
import {
  CollectionCreate,
  CollectionListQuery,
  CollectionMembersEdit,
  CollectionUpdate,
  UuidId,
  type BatchRef,
  type CollectionDetail,
  type CollectionList,
  type CollectionWriteResult,
} from '@yb/shared';
import {
  collectionDetail,
  createCollection,
  deleteCollection,
  editMembers,
  listCollections,
  updateCollection,
  type CollectionKind,
} from '../pipeline/circles/collections';
import type { RouteDeps } from './index';

const PATHS: readonly [string, CollectionKind][] = [
  ['circles', 'circle'],
  ['tags', 'tag'],
  ['locations', 'location'],
];

const IdParam = z.object({ id: UuidId });
const PersonIds = z.array(UuidId).max(500);
const MembersEdit = CollectionMembersEdit.extend({ add: PersonIds.default([]), remove: PersonIds.default([]) });
const Create = CollectionCreate.extend({ memberIds: PersonIds.default([]) });

export function circlesRoutes({ db }: RouteDeps): Router {
  const r = Router();
  for (const [path, type] of PATHS) {
    r.get(`/${path}`, (req, res) => {
      const q = CollectionListQuery.parse(req.query);
      res.json({ items: listCollections(db, type, q.kind) } satisfies CollectionList);
    });

    r.get(`/${path}/:id`, (req, res) => {
      const { id } = IdParam.parse(req.params);
      res.json(collectionDetail(db, type, id) satisfies CollectionDetail);
    });

    r.post(`/${path}`, (req, res) => {
      const body = Create.parse(req.body ?? {});
      res.json(createCollection(db, type, body) satisfies CollectionWriteResult);
    });

    r.patch(`/${path}/:id`, (req, res) => {
      const { id } = IdParam.parse(req.params);
      const patch = CollectionUpdate.parse(req.body ?? {});
      res.json(updateCollection(db, type, id, patch) satisfies BatchRef);
    });

    r.post(`/${path}/:id/members`, (req, res) => {
      const { id } = IdParam.parse(req.params);
      const edit = MembersEdit.parse(req.body ?? {});
      res.json(editMembers(db, type, id, edit) satisfies BatchRef);
    });

    r.delete(`/${path}/:id`, (req, res) => {
      const { id } = IdParam.parse(req.params);
      res.json(deleteCollection(db, type, id) satisfies BatchRef);
    });
  }
  return r;
}
