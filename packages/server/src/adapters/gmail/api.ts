/**
 * Gmail API v1, read-only (design docs/design/tickets-met-at.md §1 "Access"): messages.list and messages.get only,
 * through the Gmail product's own OAuth client (adapters/calendar/google.ts connectedClient(…, 'gmail')), whose
 * guardedFetch refuses anything but GET on /gmail/v1/users/me/(profile|messages[/<id>]). Nothing here can modify,
 * send, trash or watch.
 *   - Requests go through OAuth2Client.request (the googleapis gmail module is never loaded: it costs startup time and
 *     the two calls need no generated client). Query strings are built here, so repeated parameters
 *     (metadataHeaders) keep their form.
 *   - Errors become the calendar adapter's GoogleAuthError / GoogleApiError (mapGoogleError: status + a short reason
 *     token such as insufficientPermissions); the GaxiosError (which holds the tokens) is dropped.
 *   - Responses are validated with zod; a mismatch is GoogleContractError (paths only, never values).
 * Quota (units): list 5, get metadata 20 (charged as 5 by Google, budgeted at 20), get full 60.
 */
import { z } from 'zod';
import { GoogleContractError, mapGoogleError, type OAuth2Client } from '../calendar/google';

export const GMAIL_ORIGIN = 'https://gmail.googleapis.com';
const BASE = `${GMAIL_ORIGIN}/gmail/v1/users/me`;

/** One MIME part of a message (format=full), with its sub-parts. Bodies are base64url. */
export interface GmailPart {
  partId?: string | null;
  mimeType?: string | null;
  filename?: string | null;
  headers?: { name: string; value: string }[] | null;
  body?: { size?: number | null; data?: string | null; attachmentId?: string | null } | null;
  parts?: GmailPart[] | null;
}

const Header = z.object({ name: z.string(), value: z.string() });
const Part: z.ZodType<GmailPart> = z.lazy(() =>
  z.object({
    partId: z.string().nullish(),
    mimeType: z.string().nullish(),
    filename: z.string().nullish(),
    headers: z.array(Header).nullish(),
    body: z.object({ size: z.number().nullish(), data: z.string().nullish(), attachmentId: z.string().nullish() }).nullish(),
    parts: z.array(Part).nullish(),
  }),
);

const MessageRef = z.object({ id: z.string().min(1).max(64), threadId: z.string().min(1).max(64) });
const ListPage = z.object({
  messages: z.array(MessageRef).nullish(),
  nextPageToken: z.string().nullish(),
  resultSizeEstimate: z.number().nullish(),
});
const Message = z.object({
  id: z.string().min(1).max(64),
  threadId: z.string().min(1).max(64),
  labelIds: z.array(z.string()).nullish(),
  internalDate: z.string().regex(/^\d{1,16}$/),
  payload: Part.nullish(),
});

export interface GmailMessageRef {
  id: string;
  threadId: string;
}

export interface GmailListPage {
  messages: GmailMessageRef[];
  nextPageToken: string | null;
}

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  /** Gmail's internalDate (ms). */
  internalAt: number;
  payload: GmailPart | null;
}

/** The headers the triage reads (format=metadata). */
export const METADATA_HEADERS = ['From', 'Subject'] as const;

export interface GmailApi {
  /** messages.list (newest first). */
  listMessages(q: { q: string; maxResults: number; pageToken?: string | null }, signal?: AbortSignal): Promise<GmailListPage>;
  /** messages.get: 'metadata' (From/Subject headers, labels, internalDate) or 'full' (every part). */
  getMessage(id: string, format: 'metadata' | 'full', signal?: AbortSignal): Promise<GmailMessage>;
}

function parse<S extends z.ZodType>(route: string, schema: S, data: unknown): z.output<S> {
  const r = schema.safeParse(data);
  if (!r.success) throw new GoogleContractError(route, [...new Set(r.error.issues.map((i) => i.path.join('.') || 'root'))]);
  return r.data;
}

async function get(client: OAuth2Client, url: string, signal?: AbortSignal): Promise<unknown> {
  try {
    const res = await client.request<unknown>({ url, method: 'GET', responseType: 'json', signal });
    return res.data;
  } catch (e) {
    throw mapGoogleError(e);
  }
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export function gmailApi(client: OAuth2Client): GmailApi {
  return {
    async listMessages(q, signal) {
      const params = new URLSearchParams({ q: q.q, maxResults: String(Math.min(500, Math.max(1, q.maxResults))), includeSpamTrash: 'false' });
      if (q.pageToken) params.set('pageToken', q.pageToken);
      const page = parse('messages.list', ListPage, await get(client, `${BASE}/messages?${params}`, signal));
      return { messages: page.messages ?? [], nextPageToken: page.nextPageToken ?? null };
    },
    async getMessage(id, format, signal) {
      if (!ID.test(id)) throw new GoogleContractError('messages.get', ['id']);
      const params = new URLSearchParams({ format });
      if (format === 'metadata') for (const h of METADATA_HEADERS) params.append('metadataHeaders', h);
      const m = parse('messages.get', Message, await get(client, `${BASE}/messages/${id}?${params}`, signal));
      return { id: m.id, threadId: m.threadId, labelIds: m.labelIds ?? [], internalAt: Number(m.internalDate), payload: m.payload ?? null };
    },
  };
}

/** A header's value (case-insensitive name), or null. */
export function headerOf(part: GmailPart | null | undefined, name: string): string | null {
  const n = name.toLowerCase();
  return part?.headers?.find((h) => h.name.toLowerCase() === n)?.value ?? null;
}
