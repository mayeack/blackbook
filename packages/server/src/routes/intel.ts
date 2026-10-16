/**
 * Event and travel intel (intelligence §5; DTOs in @yb/shared api/intel.ts):
 *
 *   GET /api/v1/events/:id/brief           → EventBrief    an occasion (merged-away ids answer with the survivor) or a
 *                                                           Partiful event; sensitive / non-social ones are 404
 *   GET /api/v1/trips?when=upcoming|past|all → TripsResponse trips, people you know there, visitors to your city
 *
 * Read-only apart from rebuilding the derived trips table when the nightly pass is stale. People come through
 * person_visible only.
 */
import { Router } from 'express';
import { z } from 'zod';
import { EventBrief, TripsQuery, TripsResponse } from '@yb/shared';
import { notFound } from '../http/errors';
import { eventBrief } from '../intel/brief';
import { tripsResponse } from '../intel/views';
import { settingTimeZone } from '../settings/registry';
import type { RouteDeps } from './index';

const IdParam = z.object({ id: z.string().regex(/^[0-9a-f-]{36}$/i) });

export function intelRoutes({ db }: RouteDeps): Router {
  const r = Router();
  r.get('/events/:id/brief', (req, res) => {
    const { id } = IdParam.parse(req.params);
    const brief = eventBrief(db, id, { now: Date.now(), timeZone: settingTimeZone(db) });
    if (!brief) throw notFound('Event');
    res.json(EventBrief.parse(brief));
  });
  r.get('/trips', (req, res) => {
    const q = TripsQuery.parse(req.query);
    res.json(TripsResponse.parse(tripsResponse(db, q.when, { now: Date.now(), timeZone: settingTimeZone(db) })));
  });
  return r;
}
