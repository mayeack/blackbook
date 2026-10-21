/**
 * In-memory Gmail (OAuth token refresh + Gmail API v1 messages.list / messages.get) behind an undici MockAgent with
 * net connect disabled: nothing reaches the network. messages.list evaluates the parts of Gmail's query language the
 * source uses (after: / before: epoch seconds, -in:sent / -in:drafts / -in:chats, {…} OR groups of from:, subject:
 * and filename: terms; groups AND together), newest first, paged. Bodies are built at runtime with base64url.
 * Synthetic data only: invented names, *.example / *.test domains, sender addresses assembled at runtime.
 */
import { MockAgent, fetch as undiciFetch } from 'undici';
import { GMAIL_SCOPE, type FetchLike } from '../../../src/adapters/calendar/google';

export const CLIENT = {
  clientId: 'test-client-id.apps.example',
  clientSecret: 'test-client-secret',
  redirectUri: 'https://yeackbot.example/api/v1/google/callback',
};
export const REFRESH_TOKEN = 'test-refresh-token-gmail';

/** Sender addresses, assembled so no literal address appears in the source. */
export const addr = (local: string, domain: string) => `${local}${'@'}${domain}`;
export const VENDOR_DOMAIN = 'tickets.example';
export const VENDOR_FROM = `Tickets Example <${addr('noreply', VENDOR_DOMAIN)}>`;
export const RESALE_FROM = `StubHub <${addr('orders', 'stubhub.com')}>`;
export const FRIEND_FROM = `Rowan Quill <${addr('rowan.quill', 'example.com')}>`;
export const OWNER_EMAIL = addr('sam.owner', 'example.com');

export interface MailSpec {
  id?: string;
  threadId?: string;
  at: number;
  from: string;
  subject: string;
  text?: string;
  html?: string;
  labelIds?: string[];
  attachments?: { filename: string; mimeType: string }[];
}

interface Stored {
  spec: MailSpec;
  id: string;
  threadId: string;
}

export interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
}

const json = (statusCode: number, data: unknown) => ({ statusCode, data: JSON.stringify(data), responseOptions: { headers: { 'content-type': 'application/json' } } });
const apiError = (code: number, reason: string, status = 'PERMISSION_DENIED') => json(code, { error: { code, message: 'error', status, errors: [{ domain: 'global', reason, message: 'error' }] } });

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

/** The full MIME payload of a message (text / html alternatives, attachments as separate parts). */
export function payloadOf(m: MailSpec): Record<string, unknown> {
  const headers = [
    { name: 'From', value: m.from },
    { name: 'Subject', value: m.subject },
    { name: 'Date', value: new Date(m.at).toUTCString() },
  ];
  const bodies: Record<string, unknown>[] = [];
  if (m.text !== undefined) bodies.push({ partId: '0.0', mimeType: 'text/plain', filename: '', body: { size: m.text.length, data: b64(m.text) } });
  if (m.html !== undefined) bodies.push({ partId: '0.1', mimeType: 'text/html', filename: '', body: { size: m.html.length, data: b64(m.html) } });
  const alt = bodies.length === 1 ? bodies[0]! : { partId: '0', mimeType: 'multipart/alternative', filename: '', body: { size: 0 }, parts: bodies };
  if (!m.attachments?.length) return { ...alt, partId: '', headers };
  const atts = m.attachments.map((a, i) => ({ partId: String(i + 1), mimeType: a.mimeType, filename: a.filename, body: { size: 1200, attachmentId: `att${i + 1}` } }));
  return { partId: '', mimeType: 'multipart/mixed', filename: '', headers, body: { size: 0 }, parts: [alt, ...atts] };
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (Array.isArray(headers)) {
    for (let i = 0; i < headers.length; i += 2) if (String(headers[i]).toLowerCase() === name) return String(headers[i + 1]);
    return undefined;
  }
  const rec = headers as Record<string, string | string[]>;
  const key = Object.keys(rec).find((k) => k.toLowerCase() === name);
  const v = key ? rec[key] : undefined;
  return Array.isArray(v) ? v[0] : v;
}

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9'’]+/).filter(Boolean);

/** Gmail's query subset (see the header). */
export function matches(q: string, m: MailSpec): boolean {
  const tokens = q.match(/-?\{[^}]*\}|-?[a-z]+:"[^"]*"|-?[a-z]+:\S+/g) ?? [];
  const labels = m.labelIds ?? ['INBOX'];
  const term = (t: string): boolean => {
    const [, key, raw] = /^([a-z]+):(.*)$/.exec(t) ?? [];
    const value = (raw ?? '').replace(/^"|"$/g, '').toLowerCase();
    if (key === 'from') return m.from.toLowerCase().includes(value);
    if (key === 'subject') {
      const sw = words(m.subject).join(' ');
      return ` ${sw} `.includes(` ${words(value).join(' ')} `);
    }
    if (key === 'filename') return (m.attachments ?? []).some((a) => a.filename.toLowerCase().endsWith(`.${value}`));
    return false;
  };
  for (const tok of tokens) {
    const neg = tok.startsWith('-');
    const t = neg ? tok.slice(1) : tok;
    let ok: boolean;
    if (t.startsWith('{')) ok = (t.slice(1, -1).match(/[a-z]+:"[^"]*"|[a-z]+:\S+/g) ?? []).some(term);
    else if (t.startsWith('after:')) ok = m.at >= Number(t.slice(6)) * 1000;
    else if (t.startsWith('before:')) ok = m.at < Number(t.slice(7)) * 1000;
    else if (t.startsWith('in:')) ok = labels.includes({ sent: 'SENT', drafts: 'DRAFT', chats: 'CHAT' }[t.slice(3)] ?? t.slice(3).toUpperCase());
    else ok = term(t);
    if (neg ? ok : !ok) return false;
  }
  return true;
}

export class FakeGmail {
  readonly agent = new MockAgent();
  readonly calls: Call[] = [];
  readonly messages = new Map<string, Stored>();
  readonly refreshTokens = new Set<string>([REFRESH_TOKEN]);
  /** HTTP failure for every Gmail call (status + reason). */
  failAll: { status: number; reason: string } | null = null;
  /** Message id → HTTP status for messages.get. */
  readonly failGet = new Map<string, number>();
  /** Message ids whose format=full answer breaks the contract (internalDate not a number). */
  readonly badFull = new Set<string>();
  pageSize: number | null = null;
  private readonly accessTokens = new Set<string>();
  private issued = 0;
  private seq = 0;

  constructor() {
    this.agent.disableNetConnect();
    this.agent
      .get('https://oauth2.googleapis.com')
      .intercept({ path: () => true, method: 'POST' })
      .reply((o) => this.oauth(o.path, String(o.body ?? '')))
      .persist();
    this.agent
      .get('https://gmail.googleapis.com')
      .intercept({ path: () => true, method: 'GET' })
      .reply((o) => this.api(o.path, headerValue(o.headers, 'authorization')))
      .persist();
  }

  readonly fetch: FetchLike = (input, init) =>
    undiciFetch(input as URL, { ...(init as object), dispatcher: this.agent } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;

  async close(): Promise<void> {
    await this.agent.close();
  }

  /** Adds a message; returns its id (16 hex-ish chars, like Gmail's). */
  add(spec: MailSpec): string {
    const id = spec.id ?? `19f${String(++this.seq).padStart(13, '0')}`;
    this.messages.set(id, { spec, id, threadId: spec.threadId ?? id });
    return id;
  }

  callsTo(re: RegExp): Call[] {
    return this.calls.filter((c) => re.test(c.path));
  }

  private oauth(path: string, rawBody: string) {
    const url = new URL(path, 'https://oauth2.googleapis.com');
    this.calls.push({ method: 'POST', path: url.pathname, query: url.searchParams });
    const body = new URLSearchParams(rawBody);
    if (url.pathname !== '/token') return json(404, { error: 'not_found' });
    if (body.get('grant_type') !== 'refresh_token') return json(400, { error: 'unsupported_grant_type' });
    if (!this.refreshTokens.has(body.get('refresh_token') ?? '')) return json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
    const t = `test-access-gmail-${++this.issued}`;
    this.accessTokens.add(t);
    return json(200, { access_token: t, expires_in: 3599, token_type: 'Bearer', scope: GMAIL_SCOPE });
  }

  private api(path: string, authorization: string | undefined) {
    const url = new URL(path, 'https://gmail.googleapis.com');
    this.calls.push({ method: 'GET', path: url.pathname, query: url.searchParams });
    const bearer = authorization?.replace(/^Bearer /, '');
    if (!bearer || !this.accessTokens.has(bearer)) return apiError(401, 'authError', 'UNAUTHENTICATED');
    if (this.failAll) return apiError(this.failAll.status, this.failAll.reason);
    if (url.pathname === '/gmail/v1/users/me/messages') {
      const q = url.searchParams.get('q') ?? '';
      const size = this.pageSize ?? Number(url.searchParams.get('maxResults') ?? 100);
      const all = [...this.messages.values()].filter((m) => matches(q, m.spec)).sort((a, b) => b.spec.at - a.spec.at || b.id.localeCompare(a.id));
      const offset = Number(url.searchParams.get('pageToken')?.replace(/^p/, '') ?? 0);
      const page = all.slice(offset, offset + size);
      const more = offset + size < all.length;
      return json(200, { messages: page.length ? page.map((m) => ({ id: m.id, threadId: m.threadId })) : undefined, resultSizeEstimate: all.length, ...(more ? { nextPageToken: `p${offset + size}` } : {}) });
    }
    const m = /^\/gmail\/v1\/users\/me\/messages\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
    if (!m) return apiError(404, 'notFound', 'NOT_FOUND');
    const failure = this.failGet.get(m[1]!);
    if (failure) return apiError(failure, failure === 404 ? 'notFound' : 'backendError', 'X');
    const stored = this.messages.get(m[1]!);
    if (!stored) return apiError(404, 'notFound', 'NOT_FOUND');
    const payload = payloadOf(stored.spec);
    const base = { id: stored.id, threadId: stored.threadId, labelIds: stored.spec.labelIds ?? ['INBOX'], snippet: '', internalDate: String(stored.spec.at), sizeEstimate: 4000 };
    if (url.searchParams.get('format') === 'metadata') {
      const wanted = url.searchParams.getAll('metadataHeaders').map((h) => h.toLowerCase());
      const headers = (payload.headers as { name: string; value: string }[]).filter((h) => wanted.includes(h.name.toLowerCase()));
      return json(200, { ...base, payload: { partId: '', mimeType: payload.mimeType, filename: '', headers } });
    }
    if (this.badFull.has(stored.id)) return json(200, { ...base, internalDate: 'not-a-date', payload });
    return json(200, { ...base, payload });
  }
}

/** A Ticketmaster-style HTML-only order with JSON-LD (underName, ticketToken and reservationNumber included). */
export function orderHtml(o: { seats?: number; date?: string; title?: string } = {}): string {
  const ld = {
    '@context': 'http://schema.org',
    '@type': 'EventReservation',
    reservationNumber: '12-34567/NY',
    underName: { '@type': 'Person', name: 'Sam Varga' },
    ticketToken: 'qrCode:ZXQ7Y81',
    ticketNumber: 'TKT-55-01',
    ...(o.seats ? { numSeats: String(o.seats) } : {}),
    reservationFor: {
      '@type': 'MusicEvent',
      name: o.title ?? 'Lumen Arcade: Night Signals Tour',
      startDate: o.date ?? '2026-11-07T20:00:00-05:00',
      url: 'https://www.ticketmaster.com/lumen-arcade-night-signals/event/0B00ABCD12345678',
      location: { '@type': 'Place', name: 'The Copper Hall', address: { '@type': 'PostalAddress', streetAddress: '100 Main St', addressLocality: 'Springfield' } },
      performer: [{ '@type': 'MusicGroup', name: 'Lumen Arcade' }, { '@type': 'Person', name: 'Halcy Drift' }],
    },
  };
  return `<!doctype html><html><head><title>Your order</title><style>.hero{color:#123456}</style>
<script type="application/ld+json">${JSON.stringify(ld)}</script></head>
<body><div style="display:none">Preheader&#8203;&zwnj;&nbsp;</div>
<table><tr><td>Hi Sam,</td></tr>
<tr><td>You&rsquo;re going! Order #&nbsp;12-34567/NY</td></tr>
<tr><td><a href="https://www.ticketmaster.com/lumen-arcade-night-signals/event/0B00ABCD12345678">Lumen Arcade &amp; Halcy Drift</a></td></tr>
<tr><td>Sat, Nov 7 &middot; 8:00 PM</td><td>The Copper Hall, Springfield</td></tr>
<tr><td>Sec 101, Row F, Seats 7-8</td></tr>
<tr><td>Ticket holder: Sam Varga</td></tr>
<tr><td>Billing name</td></tr><tr><td>Sam Varga</td></tr>
<tr><td>Questions? Call 212-555-0123 or write to ${addr('help', 'tickets.example')}</td></tr>
<tr><td>You might also like: <a href="https://www.ticketmaster.com/other-show/event/1C00FFEE00000001">Other Show</a></td></tr>
<tr><td>Invite friends: <a href="https://partiful.com/e/AbCdEf123456">party</a></td></tr>
</table></body></html>`;
}
