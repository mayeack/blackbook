/**
 * Google Photos Picker API v1 client (design docs/design/tickets-met-at.md §3), hand-written over the guarded OAuth
 * client from connectedClient(db, key, cfg, fetch, 'photos'): every call is `client.request({url, method,
 * responseType})`, so it passes guardedFetch (the read-only allowlist, `redirect: 'error'`) like the Calendar calls.
 *   sessions.create   POST   https://photospicker.googleapis.com/v1/sessions   {pickingConfig: {maxItemCount: '2000'}}
 *   sessions.get      GET    /v1/sessions/<id>        pollingConfig {pollInterval, timeoutIn}, expireTime, mediaItemsSet
 *   sessions.delete   DELETE /v1/sessions/<id>        once the picked items are downloaded
 *   mediaItems.list   GET    /v1/mediaItems?sessionId&pageSize=100&pageToken
 *   media bytes       GET    <mediaFile.baseUrl>=w1280-h1280 (=w960-h960 on the smaller re-request), bearer token,
 *                            on lh<N>.googleusercontent.com; base URLs live 60 minutes.
 * Field names follow the official reference (PickingSession, PickedMediaItem; checked 2026-10-21). Responses are
 * zod looseObjects (unknown fields kept); a mismatch is GoogleContractError (paths only). Errors map like the
 * Calendar client (mapGoogleError); a download that guardedFetch refused (a host off the allowlist, or a redirect)
 * is PickerDownloadRefusedError so the job can keep the session and warn. Nothing here logs; errors carry status
 * codes and reason tokens, never URLs, ids or image bytes.
 */
import { z } from 'zod';
import { GoogleContractError, GoogleEgressRefusedError, mapGoogleError, type OAuth2Client } from '../calendar/google';

export const PICKER_ORIGIN = 'https://photospicker.googleapis.com';
/** Most items one Picker session can hold (the API's own maximum). */
export const MAX_PICK = 2000;
export const PAGE_SIZE = 100;
const MAX_PAGES = Math.ceil(MAX_PICK / PAGE_SIZE) + 5;

/** Size parameters appended to a base URL: the normal fetch and the smaller re-request for an oversized image. */
export const MEDIA_SIZES = { normal: 'w1280-h1280', small: 'w960-h960' } as const;
export type MediaSize = keyof typeof MEDIA_SIZES;

/** Session ids go into a URL path: the same shape guardedFetch allows. */
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** A Picker media download that guardedFetch refused: a base URL off the allowlist, or a redirect. */
export class PickerDownloadRefusedError extends Error {
  constructor(readonly reason: 'host' | 'redirect') {
    super(`a Google Photos download was refused (${reason})`);
    this.name = 'PickerDownloadRefusedError';
  }
}

// ---------------------------------------------------------------------------------------------- shapes

const PickingSession = z.looseObject({
  id: z.string().regex(SESSION_ID),
  pickerUri: z.string().nullish(),
  pollingConfig: z.looseObject({ pollInterval: z.string().nullish(), timeoutIn: z.string().nullish() }).nullish(),
  expireTime: z.string().nullish(),
  mediaItemsSet: z.boolean().nullish(),
});

const PickedMediaItem = z.looseObject({
  id: z.string().min(1).max(512),
  createTime: z.string().nullish(),
  type: z.string().nullish(),
  mediaFile: z
    .looseObject({
      baseUrl: z.string().min(1),
      mimeType: z.string().nullish(),
      filename: z.string().nullish(),
      mediaFileMetadata: z.looseObject({ width: z.number().nullish(), height: z.number().nullish() }).nullish(),
    })
    .nullish(),
});

const MediaItemsPage = z.looseObject({
  mediaItems: z.array(PickedMediaItem).nullish(),
  nextPageToken: z.string().nullish(),
});

export interface PickerSession {
  id: string;
  /** Where the owner picks (the web opens it with '/autoclose'); empty only on a malformed get. */
  pickerUri: string;
  /** Google's recommended poll interval, ms (null when absent). */
  pollIntervalMs: number | null;
  /** How long polling still makes sense, ms; 0 = stop polling (null when absent). */
  timeoutInMs: number | null;
  expiresAt: number | null;
  mediaItemsSet: boolean;
}

export interface PickedItem {
  /** Persistent media item id (stable across sessions): the dedupe key, never a file name. */
  id: string;
  /** When the photo was taken (createTime), or null. */
  createdAt: number | null;
  type: 'PHOTO' | 'VIDEO' | 'OTHER';
  baseUrl: string | null;
  mimeType: string | null;
}

export interface MediaItemsPageResult {
  items: PickedItem[];
  nextPageToken: string | null;
}

export interface DownloadedMedia {
  bytes: Buffer;
  /** The response's content type, lowercased without parameters, or null. */
  contentType: string | null;
}

/** "3.5s" (protobuf Duration JSON) → ms; null when absent or malformed. */
export function parseDuration(v: string | null | undefined): number | null {
  const m = v ? /^(\d{1,12})(?:\.(\d{1,9}))?s$/.exec(v.trim()) : null;
  if (!m) return null;
  return Number(m[1]) * 1000 + Math.round(Number(`0.${m[2] ?? '0'}`) * 1000);
}

const parseTime = (v: string | null | undefined): number | null => {
  const t = v ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : null;
};

function parse<S extends z.ZodType>(route: string, schema: S, data: unknown): z.output<S> {
  const r = schema.safeParse(data);
  if (!r.success) throw new GoogleContractError(route, [...new Set(r.error.issues.map((i) => i.path.join('.') || 'root'))]);
  return r.data;
}

function toSession(s: z.output<typeof PickingSession>): PickerSession {
  return {
    id: s.id,
    pickerUri: s.pickerUri && /^https:\/\/[^\s]+$/.test(s.pickerUri) ? s.pickerUri : '',
    pollIntervalMs: parseDuration(s.pollingConfig?.pollInterval),
    timeoutInMs: parseDuration(s.pollingConfig?.timeoutIn),
    expiresAt: parseTime(s.expireTime),
    mediaItemsSet: s.mediaItemsSet === true,
  };
}

function toItem(i: z.output<typeof PickedMediaItem>): PickedItem {
  const type = i.type === 'PHOTO' ? 'PHOTO' : i.type === 'VIDEO' ? 'VIDEO' : 'OTHER';
  const mime = i.mediaFile?.mimeType?.toLowerCase() ?? null;
  return {
    id: i.id,
    createdAt: parseTime(i.createTime),
    // TYPE_UNSPECIFIED with an image mime type is still a photo.
    type: type === 'OTHER' && mime?.startsWith('image/') ? 'PHOTO' : type,
    baseUrl: i.mediaFile?.baseUrl ?? null,
    mimeType: mime,
  };
}

/** Walks an error's cause chain (GaxiosError → TypeError "fetch failed" → the reason). */
function causes(e: unknown): unknown[] {
  const out: unknown[] = [];
  let cur: unknown = e;
  for (let i = 0; i < 6 && cur && typeof cur === 'object'; i++) {
    out.push(cur);
    cur = (cur as { cause?: unknown }).cause;
  }
  return out;
}

/** guardedFetch refused the request (host) or the fetch refused a redirect (`redirect: 'error'`). */
export function refusedDownload(e: unknown): PickerDownloadRefusedError | null {
  const chain = causes(e);
  if (chain.some((c) => c instanceof GoogleEgressRefusedError)) return new PickerDownloadRefusedError('host');
  if (chain.some((c) => c instanceof Error && /redirect/i.test(c.message))) return new PickerDownloadRefusedError('redirect');
  return null;
}

/** The base URL must be https on an lh<N>.googleusercontent.com host; anything else is refused before a request. */
export function mediaUrl(baseUrl: string, size: MediaSize): string {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    throw new PickerDownloadRefusedError('host');
  }
  if (u.protocol !== 'https:' || !/^lh\d\.googleusercontent\.com$/.test(u.hostname) || u.search || u.hash) {
    throw new PickerDownloadRefusedError('host');
  }
  return `${u.origin}${u.pathname}=${MEDIA_SIZES[size]}`;
}

// ---------------------------------------------------------------------------------------------- API

/** The Picker calls the gphotos job and the web routes need. */
export interface PickerApi {
  createSession(signal?: AbortSignal): Promise<PickerSession>;
  getSession(id: string, signal?: AbortSignal): Promise<PickerSession>;
  deleteSession(id: string, signal?: AbortSignal): Promise<void>;
  listItems(sessionId: string, pageToken?: string | null, signal?: AbortSignal): Promise<MediaItemsPageResult>;
  /** Every picked item of a session (all pages). */
  listAllItems(sessionId: string, signal?: AbortSignal): Promise<PickedItem[]>;
  download(baseUrl: string, size?: MediaSize, signal?: AbortSignal): Promise<DownloadedMedia>;
}

const sessionPath = (id: string): string => {
  if (!SESSION_ID.test(id)) throw new GoogleContractError('sessions', ['id']);
  return `${PICKER_ORIGIN}/v1/sessions/${encodeURIComponent(id)}`;
};

const contentTypeOf = (headers: unknown): string | null => {
  // A Headers instance (possibly another undici's class), or a plain record.
  const h = headers as { get?: (n: string) => string | null } | Record<string, string> | undefined;
  const raw = typeof h?.get === 'function' ? h.get('content-type') : ((h as Record<string, string> | undefined)?.['content-type'] ?? null);
  return raw ? raw.split(';')[0]!.trim().toLowerCase() || null : null;
};

export function pickerApi(client: OAuth2Client): PickerApi {
  async function call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw mapGoogleError(e);
    }
  }

  const api: PickerApi = {
    async createSession(signal) {
      const res = await call(() =>
        client.request({ url: `${PICKER_ORIGIN}/v1/sessions`, method: 'POST', responseType: 'json', data: { pickingConfig: { maxItemCount: String(MAX_PICK) } }, signal }),
      );
      const s = toSession(parse('sessions.create', PickingSession, res.data));
      if (!s.pickerUri) throw new GoogleContractError('sessions.create', ['pickerUri']);
      return s;
    },
    async getSession(id, signal) {
      const url = sessionPath(id);
      const res = await call(() => client.request({ url, method: 'GET', responseType: 'json', signal }));
      return toSession(parse('sessions.get', PickingSession, res.data));
    },
    async deleteSession(id, signal) {
      const url = sessionPath(id);
      await call(() => client.request({ url, method: 'DELETE', responseType: 'json', signal }));
    },
    async listItems(sessionId, pageToken, signal) {
      if (!SESSION_ID.test(sessionId)) throw new GoogleContractError('mediaItems.list', ['sessionId']);
      const q = new URLSearchParams({ sessionId, pageSize: String(PAGE_SIZE) });
      if (pageToken) q.set('pageToken', pageToken);
      const res = await call(() => client.request({ url: `${PICKER_ORIGIN}/v1/mediaItems?${q}`, method: 'GET', responseType: 'json', signal }));
      const page = parse('mediaItems.list', MediaItemsPage, res.data);
      return { items: (page.mediaItems ?? []).map(toItem), nextPageToken: page.nextPageToken ?? null };
    },
    async listAllItems(sessionId, signal) {
      const out: PickedItem[] = [];
      let token: string | null = null;
      for (let n = 0; n < MAX_PAGES; n++) {
        const page = await api.listItems(sessionId, token, signal);
        out.push(...page.items);
        if (!page.nextPageToken) return out;
        token = page.nextPageToken;
      }
      throw new GoogleContractError('mediaItems.list', ['nextPageToken']);
    },
    async download(baseUrl, size = 'normal', signal) {
      const url = mediaUrl(baseUrl, size);
      try {
        const res = await client.request<ArrayBuffer>({ url, method: 'GET', responseType: 'arraybuffer', signal });
        return { bytes: Buffer.from(res.data), contentType: contentTypeOf(res.headers) };
      } catch (e) {
        throw refusedDownload(e) ?? mapGoogleError(e);
      }
    },
  };
  return api;
}
