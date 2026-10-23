/**
 * Google Photos Picker sessions the owner starts from Settings (design §3 "Session"; routes POST /gphotos/session,
 * GET /gphotos/session/:id, GET /gphotos/status):
 *   startPickerSession   Picker sessions.create → a gphotos_sessions row ('open', poll_after from Google's
 *                        pollInterval) → {sessionId, pickerUri, expiresAt}; the web opens pickerUri + '/autoclose'.
 *   pickerSessionStatus  one session's progress: picked / new items, how many screenshots were read and linked.
 *   gphotosOverview      the Settings / Sources summary.
 * The gphotos job (jobs.ts) does the polling, downloading and OCR. gphotos_sessions and contact_screenshots are plain
 * tables (S / E), never journaled. Counts of linked people include only visible people (person_canon →
 * person_visible). Nothing here logs; errors are the typed Google errors from calendar/google.ts.
 */
import type { Dispatcher } from 'undici';
import type { DB } from '../../db/connection';
import { recordSourceHealth } from '../common/cursors';
import { connectedClient, GoogleAuthError, isConnected, type FetchLike, type GoogleOAuthConfig, type OAuth2Client } from '../calendar/google';
import { pickerApi, type PickerApi } from './picker';

export const GPHOTOS_SOURCE = 'gphotos';

export interface GphotosDeps {
  secretsKey: Buffer;
  google: GoogleOAuthConfig;
  /** Tests pass a fetch bound to an undici MockAgent. */
  fetch?: FetchLike;
  /** The data directory: downloads go to <dataDir>/screenshots (0700). */
  dataDir: string;
  /** Collector base URL (loopback; default COLLECTOR_DEFAULT_URL). */
  collectorUrl?: string;
  /** Collector token file (default <dataDir>/collector.token). */
  collectorTokenFile?: string;
  /** Tests pass an undici MockAgent standing in for the collector. */
  collectorDispatcher?: Dispatcher;
}

/** Google Photos isn't connected (no gphotos.refresh_token): Settings → Connect Google Photos. */
export class GphotosNotConnectedError extends Error {
  constructor() {
    super('Google Photos is not connected');
    this.name = 'GphotosNotConnectedError';
  }
}

/** Google's recommended poll interval, clamped to [5 s, 10 min] (default 10 s). */
export const pollDelay = (ms: number | null): number => Math.min(Math.max(ms ?? 10_000, 5_000), 10 * 60_000);

/** The Picker API on the photos product's own grant, or null when not connected. */
export function photosApi(db: DB, deps: Pick<GphotosDeps, 'secretsKey' | 'google' | 'fetch'>): { client: OAuth2Client; api: PickerApi } | null {
  const client = connectedClient(db, deps.secretsKey, deps.google, deps.fetch, 'photos');
  return client ? { client, api: pickerApi(client) } : null;
}

export const AUTH_REQUIRED_TEXT = 'Google Photos sign-in expired or was revoked: reconnect Google Photos in Settings.';

/** Creates a Picker session and records it 'open'. Throws GphotosNotConnectedError or the typed Google errors. */
export async function startPickerSession(
  db: DB,
  deps: GphotosDeps,
  now: number = Date.now(),
): Promise<{ sessionId: string; pickerUri: string; expiresAt: number | null }> {
  const photos = photosApi(db, deps);
  if (!photos) throw new GphotosNotConnectedError();
  let s;
  try {
    s = await photos.api.createSession();
  } catch (e) {
    if (e instanceof GoogleAuthError) {
      recordSourceHealth(db, GPHOTOS_SOURCE, now, 'auth_required', { error: AUTH_REQUIRED_TEXT, newestDataAt: null, details: { connected: true } });
    }
    throw e;
  }
  db.prepare(
    `INSERT INTO gphotos_sessions (id, status, picker_uri, expires_at, poll_after, created_at, updated_at)
     VALUES (?, 'open', ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET status = 'open', picker_uri = excluded.picker_uri, expires_at = excluded.expires_at,
       poll_after = excluded.poll_after, updated_at = excluded.updated_at`,
  ).run(s.id, s.pickerUri, s.expiresAt, now + pollDelay(s.pollIntervalMs), now, now);
  return { sessionId: s.id, pickerUri: s.pickerUri, expiresAt: s.expiresAt };
}

export interface PickerSessionStatus {
  id: string;
  status: 'open' | 'picked' | 'done' | 'expired' | 'failed' | 'cancelled';
  itemsTotal: number;
  /** The session's screenshot rows: items it downloaded (a deleteData disconnect zeroes it, a re-pick moves a row on). */
  itemsNew: number;
  /** Screenshots of this session that left 'downloaded' (read, or failed / expired). */
  processed: number;
  /** Of those, linked to a visible person. */
  linked: number;
  createdAt: number;
  expiresAt: number | null;
}

/** SQL predicate on `contact_screenshots cs`: linked to a person who is visible through their canonical record. */
export const LINKED_VISIBLE = `cs.status = 'linked' AND EXISTS (SELECT 1 FROM person_canon pc JOIN person_visible pv ON pv.id = pc.canonical_id WHERE pc.person_id = cs.person_id)`;

export function pickerSessionStatus(db: DB, id: string): PickerSessionStatus | null {
  const s = db.prepare('SELECT id, status, items_total, items_new, created_at, expires_at FROM gphotos_sessions WHERE id = ?').get(id) as
    | { id: string; status: PickerSessionStatus['status']; items_total: number; items_new: number; created_at: number; expires_at: number | null }
    | undefined;
  if (!s) return null;
  const c = db
    .prepare(
      `SELECT coalesce(sum(cs.status <> 'downloaded'), 0) AS processed, coalesce(sum(${LINKED_VISIBLE}), 0) AS linked
       FROM contact_screenshots cs WHERE cs.session_id = ?`,
    )
    .get(id) as { processed: number; linked: number };
  return {
    id: s.id,
    status: s.status,
    itemsTotal: s.items_total,
    itemsNew: s.items_new,
    processed: c.processed,
    linked: c.linked,
    createdAt: s.created_at,
    expiresAt: s.expires_at,
  };
}

export interface GphotosOverview {
  connected: boolean;
  /** When the owner last started a session that got picked. */
  lastPickAt: number | null;
  screenshots: number;
  linked: number;
  pendingOcr: number;
}

export function gphotosOverview(db: DB): GphotosOverview {
  const lastPickAt = db.prepare(`SELECT max(created_at) FROM gphotos_sessions WHERE status IN ('picked','done')`).pluck().get() as number | null;
  const c = db
    .prepare(
      `SELECT count(*) AS screenshots, coalesce(sum(${LINKED_VISIBLE}), 0) AS linked, coalesce(sum(cs.status = 'downloaded'), 0) AS pending
       FROM contact_screenshots cs`,
    )
    .get() as { screenshots: number; linked: number; pending: number };
  return { connected: isConnected(db, 'photos'), lastPickAt: lastPickAt ?? null, screenshots: c.screenshots, linked: c.linked, pendingOcr: c.pending };
}
