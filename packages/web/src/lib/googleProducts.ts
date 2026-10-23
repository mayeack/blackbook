/**
 * Settings → Email & photos: wording for the Gmail and Google Photos panels (routes/gmail.ts, routes/gphotos.ts;
 * shapes in @yb/shared api/tickets.ts). Each product is its own Google consent: /google/callback lands on
 * /settings?gmail=<outcome> or ?gphotos=<outcome>. Pure helpers, unit-tested.
 */
import type { GmailStatus, GphotosSessionView, GphotosStatus, SourceHealthView } from '@yb/shared';
import { safeHttpsUrl } from './events';
import { plural } from './format';

export type GoogleProductKey = 'gmail' | 'gphotos';

const NAMES: Record<GoogleProductKey, string> = { gmail: 'Gmail', gphotos: 'Google Photos' };

const CONNECTED: Record<GoogleProductKey, string> = {
  gmail: 'Gmail connected. yeackbot looks for ticket emails within 30 minutes, then works back through the last three years.',
  gphotos: 'Google Photos connected. Pick your contact screenshots below; yeackbot only ever sees the photos you pick.',
};

const SCOPE: Record<GoogleProductKey, string> = {
  gmail: 'yeackbot needs read access to your email. Connect again and allow “View your email messages and settings”.',
  gphotos: 'yeackbot needs access to the photos you pick. Connect again and allow it.',
};

/** How /google/callback went for this product (`?gmail=` / `?gphotos=`), or null when there is nothing to say. */
export function productOutcome(product: GoogleProductKey, v: string | null): { tone: 'ok' | 'bad'; text: string } | null {
  const name = NAMES[product];
  switch (v) {
    case null:
    case '':
      return null;
    case 'connected':
      return { tone: 'ok', text: CONNECTED[product] };
    case 'denied':
      return { tone: 'bad', text: `${name} access was declined, so nothing was connected.` };
    case 'expired':
      return { tone: 'bad', text: 'That sign-in took too long. Connect again.' };
    case 'scope':
      return { tone: 'bad', text: SCOPE[product] };
    default:
      return { tone: 'bad', text: `${name} couldn’t be connected. Try again in a minute.` };
  }
}

/** What the panels show while the server has no Google OAuth client (503 GOOGLE_NOT_CONFIGURED). */
export function gmailNotConfigured(): GmailStatus {
  return {
    configured: false,
    secretsAvailable: true,
    connected: false,
    connectedAt: null,
    needsReconnect: false,
    lastSyncAt: null,
    health: null,
    counts: { scanned: 0, ticketEmails: 0, parsed: 0, pending: 0, events: 0, upcoming: 0 },
  };
}

export function gphotosNotConfigured(): GphotosStatus {
  return {
    configured: false,
    secretsAvailable: true,
    connected: false,
    connectedAt: null,
    needsReconnect: false,
    health: null,
    lastPickAt: null,
    counts: { screenshots: 0, linked: 0, pendingOcr: 0 },
    session: null,
  };
}

/** "14 ticket emails · 6 events (2 coming up) · 3 waiting to be read". */
export function gmailSummary(s: Pick<GmailStatus, 'counts'>): string {
  const c = s.counts;
  if (c.scanned === 0) return 'No ticket emails found yet.';
  const parts = [plural(c.ticketEmails, 'ticket email'), `${plural(c.events, 'event')}${c.upcoming ? ` (${c.upcoming} coming up)` : ''}`];
  if (c.pending) parts.push(`${c.pending} waiting to be read`);
  return parts.join(' · ');
}

/** "9 screenshots · 6 linked to people · 2 waiting for the Mac". */
export function gphotosSummary(s: Pick<GphotosStatus, 'counts'>): string {
  const c = s.counts;
  if (c.screenshots === 0) return 'No screenshots picked yet.';
  const parts = [plural(c.screenshots, 'screenshot'), `${c.linked} linked to people`];
  if (c.pendingOcr) parts.push(`${c.pendingOcr} waiting for the Mac helper`);
  return parts.join(' · ');
}

/**
 * A connected product's problem worth a line in its panel ("The Gmail API is not enabled…", "Update the collector…"),
 * from its health row: errors only (a refused grant is the Reconnect box instead; a stale or quiet source is fine).
 */
export function healthProblem(h: SourceHealthView | null | undefined): string | null {
  if (!h || (h.status !== 'error' && h.status !== 'contract_broken')) return null;
  return h.lastError?.trim() || (h.status === 'contract_broken' ? 'Google answered in an unexpected shape; yeackbot paused rather than guess.' : 'The last check failed.');
}

/** The Picker page to open in a new tab: Google's https URL + '/autoclose' (the tab closes itself when done). */
export function pickerLink(pickerUri: string): string | null {
  const url = safeHttpsUrl(pickerUri);
  if (!url) return null;
  const u = new URL(url);
  if (!/(^|\.)google\.com$/i.test(u.hostname)) return null;
  u.pathname = `${u.pathname.replace(/\/+$/, '')}/autoclose`;
  return u.toString();
}

/** A session still moving: the web keeps polling it. */
export const sessionActive = (s: Pick<GphotosSessionView, 'status' | 'itemsNew' | 'processed'>): boolean =>
  s.status === 'open' || s.status === 'picked' || (s.status === 'done' && s.processed < s.itemsNew);

/** One line of progress for a picker session. */
export function sessionProgress(s: Pick<GphotosSessionView, 'status' | 'itemsTotal' | 'itemsNew' | 'processed' | 'linked'>): string {
  switch (s.status) {
    case 'open':
      return 'Waiting for your picks in the Google Photos tab…';
    case 'picked':
      return s.itemsTotal ? `Downloading ${plural(s.itemsTotal, 'photo')}…` : 'Downloading your picks…';
    case 'done': {
      if (s.itemsTotal === 0) return 'Nothing was picked.';
      const seen = s.itemsTotal - s.itemsNew;
      const head = s.itemsNew ? plural(s.itemsNew, 'new screenshot') : 'No new screenshots';
      const tail = seen > 0 ? ` (${seen} already read)` : '';
      if (s.processed < s.itemsNew) return `${head}${tail} · reading ${s.processed} of ${s.itemsNew} on the Mac…`;
      return `${head}${tail} · ${plural(s.linked, 'person', 'people')} linked`;
    }
    case 'expired':
      return 'The pick expired before anything was chosen. Start again.';
    case 'cancelled':
      return 'The pick was cancelled.';
    case 'failed':
      return 'Google Photos didn’t hand over the picks. Try again.';
  }
}
