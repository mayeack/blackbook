import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { createApp } from '../src/http/app';
import { accessIssuer } from '../src/http/cfAccess';
import { memDb } from './helpers';

// A locally generated keypair stands in for the team's Access certs.
const TEAM = 'yb-test-team';
const AUD = 'test-aud-0123';
const OWNER = 'owner@example.com';

let privateKey: CryptoKey;
let otherKey: CryptoKey;
let jwks: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  otherKey = (await generateKeyPair('RS256')).privateKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  jwks = createLocalJWKSet({ keys: [jwk] });
});

const token = (o: { email?: string; aud?: string; iss?: string; exp?: string | number; key?: CryptoKey } = {}) =>
  new SignJWT({ email: o.email ?? OWNER, type: 'app' })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuedAt()
    .setIssuer(o.iss ?? accessIssuer(TEAM))
    .setAudience(o.aud ?? AUD)
    .setSubject('user-1')
    .setExpirationTime(o.exp ?? '1h')
    .sign(o.key ?? privateKey);

const app = () => createApp({ db: memDb(), auth: { mode: 'access', team: TEAM, aud: AUD, allowedEmail: OWNER, jwks } });

describe('Cloudflare Access verification', () => {
  it('accepts a valid assertion header', async () => {
    const res = await request(app()).get('/api/v1/me').set('Cf-Access-Jwt-Assertion', await token());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ email: OWNER, via: 'access' });
  });

  it('accepts the CF_Authorization cookie and a differently-cased email', async () => {
    const res = await request(app())
      .get('/api/v1/me')
      .set('Cookie', `other=1; CF_Authorization=${await token({ email: 'Owner@Example.com' })}`);
    expect(res.status).toBe(200);
  });

  it('401 without a token (PLAN: loopback /api/v1/me without a JWT returns 401)', async () => {
    const res = await request(app()).get('/api/v1/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_REQUIRED');
    expect((await request(app()).get('/')).status).toBe(401); // the SPA is behind Access too
  });

  it.each([
    ['wrong audience', { aud: 'someone-else' }],
    ['wrong email', { email: 'intruder@example.org' }],
    ['wrong issuer', { iss: 'https://evil.cloudflareaccess.com' }],
    ['expired', { exp: Math.floor(Date.now() / 1000) - 60 }],
    ['signed by another key', { key: undefined as unknown as CryptoKey, other: true }],
  ])('403 for %s', async (_label, o) => {
    const opts = 'other' in o ? { key: otherKey } : o;
    const res = await request(app()).get('/api/v1/me').set('Cf-Access-Jwt-Assertion', await token(opts));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCESS_DENIED');
  });

  it('403 for garbage and for alg=none', async () => {
    expect((await request(app()).get('/api/v1/me').set('Cf-Access-Jwt-Assertion', 'not.a.jwt')).status).toBe(403);
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ email: OWNER, aud: AUD })).toString('base64url')}.`;
    expect((await request(app()).get('/api/v1/me').set('Cf-Access-Jwt-Assertion', none)).status).toBe(403);
  });

  it('403 for a correctly signed token with no exp (or no email); 401 for a malformed cookie, never 500', async () => {
    const noExp = await new SignJWT({ email: OWNER })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuedAt()
      .setIssuer(accessIssuer(TEAM))
      .setAudience(AUD)
      .sign(privateKey);
    expect((await request(app()).get('/api/v1/me').set('Cf-Access-Jwt-Assertion', noExp)).status).toBe(403);
    const noEmail = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuedAt()
      .setIssuer(accessIssuer(TEAM))
      .setAudience(AUD)
      .setExpirationTime('1h')
      .sign(privateKey);
    expect((await request(app()).get('/api/v1/me').set('Cf-Access-Jwt-Assertion', noEmail)).status).toBe(403);
    const bad = await request(app()).get('/api/v1/me').set('Cookie', 'CF_Authorization=%E0%A4%A');
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('AUTH_REQUIRED');
  });

  it('dev bypass refuses anything that came through the Cloudflare tunnel', async () => {
    const dev = createApp({ db: memDb(), auth: { mode: 'dev-bypass', email: OWNER } });
    expect((await request(dev).get('/api/v1/me')).status).toBe(200);
    expect((await request(dev).get('/api/v1/me').set('Cf-Ray', '0123456789abcdef-DFW')).status).toBe(403);
    expect((await request(dev).get('/api/v1/me').set('Cf-Connecting-Ip', '192.0.2.10')).status).toBe(403);
  });

  it('fails closed when the JWKS cannot be fetched', async () => {
    const broken = createApp({
      db: memDb(),
      auth: { mode: 'access', team: TEAM, aud: AUD, allowedEmail: OWNER, jwks: async () => Promise.reject(new Error('network down')) },
    });
    expect((await request(broken).get('/api/v1/me').set('Cf-Access-Jwt-Assertion', await token())).status).toBe(403);
  });

  it('/healthz needs no token and says only {ok:true}', async () => {
    const res = await request(app()).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(res.text).toBe('{"ok":true}');
  });
});
