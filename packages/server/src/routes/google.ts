/**
 * Google Calendar connection (PLAN "Ingestion → Google Calendar"). Behind Cloudflare Access like every /api route;
 * POSTs need JSON + X-YB (http/csrf.ts). The OAuth callback is a top-level GET navigation coming back from Google,
 * so it answers with redirects to Settings instead of JSON.
 *
 *   GET  /google/status       {configured, connected, needsReconnect, account, lastSyncAt, treatments, health,
 *                             calendars[]}
 *   GET  /google/connect      302 → Google consent (offline, prompt=consent, PKCE S256, state) for ?product=
 *                             calendar (default, calendar.readonly) | gmail (gmail.readonly, the ticket source) |
 *                             photos (the Google Photos Picker). Each product is its own grant and refresh token.
 *   GET  /google/callback     verifies state, exchanges the code, stores that product's refresh token encrypted
 *                             → 302 /settings?google=… (calendar), ?gmail=… or ?gphotos=…, each
 *                             connected|denied|expired|scope|error (an unknown or expired state can't name its
 *                             product, so it answers ?google=expired|invalid)
 *   POST /google/calendars    {calendars:[{id, treatment: attending|candidate|classify|excluded|default,
 *                             partifulLinked?}]} → journaled settings batch → {batchId, calendars}
 *                             An excluded calendar's synced events are deleted at once (purgeUnusedCalendars).
 *   POST /google/disconnect   {deleteData?} deletes the calendar secret and sync tokens; revokes the grant (best
 *                             effort) only when Gmail and Photos hold no token either, and then disconnects all
 *                             three (routes/googleProducts.ts); with deleteData also every synced calendar and event
 *
 * Every path answers 503 GOOGLE_NOT_CONFIGURED until GOOGLE_CLIENT_ID/SECRET are set. Tokens, codes and states are
 * never logged or returned.
 */
import { Router, type Response } from 'express';
import { z } from 'zod';
import { normalizeEmail, type ApiError } from '@yb/shared';
import { recordSourceHealth } from '../adapters/common/cursors';
import { connectedAt, GOOGLE_PRODUCTS, isConnected, isGoogleProduct, type FetchLike, type GoogleProduct } from '../adapters/calendar/google';
import { GoogleOAuthFlow } from '../adapters/calendar/oauth';
import { deleteCalendarData, GCAL_SOURCE, purgeUnusedCalendars } from '../adapters/calendar/sync';
import { TREATMENTS, treatmentSettingKey, type CalendarKind, type Treatment, type TreatmentSetting } from '../adapters/calendar/treatment';
import type { DB } from '../db/connection';
import { HttpError, notFound } from '../http/errors';
import { withBatch } from '../journal/batch';
import { withRun } from '../journal/runs';
import { errorFields } from '../ops/logger';
import { redact } from '../ops/redact';
import { setSecret } from '../security/secrets';
import { disconnectGoogleProduct } from './googleProducts';
import type { RouteDeps } from './index';

export interface GoogleCalendarView {
  id: string;
  name: string | null;
  kind: CalendarKind;
  primary: boolean;
  accessRole: string | null;
  timeZone: string | null;
  treatment: Treatment;
  defaultTreatment: Treatment;
  /** True when the owner chose the treatment (a settings row), false when it's the default. */
  userSet: boolean;
  partifulLinked: boolean;
  /** No longer in his calendar list (unsubscribed or deleted): not synced. */
  removed: boolean;
  /** Synced and visible to the pipeline: listed and not excluded. */
  included: boolean;
  events: number;
  lastSyncedAt: number | null;
}

export interface GoogleStatus {
  configured: true;
  /** SECRETS_KEY is set (needed to store the refresh token). */
  secretsAvailable: boolean;
  connected: boolean;
  connectedAt: number | null;
  /** Connected, but Google refused the stored grant (revoked or expired): connect again. */
  needsReconnect: boolean;
  /** The Google account (its primary calendar's id), once a sync has listed it. */
  account: string | null;
  /** Last successful sync. */
  lastSyncAt: number | null;
  treatments: readonly Treatment[];
  health: { status: string; lastOkAt: number | null; lastError: string | null; checkedAt: number } | null;
  calendars: GoogleCalendarView[];
}

const SETTINGS_PATH = '/settings';

/** source_health / source_cursors name of each Google product's source (adapters/gmail, adapters/gphotos). */
export const PRODUCT_SOURCE: Readonly<Record<GoogleProduct, string>> = { calendar: GCAL_SOURCE, gmail: 'gmail', photos: 'gphotos' };

export function calendarViews(db: DB): GoogleCalendarView[] {
  const rows = db
    .prepare(
      `SELECT c.calendar_id, c.summary, c.kind, c.is_primary, c.access_role, c.time_zone, c.removed_at, c.last_synced_at,
         t.treatment, t.default_treatment, t.user_set, t.partiful_linked,
         (SELECT count(*) FROM calendar_events e WHERE e.calendar_id = c.calendar_id AND e.status <> 'cancelled') AS events
       FROM gcal_calendars c JOIN gcal_calendar_treatment t USING (calendar_id)
       ORDER BY c.removed_at IS NOT NULL, c.is_primary DESC, lower(coalesce(c.summary, '')), c.calendar_id`,
    )
    .all() as {
    calendar_id: string;
    summary: string | null;
    kind: CalendarKind;
    is_primary: number;
    access_role: string | null;
    time_zone: string | null;
    removed_at: number | null;
    last_synced_at: number | null;
    treatment: Treatment;
    default_treatment: Treatment;
    user_set: number;
    partiful_linked: number;
    events: number;
  }[];
  return rows.map((r) => ({
    id: r.calendar_id,
    name: r.summary,
    kind: r.kind,
    primary: r.is_primary === 1,
    accessRole: r.access_role,
    timeZone: r.time_zone,
    treatment: r.treatment,
    defaultTreatment: r.default_treatment,
    userSet: r.user_set === 1,
    partifulLinked: r.partiful_linked === 1,
    removed: r.removed_at !== null,
    included: r.removed_at === null && r.treatment !== 'excluded',
    events: r.events,
    lastSyncedAt: r.last_synced_at,
  }));
}

export function googleStatus(db: DB, secretsAvailable: boolean): GoogleStatus {
  const h = db.prepare('SELECT status, last_ok_at, last_error, checked_at FROM source_health WHERE source = ?').get(GCAL_SOURCE) as
    | { status: string; last_ok_at: number | null; last_error: string | null; checked_at: number }
    | undefined;
  const connected = isConnected(db);
  const primary = db.prepare('SELECT calendar_id FROM gcal_calendars WHERE is_primary = 1 AND removed_at IS NULL').pluck().get() as string | undefined;
  return {
    configured: true,
    secretsAvailable,
    connected,
    connectedAt: connectedAt(db),
    needsReconnect: connected && h?.status === 'auth_required',
    account: primary ? normalizeEmail(primary) : null,
    lastSyncAt: h?.last_ok_at ?? null,
    treatments: TREATMENTS,
    health: h ? { status: h.status, lastOkAt: h.last_ok_at, lastError: h.last_error && redact(h.last_error), checkedAt: h.checked_at } : null,
    calendars: calendarViews(db),
  };
}

const TreatmentChange = z.object({
  id: z.string().min(1).max(1024),
  treatment: z.enum([...TREATMENTS, 'default']),
  partifulLinked: z.boolean().optional(),
});
const TreatmentBody = z.object({ calendars: z.array(TreatmentChange).min(1).max(100) });
export type TreatmentChange = z.output<typeof TreatmentChange>;

/**
 * Applies treatment choices as one journaled (undoable) settings batch. 'default' drops the owner's treatment (the
 * calendar follows its default again); a row left with nothing in it is deleted. A calendar that ends up excluded
 * loses its synced events right away (they are re-listed if it is included again, e.g. by undo).
 */
export function setTreatments(db: DB, changes: TreatmentChange[], now = Date.now()): { batchId: string | null } {
  const known = db.prepare('SELECT 1 FROM gcal_calendars WHERE calendar_id = ?').pluck();
  for (const c of changes) if (known.get(c.id) === undefined) throw notFound('Calendar');
  return withRun(
    db,
    'user',
    (runId) => {
      const n = new Set(changes.map((c) => c.id)).size;
      // Calendar names can be people's names: the feed title stays generic.
      const title = n === 1 ? 'Changed how a calendar is used' : `Changed how ${n} calendars are used`;
      const { batchId, changes: written } = withBatch(
        db,
        { runId, kind: 'setting', title, actor: 'user' },
        (t) => {
          for (const c of changes) {
            const key = treatmentSettingKey(c.id);
            const existing = t.get('settings', { key });
            const current = existing ? (JSON.parse(String(existing.value)) as TreatmentSetting) : {};
            const partifulLinked = c.partifulLinked ?? current.partifulLinked;
            // No "treatment" key = follow the default (gcal_calendar_treatment coalesces).
            const value: TreatmentSetting = {
              ...(c.treatment !== 'default' ? { treatment: c.treatment } : {}),
              ...(partifulLinked !== undefined ? { partifulLinked } : {}),
            };
            if (!Object.keys(value).length) {
              if (existing) t.delete('settings', { key });
            } else if (existing) t.update('settings', { key }, { value: JSON.stringify(value) });
            else t.insert('settings', { key, value: JSON.stringify(value) });
          }
        },
        { now },
      );
      purgeUnusedCalendars(db);
      return { batchId: written ? batchId : null };
    },
    { now },
  );
}

const DisconnectBody = z.object({ deleteData: z.boolean().optional() });

const CallbackQuery = z.object({
  state: z.string().min(1).max(512).optional(),
  code: z.string().min(1).max(4096).optional(),
  error: z.string().max(256).optional(),
});

export interface GoogleRouterOptions {
  /** Tests pass a fetch bound to an undici MockAgent. */
  fetch?: FetchLike;
  now?: () => number;
}

const notConfigured = (res: Response) => {
  const body: ApiError = { error: { code: 'GOOGLE_NOT_CONFIGURED', message: 'Google OAuth client not configured' } };
  res.status(503).json(body);
};

export function createGoogleRouter({ db, log, config }: RouteDeps, o: GoogleRouterOptions = {}): Router {
  const r = Router();
  const google = config?.google ?? null;
  const secretsKey = config?.secretsKey ?? null;
  const now = o.now ?? Date.now;
  const flow = google ? new GoogleOAuthFlow({ config: google, fetch: o.fetch, now }) : null;

  r.use('/google', (_req, res, next) => {
    if (!flow) return notConfigured(res);
    next();
  });

  r.get('/google/status', (_req, res) => {
    res.json(googleStatus(db, secretsKey !== null) satisfies GoogleStatus);
  });

  r.get('/google/connect', (req, res) => {
    if (!secretsKey) throw new HttpError(503, 'SECRETS_UNAVAILABLE', 'SECRETS_KEY is not configured, so the Google token could not be stored.');
    const product = req.query.product ?? 'calendar';
    if (!isGoogleProduct(product)) throw new HttpError(400, 'VALIDATION', 'Unknown Google product.');
    res.redirect(302, flow!.start(product).url);
  });

  r.get('/google/callback', async (req, res) => {
    let product: GoogleProduct = 'calendar';
    const back = (outcome: string) => res.redirect(302, `${SETTINGS_PATH}?${GOOGLE_PRODUCTS[product].settingsParam}=${outcome}`);
    const q = CallbackQuery.safeParse(req.query);
    if (!q.success || !q.data.state) return back('invalid');
    const pending = flow!.consume(q.data.state);
    if (!pending) return back('expired');
    product = pending.product;
    const verifier = pending.verifier;
    if (q.data.error || !q.data.code) return back(q.data.error === 'access_denied' ? 'denied' : 'invalid');
    if (!secretsKey) return back('error');
    let result;
    try {
      result = await flow!.exchange(q.data.code, verifier);
    } catch (e) {
      const f = errorFields(e);
      log.warn('gcal.oauth_exchange_failed', { error_class: f.error_class, error_code: (e as { reason?: string }).reason, status: (e as { status?: number }).status ?? undefined });
      return back('error');
    }
    const spec = GOOGLE_PRODUCTS[product];
    if (!result.scopes.includes(spec.scope)) return back('scope');
    if (!result.refreshToken) {
      log.warn('gcal.oauth_no_refresh_token', { route: product });
      return back('error');
    }
    const at = now();
    setSecret(db, secretsKey, spec.secret, result.refreshToken, at);
    recordSourceHealth(db, PRODUCT_SOURCE[product], at, 'unknown', { error: null, newestDataAt: null, details: { connected: true } });
    log.info('gcal.connected', { route: product });
    return back('connected');
  });

  r.post('/google/calendars', (req, res) => {
    const body = TreatmentBody.parse(req.body);
    const { batchId } = setTreatments(db, body.calendars, now());
    res.json({ batchId, calendars: calendarViews(db) });
  });

  r.post('/google/disconnect', async (req, res) => {
    const body = DisconnectBody.parse(req.body ?? {});
    // Revokes the shared grant only when Gmail and Photos hold no token either (routes/googleProducts.ts); sync
    // tokens belong to the old grant's view of the calendars, so a reconnect starts with full listings.
    const out = await disconnectGoogleProduct(db, 'calendar', { flow, secretsKey, log, now: now() });
    const deleted = body.deleteData ? deleteCalendarData(db) : null;
    if (out.had || deleted)
      log.info('gcal.disconnected', {
        counts: { revoked: out.revoked ? 1 : 0, all: out.all ? 1 : 0, ...(deleted ? { deleted_events: deleted.events, deleted_calendars: deleted.calendars } : {}) },
      });
    res.json({ connected: false, revoked: out.revoked, ...(deleted ? { deleted } : {}) });
  });

  return r;
}

export function googleRouter(deps: RouteDeps): Router {
  return createGoogleRouter(deps);
}
