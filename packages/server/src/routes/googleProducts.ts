/**
 * Disconnecting one Google product: calendar, gmail, photos or gmail_send (design docs/design/tickets-met-at.md "Review
 * amendments → Disconnect"). The products share one OAuth client and Google's revoke drops the client's whole
 * grant, so:
 *   - a product's disconnect deletes only that product's secret and cursors, and sets only its health row to
 *     'disabled' (details.connected false: the Sources card offers to connect again);
 *   - the grant is revoked (best effort) only when no other product's secret remains;
 *   - whenever revoke runs, every product's secrets are deleted and every health row set to 'disabled'.
 * Each route adds its own deleteData on top. Tokens are never logged or returned.
 */
import type { Response } from 'express';
import type { ApiError, SourceHealthView } from '@yb/shared';
import { GOOGLE_PRODUCTS, isConnected, type GoogleProduct } from '../adapters/calendar/google';
import type { GoogleOAuthFlow } from '../adapters/calendar/oauth';
import { recordSourceHealth } from '../adapters/common/cursors';
import type { DB } from '../db/connection';
import { errorFields, type Logger } from '../ops/logger';
import { redact } from '../ops/redact';
import { deleteSecret, getSecret } from '../security/secrets';
import { PRODUCT_SOURCE } from './google';

const PRODUCTS = Object.keys(GOOGLE_PRODUCTS) as GoogleProduct[];

/** The answer of every Google product path until GOOGLE_CLIENT_ID/SECRET are set (as /google/* answers). */
export function googleNotConfigured(res: Response): void {
  const body: ApiError = { error: { code: 'GOOGLE_NOT_CONFIGURED', message: 'Google OAuth client not configured' } };
  res.status(503).json(body);
}

/** A source's health row for a status answer (error text redacted). */
export function healthView(db: DB, source: string): SourceHealthView | null {
  const h = db.prepare('SELECT status, last_ok_at, last_error, checked_at FROM source_health WHERE source = ?').get(source) as
    | { status: string; last_ok_at: number | null; last_error: string | null; checked_at: number }
    | undefined;
  return h ? { status: h.status, lastOkAt: h.last_ok_at, lastError: h.last_error && redact(h.last_error), checkedAt: h.checked_at } : null;
}

/** A connected product's problem worth a line (errors only; a refused grant is the Reconnect box instead). */
export function healthProblemText(h: SourceHealthView | null): string | null {
  if (!h || (h.status !== 'error' && h.status !== 'contract_broken')) return null;
  return h.lastError?.trim() || 'The last try failed.';
}

/** The health line each product's Sources card shows once it is disconnected. */
export const NOT_CONNECTED: Readonly<Record<GoogleProduct, string>> = {
  calendar: 'Google Calendar is not connected.',
  gmail: 'Gmail is not connected.',
  photos: 'Google Photos is not connected.',
  gmail_send: 'Email sending is not connected.',
};

/** Log event prefix per product (calendar keeps its historical 'gcal.*' names). */
export const LOG_PREFIX: Readonly<Record<GoogleProduct, string>> = { calendar: 'gcal', gmail: 'gmail', photos: 'gphotos', gmail_send: 'gmail_send' };

export interface ProductDisconnect {
  /** Google confirmed the revocation. */
  revoked: boolean;
  /** This product had a stored token. */
  had: boolean;
  /** Revoke ran (whatever Google answered): every product is now disconnected. */
  all: boolean;
}

export interface DisconnectOptions {
  flow: Pick<GoogleOAuthFlow, 'revoke'> | null;
  secretsKey: Buffer | null;
  log: Logger;
  now: number;
}

/** The other products that still hold a refresh token. */
export const otherConnected = (db: DB, product: GoogleProduct): GoogleProduct[] => PRODUCTS.filter((p) => p !== product && isConnected(db, p));

export async function disconnectGoogleProduct(db: DB, product: GoogleProduct, o: DisconnectOptions): Promise<ProductDisconnect> {
  const secret = GOOGLE_PRODUCTS[product].secret;
  let token: string | null = null;
  if (otherConnected(db, product).length === 0) {
    try {
      token = o.secretsKey ? getSecret(db, o.secretsKey, secret) : null;
    } catch {
      // Undecryptable (SECRETS_KEY changed): it can't be revoked from here, but it is still removed below.
    }
  }
  const all = token !== null && o.flow !== null;
  let revoked = false;
  if (all) {
    try {
      await o.flow!.revoke(token!);
      revoked = true;
    } catch (e) {
      o.log.warn(`${LOG_PREFIX[product]}.revoke_failed`, { error_class: errorFields(e).error_class, status: (e as { status?: number }).status ?? undefined });
    }
  }
  const had = deleteSecret(db, secret);
  if (GOOGLE_PRODUCTS[product].addressSecret) deleteSecret(db, GOOGLE_PRODUCTS[product].addressSecret!);
  // Cursors belong to the old grant's view of the account; a reconnect starts over.
  db.prepare('DELETE FROM source_cursors WHERE source = ?').run(PRODUCT_SOURCE[product]);
  for (const p of all ? PRODUCTS : [product]) {
    if (p !== product) {
      deleteSecret(db, GOOGLE_PRODUCTS[p].secret);
      if (GOOGLE_PRODUCTS[p].addressSecret) deleteSecret(db, GOOGLE_PRODUCTS[p].addressSecret!);
    }
    recordSourceHealth(db, PRODUCT_SOURCE[p], o.now, 'disabled', { error: NOT_CONNECTED[p], newestDataAt: null, details: { connected: false } });
  }
  return { revoked, had, all };
}
