/**
 * THE API route registration point. Each module returns a Router with paths relative to /api/v1; add new modules
 * to ROUTES. Everything here sits behind Cloudflare Access, CSRF and Cache-Control: no-store.
 *
 * Agent-loop modules (today … personExtras, intel, tickets) serve the paths listed in AGENT_ROUTES (@yb/shared); a
 * contract test checks every entry is mounted and built.
 */
import { Router } from 'express';
import type { AppConfig } from '../config';
import type { DB } from '../db/connection';
import type { Logger } from '../ops/logger';
import type { ServicesProvider } from '../services';
import { settingsApiRoutes } from '../settings/routes';
import { activityRoutes } from './activity';
import { alertsRoutes } from './alerts';
import { askRoutes } from './ask';
import { circlesRoutes } from './circles';
import { digestRoutes } from './digest';
import { evalRoutes } from './eval';
import { eventsRouter } from './events';
import { gmailRoutes } from './gmail';
import { googleRouter } from './google';
import { gphotosRoutes } from './gphotos';
import { intelRoutes } from './intel';
import { learnerRoutes } from './learner';
import { meRoutes } from './me';
import { networkRoutes } from './network';
import { peopleRoutes } from './people';
import { personExtrasRoutes } from './personExtras';
import { pushRoutes } from './push';
import { settingsRoutes } from './settings';
import { sourcesRoutes } from './sources';
import { suggestionsRoutes } from './suggestions';
import { ticketsRoutes } from './tickets';
import { eventPicksRoutes } from './eventPicks';
import { todayRoutes } from './today';

export interface RouteDeps {
  db: DB;
  log: Logger;
  config?: AppConfig;
  /** Injected LLM/egress/outbound/push (tests); else resolveServices(deps) builds the defaults from config. */
  services?: ServicesProvider;
}

export type RouteModule = (deps: RouteDeps) => Router;

export const ROUTES: RouteModule[] = [
  meRoutes,
  activityRoutes,
  peopleRoutes,
  sourcesRoutes,
  settingsRoutes,
  settingsApiRoutes,
  // tickets, Gmail and Google Photos (before the events router, docs/design/tickets-met-at.md)
  ticketsRoutes,
  // weekly event picks (docs/design/event-picks.md)
  eventPicksRoutes,
  gmailRoutes,
  gphotosRoutes,
  eventsRouter,
  googleRouter,
  // agent loop
  todayRoutes,
  suggestionsRoutes,
  learnerRoutes,
  personExtrasRoutes,
  networkRoutes,
  circlesRoutes,
  askRoutes,
  alertsRoutes,
  pushRoutes,
  evalRoutes,
  digestRoutes,
  intelRoutes,
];

export function apiRouter(deps: RouteDeps): Router {
  const r = Router();
  for (const mod of ROUTES) r.use(mod(deps));
  return r;
}
