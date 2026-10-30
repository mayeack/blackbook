/**
 * Email to the owner's own inbox through his Gmail (Google product gmail_send: the gmail.send scope plus openid email,
 * adapters/calendar/google.ts). Used by the weekly event picks (intel/eventPicks/email.ts), which he asked to get
 * "over email every Sunday evening", and the daily brief (delivery/digestEmail.ts, settings digest.email).
 *
 * HARD RULES (enforced here):
 *   1. The only recipient is the connected account's own verified address (secret gmail_send.address, from the
 *      consent's id_token). There is no `to` parameter; From and To are the same address.
 *   2. Subject and headers carry no CR / LF (no header injection); the bodies are base64, so nothing in them can
 *      end a MIME part.
 *   3. The request is POST gmail/v1/users/me/messages/send through guardedFetch, the one Gmail write on the allowlist.
 *   4. Outcomes go to source_health 'gmail_send' (a refused or expired grant reads auth_required); tokens, addresses
 *      and bodies never reach a log.
 * Inert (configured = false, every send 'disabled') until the owner connects "Email me" in Settings → Email & photos,
 * or when the server has no Google OAuth client / SECRETS_KEY.
 */
import { randomBytes } from 'node:crypto';
import { GMAIL_SEND_ADDRESS_SECRET, GoogleApiError, GoogleAuthError, connectedClient, isConnected, mapGoogleError, type FetchLike, type GoogleOAuthConfig } from '../adapters/calendar/google';
import { recordSourceHealth } from '../adapters/common/cursors';
import type { DB } from '../db/connection';
import type { Logger } from '../ops/logger';
import { getSecret } from '../security/secrets';

export const EMAIL_SOURCE = 'gmail_send';
const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

export interface EmailMessage {
  subject: string;
  text: string;
  html: string;
  /** A short tag for the X-Yeackbot header (filters, threading): "event-picks". */
  tag: string;
}

export type EmailResult =
  | { status: 'sent'; messageId: string }
  | { status: 'disabled'; reason: 'not_connected' | 'not_configured' }
  /** auth: only a reconnect helps; retryable: a later try may work (5xx, 429, network). */
  | { status: 'failed'; reason: string; auth: boolean; retryable: boolean };

export interface EmailSender {
  /** Sending is connected and the account's address is known. */
  readonly configured: boolean;
  sendToSelf(m: EmailMessage, o?: { signal?: AbortSignal; now?: number }): Promise<EmailResult>;
}

export const disabledEmailSender: EmailSender = {
  configured: false,
  sendToSelf: async () => ({ status: 'disabled', reason: 'not_configured' }),
};

const ADDRESS = /^[^@\s<>"(),;:]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,}$/i;
const oneLine = (s: string): string => s.replace(/[\r\n\t\f\v\u2028\u2029]+/g, ' ').trim();

/** RFC 2047 encoded-word for a header value with non-ASCII characters (UTF-8, base64, ≤ 75-char words). */
export function encodeHeader(value: string): string {
  const v = oneLine(value);
  if (/^[\x20-\x7e]*$/.test(v)) return v;
  const words: string[] = [];
  let chunk = '';
  // Split on characters (not bytes) so a multi-byte character is never cut; ~45 bytes per word stays under 75.
  for (const ch of v) {
    if (Buffer.byteLength(chunk + ch, 'utf8') > 45) {
      words.push(chunk);
      chunk = '';
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join('\r\n ');
}

const b64Lines = (s: string): string => (Buffer.from(s, 'utf8').toString('base64').match(/.{1,76}/g) ?? ['']).join('\r\n');

/** The RFC 5322 message: From = To = the owner's address, multipart/alternative (plain text, then HTML). */
export function buildMime(address: string, m: EmailMessage, o: { now: number; boundary?: string; messageIdHost?: string }): string {
  if (!ADDRESS.test(address)) throw new Error('email: not a plain address');
  const boundary = o.boundary ?? `yb_${randomBytes(12).toString('hex')}`;
  const domain = address.split('@')[1]!;
  const headers = [
    `From: yeackbot <${address}>`,
    `To: <${address}>`,
    `Subject: ${encodeHeader(m.subject)}`,
    `Date: ${new Date(o.now).toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${randomBytes(12).toString('hex')}.${o.now}@${o.messageIdHost ?? domain}>`,
    'MIME-Version: 1.0',
    'Auto-Submitted: auto-generated',
    `X-Yeackbot: ${oneLine(m.tag).replace(/[^a-z0-9-]/gi, '').slice(0, 40) || 'mail'}`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const part = (type: string, body: string) => [`--${boundary}`, `Content-Type: ${type}; charset="UTF-8"`, 'Content-Transfer-Encoding: base64', '', b64Lines(body)].join('\r\n');
  return [...headers, '', part('text/plain', m.text), part('text/html', m.html), `--${boundary}--`, ''].join('\r\n');
}

export interface EmailSenderDeps {
  db: DB;
  secretsKey: Buffer | null;
  google: GoogleOAuthConfig | null;
  /** Tests pass a fetch bound to an undici MockAgent. */
  fetch?: FetchLike;
  log?: Logger;
}

/** The owner's own address for sending, or null (not connected, or the secret can't be read). */
export function sendAddress(db: DB, secretsKey: Buffer | null): string | null {
  if (!secretsKey || !isConnected(db, 'gmail_send')) return null;
  try {
    const a = getSecret(db, secretsKey, GMAIL_SEND_ADDRESS_SECRET);
    return a && ADDRESS.test(a) ? a : null;
  } catch {
    return null;
  }
}

export function createEmailSender(d: EmailSenderDeps): EmailSender {
  if (!d.google || !d.secretsKey) return disabledEmailSender;
  const google = d.google;
  const key = d.secretsKey;
  return {
    get configured() {
      return sendAddress(d.db, key) !== null;
    },
    async sendToSelf(m, o = {}) {
      const now = o.now ?? Date.now();
      const address = sendAddress(d.db, key);
      const client = address ? connectedClient(d.db, key, google, d.fetch, 'gmail_send') : null;
      if (!address || !client) return { status: 'disabled', reason: 'not_connected' };
      const raw = Buffer.from(buildMime(address, m, { now }), 'utf8').toString('base64url');
      try {
        const res = await client.request<{ id?: unknown }>({ url: SEND_URL, method: 'POST', data: { raw }, responseType: 'json', signal: o.signal });
        const id = typeof res.data?.id === 'string' ? res.data.id.slice(0, 64) : 'unknown';
        recordSourceHealth(d.db, EMAIL_SOURCE, now, 'ok', { error: null, newestDataAt: now, details: { connected: true } });
        d.log?.info('email.sent', { route: m.tag });
        return { status: 'sent', messageId: id };
      } catch (e) {
        const err = mapGoogleError(e);
        const status = err instanceof GoogleApiError ? err.status : null;
        const reason = err instanceof GoogleApiError || err instanceof GoogleAuthError ? err.reason : err.name;
        const auth = err instanceof GoogleAuthError || (status === 403 && /insufficient|SCOPE/i.test(reason));
        const retryable = !auth && (status === null || status === 429 || status >= 500);
        recordSourceHealth(d.db, EMAIL_SOURCE, now, auth ? 'auth_required' : 'error', {
          error: auth ? 'Email sending expired or was revoked: connect "Email me" again in Settings.' : status === 403 ? 'The Gmail API is not enabled in the Google Cloud project.' : 'The last email failed to send.',
          newestDataAt: null,
          details: { connected: true },
        });
        d.log?.warn('email.send_failed', { route: m.tag, error_code: reason, status: status ?? undefined });
        return { status: 'failed', reason, auth, retryable };
      }
    },
  };
}
