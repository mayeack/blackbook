import type { RequestHandler } from 'express';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
export const CSRF_HEADER = 'x-yb';

/**
 * CSRF for the API (no CORS anywhere): a mutating request must be JSON and carry `X-YB: 1`. A cross-site form
 * can do neither, and a cross-site fetch with either needs a preflight we never answer.
 */
export const csrf: RequestHandler = (req, res, next) => {
  if (SAFE.has(req.method)) return next();
  const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/json') {
    res.status(415).json({ error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Send JSON (application/json).' } });
    return;
  }
  if (req.headers[CSRF_HEADER] !== '1') {
    res.status(403).json({ error: { code: 'CSRF', message: 'Missing X-YB header.' } });
    return;
  }
  next();
};
