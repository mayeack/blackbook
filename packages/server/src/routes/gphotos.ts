/**
 * Google Photos contact screenshots (design docs/design/tickets-met-at.md "3. Contact screenshots"; DTOs in
 * @yb/shared api/tickets.ts). Connecting is GET /google/connect?product=photos (routes/google.ts), which lands back on
 * /settings?gphotos=…. Google Photos can't be scanned: the owner picks screenshots in Google's Picker, the gphotos job
 * downloads them, the Mac reads them (Apple Vision, on-device) and each one is linked to a person. Behind Cloudflare
 * Access; POSTs need JSON + X-YB.
 *
 *   GET  /gphotos/status        → GphotosStatus        connected?, health, counts, the session still in progress
 *   POST /gphotos/session       {} → GphotosSessionStart   a Picker session; the web opens pickerUri + '/autoclose'
 *   GET  /gphotos/session/:id   → GphotosSessionView   picked → downloaded → read → linked (the web polls it)
 *   POST /gphotos/disconnect    {deleteData?} → GphotosDisconnectResult
 *        Always cancels open sessions (at Google too, best effort, while the token still exists) and deletes the
 *        downloaded files under <dataDir>/screenshots/ (rows still waiting for OCR become 'expired': their file is
 *        gone); with deleteData also every contact_screenshots row (the people they linked stay). Then deletes the
 *        photos token, its cursors and health, revoking the shared Google grant only when Calendar and Gmail hold no
 *        token (routes/googleProducts.ts). A gphotos pass running meanwhile is fenced out (adapters/gphotos/jobs.ts):
 *        nothing of the cancelled picks is downloaded, stored, read or linked after the disconnect.
 *
 * Sessions and counts come from adapters/gphotos/sessions.ts, the disconnect cleanup from adapters/gphotos/jobs.ts. Every path answers 503 GOOGLE_NOT_CONFIGURED until the
 * OAuth client exists. Nothing from a screenshot (OCR text, names, numbers) is returned or logged here.
 */
import { Router } from 'express';
import { z } from 'zod';
import {
  GoogleProductDisconnect,
  GphotosSessionStatus,
  type GphotosDisconnectResult,
  type GphotosSessionStart,
  type GphotosSessionView,
  type GphotosStatus,
} from '@yb/shared';
import { connectedAt, GoogleApiError, GoogleAuthError, GoogleContractError, GoogleEgressRefusedError, isConnected, type FetchLike } from '../adapters/calendar/google';
import { GoogleOAuthFlow } from '../adapters/calendar/oauth';
import { disconnectGphotos } from '../adapters/gphotos/jobs';
import type { PickerApi } from '../adapters/gphotos/picker';
import { GphotosNotConnectedError, gphotosOverview, photosApi, pickerSessionStatus, startPickerSession } from '../adapters/gphotos/sessions';
import type { DB } from '../db/connection';
import { HttpError, notFound } from '../http/errors';
import { errorFields } from '../ops/logger';
import { PRODUCT_SOURCE } from './google';
import { disconnectGoogleProduct, googleNotConfigured, healthView } from './googleProducts';
import type { RouteDeps } from './index';

export const GPHOTOS_SOURCE = PRODUCT_SOURCE.photos;

/** A finished session stays on the status answer this long, so Settings can show how it went after a reload. */
export const RECENT_SESSION_MS = 60 * 60_000;

const SessionParam = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) });

/** adapters/gphotos/sessions.ts, injectable for tests. */
export interface GphotosSessionsApi {
  startPickerSession: typeof startPickerSession;
  pickerSessionStatus: typeof pickerSessionStatus;
  gphotosOverview: typeof gphotosOverview;
}

const DEFAULT_API: GphotosSessionsApi = { startPickerSession, pickerSessionStatus, gphotosOverview };

function sessionView(api: GphotosSessionsApi, db: DB, id: string): GphotosSessionView | null {
  const s = api.pickerSessionStatus(db, id);
  if (!s) return null;
  const status = GphotosSessionStatus.safeParse(s.status);
  return {
    id: s.id,
    status: status.success ? status.data : 'failed',
    itemsTotal: s.itemsTotal,
    itemsNew: s.itemsNew,
    processed: s.processed,
    linked: s.linked,
    createdAt: s.createdAt,
    expiresAt: s.expiresAt ?? null,
  };
}

export function gphotosStatus(db: DB, secretsAvailable: boolean, now = Date.now(), api: GphotosSessionsApi = DEFAULT_API): GphotosStatus {
  const health = healthView(db, GPHOTOS_SOURCE);
  const connected = isConnected(db, 'photos');
  const ov = api.gphotosOverview(db);
  const recent = db
    .prepare(`SELECT id FROM gphotos_sessions WHERE status IN ('open', 'picked') OR updated_at >= ? ORDER BY created_at DESC, id DESC LIMIT 1`)
    .pluck()
    .get(now - RECENT_SESSION_MS) as string | undefined;
  return {
    configured: true,
    secretsAvailable,
    connected,
    connectedAt: connectedAt(db, 'photos'),
    needsReconnect: connected && health?.status === 'auth_required',
    health,
    lastPickAt: ov.lastPickAt ?? null,
    counts: { screenshots: ov.screenshots, linked: ov.linked, pendingOcr: ov.pendingOcr },
    session: recent ? sessionView(api, db, recent) : null,
  };
}

export interface GphotosRouterOptions {
  /** Tests pass a fetch bound to an undici MockAgent. */
  fetch?: FetchLike;
  now?: () => number;
  /** Tests stub the session module. */
  api?: Partial<GphotosSessionsApi>;
}

export function createGphotosRouter({ db, log, config }: RouteDeps, o: GphotosRouterOptions = {}): Router {
  const r = Router();
  const google = config?.google ?? null;
  const secretsKey = config?.secretsKey ?? null;
  const now = o.now ?? Date.now;
  const api: GphotosSessionsApi = { ...DEFAULT_API, ...o.api };
  const flow = google ? new GoogleOAuthFlow({ config: google, fetch: o.fetch, now }) : null;

  r.use('/gphotos', (_req, res, next) => {
    if (!flow) return googleNotConfigured(res);
    next();
  });

  r.get('/gphotos/status', (_req, res) => {
    res.json(gphotosStatus(db, secretsKey !== null, now(), api) satisfies GphotosStatus);
  });

  r.post('/gphotos/session', async (_req, res) => {
    if (!secretsKey || !config) throw new HttpError(503, 'SECRETS_UNAVAILABLE', 'SECRETS_KEY is not configured, so the Google token can’t be read.');
    if (!isConnected(db, 'photos')) throw new HttpError(409, 'NOT_CONNECTED', 'Connect Google Photos first.');
    let started;
    try {
      started = await api.startPickerSession(
        db,
        {
          secretsKey,
          google: google!,
          fetch: o.fetch,
          dataDir: config.dataDir,
          collectorUrl: config.collectorUrl,
          collectorTokenFile: config.collectorTokenFile,
        },
        now(),
      );
    } catch (e) {
      if (e instanceof GphotosNotConnectedError) throw new HttpError(409, 'NOT_CONNECTED', 'Connect Google Photos first.');
      log.warn('gphotos.session_failed', { error_class: errorFields(e).error_class, status: (e as { status?: number }).status ?? undefined });
      if (e instanceof GoogleAuthError) throw new HttpError(409, 'RECONNECT', 'Google Photos stopped accepting yeackbot’s access. Connect it again.');
      if (e instanceof GoogleApiError || e instanceof GoogleEgressRefusedError || e instanceof GoogleContractError)
        throw new HttpError(502, 'GOOGLE_UNAVAILABLE', 'Google Photos didn’t answer. Try again in a minute.');
      throw e;
    }
    log.info('gphotos.session_started', { counts: { sessions: 1 } });
    res.json({ sessionId: started.sessionId, pickerUri: started.pickerUri, expiresAt: started.expiresAt ?? null } satisfies GphotosSessionStart);
  });

  r.get('/gphotos/session/:id', (req, res) => {
    const { id } = SessionParam.parse(req.params);
    const view = sessionView(api, db, id);
    if (!view) throw notFound('Session');
    res.json(view satisfies GphotosSessionView);
  });

  r.post('/gphotos/disconnect', async (req, res) => {
    const body = GoogleProductDisconnect.parse(req.body ?? {});
    const at = now();
    // Open picks are cancelled at Google too (best effort), so the token is read before it is deleted below.
    let picker: PickerApi | null = null;
    try {
      picker = secretsKey ? (photosApi(db, { secretsKey, google: google!, fetch: o.fetch })?.api ?? null) : null;
    } catch {
      // Undecryptable token: the sessions are cancelled locally and expire at Google on their own.
    }
    const cleared = await disconnectGphotos(db, { dataDir: config!.dataDir, deleteData: body.deleteData === true, api: picker, now: at });
    const out = await disconnectGoogleProduct(db, 'photos', { flow, secretsKey, log, now: at });
    if (out.had || body.deleteData || cleared.files || cleared.sessions)
      log.info('gphotos.disconnected', {
        counts: {
          revoked: out.revoked ? 1 : 0,
          all: out.all ? 1 : 0,
          files_deleted: cleared.files,
          sessions_cancelled: cleared.sessions,
          ...(body.deleteData ? { deleted_screenshots: cleared.screenshots } : {}),
        },
      });
    res.json({
      connected: false,
      revoked: out.revoked,
      filesDeleted: cleared.files,
      sessionsCancelled: cleared.sessions,
      ...(body.deleteData ? { deleted: { screenshots: cleared.screenshots } } : {}),
    } satisfies GphotosDisconnectResult);
  });

  return r;
}

export function gphotosRoutes(deps: RouteDeps): Router {
  return createGphotosRouter(deps);
}
