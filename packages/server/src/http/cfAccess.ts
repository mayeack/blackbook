/**
 * Cloudflare Access check (architecture §1d). cloudflared reaches us from 127.0.0.1, so "loopback" proves
 * nothing: every request except the bypass paths must carry a valid Access JWT (Cf-Access-Jwt-Assertion header,
 * or the CF_Authorization cookie) signed by the team's JWKS, for our AUD, issued by the team domain, for the one
 * allowed email. Anything else fails closed.
 */
import type { RequestHandler } from 'express';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { errorFields, type Logger } from '../ops/logger';

export type AuthConfig =
  | { mode: 'access'; team: string; aud: string; allowedEmail: string; jwks?: JWTVerifyGetKey }
  | { mode: 'dev-bypass'; email: string };

export interface AuthedUser {
  email: string;
  via: 'access' | 'dev-bypass';
}

export const ACCESS_HEADER = 'cf-access-jwt-assertion';
export const ACCESS_COOKIE = 'CF_Authorization';

export const accessIssuer = (team: string) => `https://${team}.cloudflareaccess.com`;
export const accessCertsUrl = (team: string) => `${accessIssuer(team)}/cdn-cgi/access/certs`;

/** Bypass paths (no Access app in front of them either): health and the PWA install assets. */
export function isPublicPath(path: string): boolean {
  return (
    path === '/healthz' ||
    path === '/manifest.webmanifest' ||
    path.startsWith('/icons/') ||
    /^\/apple-touch-icon[^/]*\.png$/.test(path)
  );
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return undefined; // malformed escape: treated as no token (401), not a server error
      }
    }
  }
  return undefined;
}

/** Headers Cloudflare's edge adds to every proxied request; a local browser never sends them. */
const TUNNEL_HEADERS = ['cf-ray', 'cf-connecting-ip'] as const;

const deny = (res: Parameters<RequestHandler>[1], status: 401 | 403, code: string) =>
  res.status(status).json({ error: { code, message: status === 401 ? 'Sign in through Cloudflare Access.' : 'Access denied.' } });

export function cfAccess(auth: AuthConfig, log: Logger): RequestHandler {
  if (auth.mode === 'dev-bypass') {
    // A dev server left on the production port would otherwise serve the tunnel with no JWT check.
    return (req, res, next) => {
      if (TUNNEL_HEADERS.some((h) => req.headers[h] !== undefined)) {
        log.warn('auth.dev_bypass_tunnel_refused');
        return void deny(res, 403, 'ACCESS_DENIED');
      }
      res.locals.user = { email: auth.email, via: 'dev-bypass' } satisfies AuthedUser;
      next();
    };
  }
  // createRemoteJWKSet caches keys and refetches on an unknown kid (with a cooldown).
  const jwks = auth.jwks ?? createRemoteJWKSet(new URL(accessCertsUrl(auth.team)));
  const issuer = accessIssuer(auth.team);
  const allowed = auth.allowedEmail.toLowerCase();

  return async (req, res, next) => {
    const header = req.headers[ACCESS_HEADER];
    const token = (Array.isArray(header) ? header[0] : header) || readCookie(req.headers.cookie, ACCESS_COOKIE);
    if (!token) return void deny(res, 401, 'AUTH_REQUIRED');
    try {
      const { payload } = await jwtVerify(token, jwks, {
        audience: auth.aud,
        issuer,
        algorithms: ['RS256'],
        requiredClaims: ['exp', 'iat', 'email'],
      });
      const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : '';
      if (!email || email !== allowed) return void deny(res, 403, 'ACCESS_DENIED');
      res.locals.user = { email, via: 'access' } satisfies AuthedUser;
      next();
    } catch (e) {
      log.warn('auth.rejected', { error_class: errorFields(e).error_class, error_code: errorFields(e).error_code });
      deny(res, 403, 'ACCESS_DENIED');
    }
  };
}
