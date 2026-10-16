/**
 * Request pipeline:
 *   helmet (strict CSP) → rate limit (CF-Connecting-IP) → access log
 *   → /healthz (no auth, {ok:true} only) → PWA install assets (no auth)
 *   → Cloudflare Access → /api: no-store, JSON body, CSRF, routes → SPA → errors
 */
import express, { type Express } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import helmet from 'helmet';
import type { DB } from '../db/connection';
import { nullLogger, type Logger } from '../ops/logger';
import { apiRouter, type RouteDeps } from '../routes/index';
import { cfAccess, isPublicPath, type AuthConfig } from './cfAccess';
import { csrf } from './csrf';
import { errorHandler, routePattern } from './errors';
import { publicAssets, spa } from './static';

export interface CreateAppOptions {
  db: DB;
  auth: AuthConfig;
  log?: Logger;
  /** Built PWA (packages/web/dist); null = API only. */
  webDist?: string | null;
  production?: boolean;
  /** Requests per minute per client (general / Ask). */
  rateLimits?: { general: number; ask: number };
  config?: RouteDeps['config'];
}

export function createApp(o: CreateAppOptions): Express {
  const log = o.log ?? nullLogger;
  const app = express();
  app.disable('x-powered-by');
  // cloudflared connects from loopback; only then is CF-Connecting-IP / X-Forwarded-For trusted.
  app.set('trust proxy', 'loopback');

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          fontSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          workerSrc: ["'self'"],
          manifestSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          ...(o.production ? { upgradeInsecureRequests: [] } : {}),
        },
      },
      crossOriginEmbedderPolicy: false,
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );

  const clientKey = (req: express.Request) => {
    const cf = req.headers['cf-connecting-ip'];
    const ip = (Array.isArray(cf) ? cf[0] : cf) || req.ip || 'unknown';
    return ipKeyGenerator(ip);
  };
  const limits = o.rateLimits ?? { general: 120, ask: 20 };
  const limiter = (limit: number) =>
    rateLimit({
      windowMs: 60_000,
      limit,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      keyGenerator: clientKey,
      handler: (_req, res) => void res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests.' } }),
    });
  app.use('/api/v1/ask', limiter(limits.ask));
  app.use(limiter(limits.general));

  // Access log: method, route pattern, status, duration. Never the raw URL or query.
  app.use((req, res, next) => {
    const started = performance.now();
    res.on('finish', () => {
      log.info('http.request', {
        method: req.method,
        route: routePattern(req),
        status: res.statusCode,
        duration_ms: performance.now() - started,
      });
    });
    next();
  });

  app.get('/healthz', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true });
  });
  if (o.webDist) app.use(publicAssets(o.webDist));
  app.use((req, res, next) => {
    if (isPublicPath(req.path)) return void res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found.' } });
    next();
  });

  app.use(cfAccess(o.auth, log));

  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', csrf);
  app.use('/api', express.json({ limit: '1mb' }));
  app.use('/api/v1', apiRouter({ db: o.db, log, config: o.config }));
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Unknown API route.' } });
  });

  const web = o.webDist ? spa(o.webDist) : null;
  if (web) app.use(web);

  app.use(errorHandler(log));
  return app;
}
