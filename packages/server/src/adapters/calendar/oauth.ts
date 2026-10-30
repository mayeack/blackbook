/**
 * The Google consent flow (authorization code + PKCE S256, offline access, one product's scope per consent).
 *   start(p)   → the accounts.google.com URL for product p (calendar.readonly, gmail.readonly or the Photos Picker),
 *                plus a pending {state → code_verifier, product} kept in memory for 10 min. Only a hash of the state
 *                is the map key; nothing of the flow is persisted or logged.
 *   consume()  → the verifier and product for a returned state, once (a replayed or expired state gets null). The
 *                product comes from the pending entry, never from the callback's query, so a callback can't store a
 *                token under another product.
 *   exchange() → code + verifier → refresh token, granted scopes and, when the consent asked for openid email
 *                (gmail_send), the account's verified address from the id_token (POST oauth2.googleapis.com/token:
 *                straight from Google over TLS, so its payload is read without checking the signature).
 *   revoke()   → POST oauth2.googleapis.com/revoke.
 * A server restart drops pending flows: the owner just starts again from Settings.
 */
import crypto from 'node:crypto';
import { GOOGLE_PRODUCTS, mapGoogleError, oauthClient, type FetchLike, type GoogleOAuthConfig, type GoogleProduct, type OAuth2Client } from './google';

export const STATE_TTL_MS = 10 * 60_000;
const MAX_PENDING = 20;

type AuthUrlOptions = NonNullable<Parameters<OAuth2Client['generateAuthUrl']>[0]>;

const b64url = (buf: Buffer) => buf.toString('base64url');
const hash = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest();

/** RFC 7636 S256: BASE64URL(SHA256(ascii(code_verifier))). */
export const codeChallenge = (verifier: string) => b64url(hash(verifier));

export interface ExchangeResult {
  refreshToken: string | null;
  scopes: string[];
  /** The id_token's address when Google says it is verified, else null. */
  email: string | null;
}

/** The verified address in an id_token's payload, or null. */
export function idTokenEmail(idToken: unknown): string | null {
  if (typeof idToken !== 'string') return null;
  const payload = idToken.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { email?: unknown; email_verified?: unknown };
    const email = typeof claims.email === 'string' ? claims.email.trim() : '';
    return (claims.email_verified === true || claims.email_verified === 'true') && /^[^@\s]{1,64}@[^@\s]{1,255}\.[a-z]{2,}$/i.test(email) ? email : null;
  } catch {
    return null;
  }
}

export interface OAuthFlowOptions {
  config: GoogleOAuthConfig;
  fetch?: FetchLike;
  now?: () => number;
}

export class GoogleOAuthFlow {
  private readonly pending = new Map<string, { verifier: string; product: GoogleProduct; expiresAt: number }>();
  private readonly now: () => number;

  constructor(private readonly o: OAuthFlowOptions) {
    this.now = o.now ?? Date.now;
  }

  private client(): OAuth2Client {
    return oauthClient(this.o.config, this.o.fetch);
  }

  private prune(): void {
    const now = this.now();
    for (const [k, v] of this.pending) if (v.expiresAt <= now) this.pending.delete(k);
    // Oldest first (Map keeps insertion order).
    while (this.pending.size >= MAX_PENDING) this.pending.delete(this.pending.keys().next().value!);
  }

  start(product: GoogleProduct = 'calendar'): { url: string; state: string } {
    this.prune();
    const state = b64url(crypto.randomBytes(32));
    const verifier = b64url(crypto.randomBytes(48));
    this.pending.set(b64url(hash(state)), { verifier, product, expiresAt: this.now() + STATE_TTL_MS });
    const url = this.client().generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: [GOOGLE_PRODUCTS[product].scope, ...(GOOGLE_PRODUCTS[product].extraScopes ?? [])],
      include_granted_scopes: false,
      response_type: 'code',
      state,
      code_challenge: codeChallenge(verifier),
      code_challenge_method: 'S256' as AuthUrlOptions['code_challenge_method'],
    });
    return { url, state };
  }

  /** The code_verifier and product for `state`, at most once and only within the TTL. */
  consume(state: string): { verifier: string; product: GoogleProduct } | null {
    const key = b64url(hash(state));
    const entry = this.pending.get(key);
    if (!entry) return null;
    this.pending.delete(key);
    return entry.expiresAt > this.now() ? { verifier: entry.verifier, product: entry.product } : null;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  async exchange(code: string, verifier: string): Promise<ExchangeResult> {
    try {
      const { tokens } = await this.client().getToken({ code, codeVerifier: verifier });
      return {
        refreshToken: typeof tokens.refresh_token === 'string' && tokens.refresh_token ? tokens.refresh_token : null,
        scopes: typeof tokens.scope === 'string' ? tokens.scope.split(/\s+/).filter(Boolean) : [],
        email: idTokenEmail(tokens.id_token),
      };
    } catch (e) {
      throw mapGoogleError(e);
    }
  }

  async revoke(token: string): Promise<void> {
    try {
      await this.client().revokeToken(token);
    } catch (e) {
      throw mapGoogleError(e);
    }
  }
}
