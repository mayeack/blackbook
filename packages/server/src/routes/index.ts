/**
 * THE API route registration point. Each module returns a Router with paths relative to /api/v1; add new modules
 * to ROUTES. Everything here sits behind Cloudflare Access, CSRF and Cache-Control: no-store.
 */
import { Router } from 'express';
import type { AppConfig } from '../config';
import type { DB } from '../db/connection';
import type { Logger } from '../ops/logger';
import { activityRoutes } from './activity';
import { eventsRouter } from './events';
import { googleRouter } from './google';
import { meRoutes } from './me';
import { peopleRoutes } from './people';
import { settingsRoutes } from './settings';
import { sourcesRoutes } from './sources';

export interface RouteDeps {
  db: DB;
  log: Logger;
  config?: AppConfig;
}

export type RouteModule = (deps: RouteDeps) => Router;

export const ROUTES: RouteModule[] = [
  meRoutes,
  activityRoutes,
  peopleRoutes,
  sourcesRoutes,
  settingsRoutes,
  eventsRouter,
  googleRouter,
];

export function apiRouter(deps: RouteDeps): Router {
  const r = Router();
  for (const mod of ROUTES) r.use(mod(deps));
  return r;
}
