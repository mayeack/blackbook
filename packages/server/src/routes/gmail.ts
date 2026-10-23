/**
 * The Gmail ticket source's connection (design docs/design/tickets-met-at.md "1. Gmail source and ticket ledger";
 * DTOs in @yb/shared api/tickets.ts). Connecting is GET /google/connect?product=gmail (routes/google.ts), which
 * lands back on /settings?gmail=connected|denied|expired|scope|error. Behind Cloudflare Access; POSTs need JSON +
 * X-YB (http/csrf.ts).
 *
 *   GET  /gmail/status       → GmailStatus             connected?, needs reconnecting?, health, and counts from
 *                                                      gmail_messages / ticket_events
 *   POST /gmail/disconnect   {deleteData?} → GmailDisconnectResult
 *        Deletes the gmail token, its cursors and health; revokes the shared Google grant only when Calendar and
 *        Photos hold no token either (routes/googleProducts.ts). With deleteData also every gmail_messages,
 *        ticket_parties and ticket_events row. Occasions are not touched here: their ticket copies retire on the
 *        next occasions pass.
 *
 * Every path answers 503 GOOGLE_NOT_CONFIGURED until GOOGLE_CLIENT_ID/SECRET are set. Counts only: no subject,
 * sender, name or token leaves this module or reaches a log.
 */
import { Router } from 'express';
import { GoogleProductDisconnect, type GmailCounts, type GmailDisconnectResult, type GmailStatus } from '@yb/shared';
import { connectedAt, isConnected, type FetchLike } from '../adapters/calendar/google';
import { GoogleOAuthFlow } from '../adapters/calendar/oauth';
import { deleteGmailData } from '../adapters/gmail/ledger';
import type { DB } from '../db/connection';
import { tx } from '../db/tx';
import { PRODUCT_SOURCE } from './google';
import { disconnectGoogleProduct, googleNotConfigured, healthView } from './googleProducts';
import type { RouteDeps } from './index';

export const GMAIL_SOURCE = PRODUCT_SOURCE.gmail;

export function gmailCounts(db: DB, now: number): GmailCounts {
  const m = db
    .prepare(
      `SELECT count(*) AS scanned,
              coalesce(sum(triage = 'candidate'), 0) AS ticket_emails,
              coalesce(sum(triage = 'candidate' AND parse_status = 'parsed'), 0) AS parsed,
              coalesce(sum(triage = 'candidate' AND parse_status IN ('pending', 'queued')), 0) AS pending
       FROM gmail_messages`,
    )
    .get() as { scanned: number; ticket_emails: number; parsed: number; pending: number };
  const t = db
    .prepare(
      `SELECT count(*) AS events, coalesce(sum(status = 'holding' AND coalesce(ends_at, starts_at) >= ?), 0) AS upcoming
       FROM ticket_events WHERE merged_into_id IS NULL`,
    )
    .get(now) as { events: number; upcoming: number };
  return { scanned: m.scanned, ticketEmails: m.ticket_emails, parsed: m.parsed, pending: m.pending, events: t.events, upcoming: t.upcoming };
}

export function gmailStatus(db: DB, secretsAvailable: boolean, now = Date.now()): GmailStatus {
  const health = healthView(db, GMAIL_SOURCE);
  const connected = isConnected(db, 'gmail');
  return {
    configured: true,
    secretsAvailable,
    connected,
    connectedAt: connectedAt(db, 'gmail'),
    needsReconnect: connected && health?.status === 'auth_required',
    lastSyncAt: health?.lastOkAt ?? null,
    health,
    counts: gmailCounts(db, now),
  };
}

/**
 * Deletes everything the ticket source stored (bodies were never stored), in one transaction: adapters/gmail/ledger.ts
 * deleteGmailData. Ticket occasions retire on the next occasions pass.
 */
export function deleteGmailRecords(db: DB): { messages: number; tickets: number; parties: number } {
  const d = tx(db, () => deleteGmailData(db));
  return { messages: d.messages, tickets: d.events, parties: d.parties };
}

export interface GmailRouterOptions {
  /** Tests pass a fetch bound to an undici MockAgent (the revoke call). */
  fetch?: FetchLike;
  now?: () => number;
}

export function createGmailRouter({ db, log, config }: RouteDeps, o: GmailRouterOptions = {}): Router {
  const r = Router();
  const google = config?.google ?? null;
  const secretsKey = config?.secretsKey ?? null;
  const now = o.now ?? Date.now;
  const flow = google ? new GoogleOAuthFlow({ config: google, fetch: o.fetch, now }) : null;

  r.use('/gmail', (_req, res, next) => {
    if (!flow) return googleNotConfigured(res);
    next();
  });

  r.get('/gmail/status', (_req, res) => {
    res.json(gmailStatus(db, secretsKey !== null, now()) satisfies GmailStatus);
  });

  r.post('/gmail/disconnect', async (req, res) => {
    const body = GoogleProductDisconnect.parse(req.body ?? {});
    const out = await disconnectGoogleProduct(db, 'gmail', { flow, secretsKey, log, now: now() });
    const deleted = body.deleteData ? deleteGmailRecords(db) : null;
    if (out.had || deleted)
      log.info('gmail.disconnected', {
        counts: { revoked: out.revoked ? 1 : 0, all: out.all ? 1 : 0, ...(deleted ? { deleted_messages: deleted.messages, deleted_tickets: deleted.tickets } : {}) },
      });
    res.json({ connected: false, revoked: out.revoked, ...(deleted ? { deleted } : {}) } satisfies GmailDisconnectResult);
  });

  return r;
}

export function gmailRoutes(deps: RouteDeps): Router {
  return createGmailRouter(deps);
}
