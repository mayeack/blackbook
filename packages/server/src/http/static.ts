import fs from 'node:fs';
import path from 'node:path';
import express, { type RequestHandler, type Router } from 'express';

// Every sendFile passes `root`: with an absolute path, `send` refuses any dot-directory segment (e.g. a checkout
// under .claude/worktrees), so index.html and the manifest would 404.

/**
 * PWA install assets that sit outside Cloudflare Access (manifest, icons, apple-touch-icon*). Mounted before
 * the Access check; serves nothing else.
 */
export function publicAssets(webDist: string): Router {
  const r = express.Router();
  const opts = { index: false, fallthrough: false, maxAge: '1d' } as const;
  r.get('/manifest.webmanifest', (_req, res, next) => {
    const file = path.join(webDist, 'manifest.webmanifest');
    if (!fs.existsSync(file)) return next();
    res.type('application/manifest+json').setHeader('Cache-Control', 'no-cache');
    res.sendFile('manifest.webmanifest', { root: webDist });
  });
  r.use('/icons', express.static(path.join(webDist, 'icons'), opts));
  r.get(/^\/apple-touch-icon[^/]*\.png$/, (req, res, next) => {
    const name = path.basename(req.path);
    if (!fs.existsSync(path.join(webDist, name))) return next();
    res.sendFile(name, { root: webDist, maxAge: '1d' });
  });
  return r;
}

/**
 * The built SPA (behind Access): hashed /assets are immutable for a year; the service worker and index.html are
 * never cached; other GETs that want HTML fall back to index.html for client-side routes.
 */
export function spa(webDist: string): RequestHandler | null {
  const indexHtml = path.join(webDist, 'index.html');
  if (!fs.existsSync(indexHtml)) return null;
  const r = express.Router();
  r.use('/assets', express.static(path.join(webDist, 'assets'), { immutable: true, maxAge: '1y', fallthrough: false, index: false }));
  r.use(
    express.static(webDist, {
      index: false,
      setHeaders(res, file) {
        if (/(^|\/)(sw|service-worker|registerSW)\.js$|\.html$/.test(file)) res.setHeader('Cache-Control', 'no-cache');
      },
    }),
  );
  r.use((req, res, next) => {
    if (req.method !== 'GET' || !req.accepts('html')) return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile('index.html', { root: webDist });
  });
  return r;
}
