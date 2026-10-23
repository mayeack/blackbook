/**
 * Scheduler job `gphotos`, every 60 s (design §3; review amendments [shots]). A cheap no-op when no Picker session
 * is open, nothing waits for OCR and no file is due for cleanup. One pass:
 *   1. Housekeeping: a screenshot still 'downloaded' 7 days after its download is 'expired' and its file deleted;
 *      any file under <dataDir>/screenshots that no waiting row owns (a crash leftover, a .tmp) is deleted.
 *   2. Sessions ('open' / 'picked', oldest first): past expireTime → 'expired', before anything else (no Google call
 *      and no readable token needed). Otherwise, once its poll_after has passed, sessions.get (respecting
 *      pollingConfig.pollInterval; timeoutIn 0 → 'expired'). When mediaItemsSet, mediaItems.list (all pages) and
 *      download each PHOTO not already handled in contact_screenshots (source 'gphotos', source_ref = the persistent
 *      media item id) at =w1280-h1280, re-requesting =w960-h960 when over 4 MiB, into
 *      <dataDir>/screenshots/<contact_screenshots.id>.img (0600, dir 0700), recorded 'downloaded'. ≤200 downloads a
 *      pass. When every item is handled, sessions.delete and 'done'.
 *        - Handled means read, waiting, failed for good (the image itself: too large, not an image, unreadable), or
 *          already met in this session. A row never read (expired: the 7-day rule or a disconnect; or a failure a new
 *          download can cure) is downloaded again when picked again, under its own row, and moves to the new session.
 *        - The disconnect fence: the Photos disconnect may land while a pass awaits Google. Every session write
 *          requires the session still 'open' / 'picked'; before each download and again before its file and row are
 *          written (one synchronous step) the session must still be open and Photos connected, so nothing of a
 *          cancelled pick is stored or read. The OCR step reads only rows still 'downloaded' (screenshots/process.ts).
 *        - A download guardedFetch refused (a host off the allowlist, or a redirect) → health warning; the session is
 *          kept (retried in 5 min until it expires).
 *        - A failed download (5xx, 404) keeps the session for the next pass.
 *   3. OCR: up to 50 'downloaded' rows through the collector (screenshots/process.ts). A collector without
 *      /v1/vision/ocr → health "Update the collector to read screenshots", retried every 15 min; the files wait.
 *   4. source_health 'gphotos': ok; auth_required (revoked grant: no backoff, only a reconnect helps); disabled (not
 *      connected: open sessions fail, waiting files are still read); contract_broken (a Picker response of the wrong
 *      shape failed a session); or error with a fixed sentence (no OCR route, a refused download, no collector, an
 *      unreadable token). source_health has no warning level, so a refused download is an error whose details say
 *      refused: 1. Logs carry counts only.
 * Nothing from a screenshot ever goes to an LLM.
 */
import path from 'node:path';
import { uuidv7 } from '@yb/shared';
import { COLLECTOR_DEFAULT_URL } from '@yb/shared/collector/v1';
import type { DB } from '../../db/connection';
import { tx } from '../../db/tx';
import { interval, type JobContext, type JobDef, type JobOutcome } from '../../scheduler/scheduler';
import { settingTimeZone } from '../../settings/registry';
import { OcrClient, type ScreenshotOcr } from '../../screenshots/ocr';
import { regionForTimeZone } from '../../screenshots/extract';
import { processPendingScreenshots } from '../../screenshots/process';
import { cursorMeta, readCursor, recordSourceHealth, writeCursor } from '../common/cursors';
import { GoogleApiError, GoogleAuthError, GoogleContractError, isConnected } from '../calendar/google';
import { deleteScreenshot, pruneScreenshotFiles, writeScreenshot } from './files';
import { PickerDownloadRefusedError, type PickedItem, type PickerApi } from './picker';
import { AUTH_REQUIRED_TEXT, GPHOTOS_SOURCE, LINKED_VISIBLE, photosApi, pollDelay, type GphotosDeps } from './sessions';

export type { GphotosDeps } from './sessions';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

export const GPHOTOS_INTERVAL_MS = MIN;
/** Raw images Node keeps (and sends to the collector, base64, under its 8 MiB OCR body limit). */
export const MAX_RAW_BYTES = 4 * 1024 * 1024;
/** A downloaded file lives 7 days at most, whatever happened. */
export const FILE_TTL_MS = 7 * DAY;
export const DOWNLOADS_PER_PASS = 200;
const REFUSED_RETRY_MS = 5 * MIN;
const SESSION_ERROR_RETRY_MS = MIN;
const ROUTE_MISSING_RETRY_MS = 15 * MIN;
const OCR_SCOPE = 'ocr';

export const UPDATE_COLLECTOR_TEXT = 'Update the collector to read screenshots';
const REFUSED_TEXT = 'A Google Photos download was refused (unexpected host or redirect); the pick is kept and retried.';
const COLLECTOR_DOWN_TEXT = 'The collector is not reachable; downloaded screenshots wait for it.';
const NOT_CONNECTED_TEXT = 'Google Photos is not connected.';
const TOKEN_UNREADABLE_TEXT = 'The Google Photos token can’t be read (SECRETS_KEY changed?): reconnect Google Photos in Settings.';
const CONTRACT_TEXT = 'Google Photos answered in an unexpected shape; the pick could not be read.';

type Stats = Record<string, number>;
const bump = (s: Stats, k: string, n = 1) => {
  s[k] = (s[k] ?? 0) + n;
};
const nonZero = (s: Stats): Stats => Object.fromEntries(Object.entries(s).filter(([, v]) => v !== 0));

interface SessionRow {
  id: string;
  status: 'open' | 'picked';
  expires_at: number | null;
  poll_after: number | null;
}

// ---------------------------------------------------------------------------------------------- housekeeping

/** 7-day rule and orphan files. Returns [rows expired, files removed]. */
function housekeeping(db: DB, dataDir: string, now: number): { expired: number; pruned: number } {
  const stale = db
    .prepare(`SELECT id FROM contact_screenshots WHERE status = 'downloaded' AND created_at <= ?`)
    .pluck()
    .all(now - FILE_TTL_MS) as string[];
  const expire = db.prepare(`UPDATE contact_screenshots SET status = 'expired', error_class = 'ttl', updated_at = ? WHERE id = ?`);
  for (const id of stale) {
    expire.run(now, id);
    deleteScreenshot(dataDir, id);
  }
  const waiting = new Set(db.prepare(`SELECT id FROM contact_screenshots WHERE status = 'downloaded'`).pluck().all() as string[]);
  const pruned = pruneScreenshotFiles(dataDir, (id) => waiting.has(id));
  return { expired: stale.length, pruned };
}

// ---------------------------------------------------------------------------------------------- sessions

/**
 * Every session write: only while the session is still 'open' / 'picked', so a pass never overwrites the disconnect's
 * 'cancelled' (nor any other end). Returns whether the row changed.
 */
const setSession = (db: DB, id: string, now: number, patch: { status?: string; poll_after?: number | null; expires_at?: number | null; error_class?: string | null }) => {
  const cols = Object.keys(patch);
  return (
    db
      .prepare(`UPDATE gphotos_sessions SET ${cols.map((c) => `${c} = @${c}`).join(', ')}, updated_at = @now WHERE id = @id AND status IN ('open','picked')`)
      .run({ ...patch, now, id }).changes > 0
  );
};

/** The disconnect fence: the session still takes downloads (open or picked) and Photos is still connected. */
const live = (db: DB, sessionId: string): boolean =>
  isConnected(db, 'photos') && db.prepare(`SELECT 1 FROM gphotos_sessions WHERE id = ? AND status IN ('open','picked')`).get(sessionId) !== undefined;

/** A per-session Google error: auth goes up (the whole pass is auth_required); the rest stay with the session. */
function sessionError(db: DB, s: SessionRow, e: unknown, now: number, stats: Stats): void {
  if (e instanceof GoogleAuthError) throw e;
  if (e instanceof GoogleApiError && e.status === 404) {
    setSession(db, s.id, now, { status: 'failed', error_class: 'not_found' });
    bump(stats, 'sessions_failed');
    return;
  }
  if (e instanceof GoogleContractError) {
    setSession(db, s.id, now, { status: 'failed', error_class: 'contract' });
    bump(stats, 'sessions_failed');
    bump(stats, 'contract_broken');
    return;
  }
  if (e instanceof GoogleApiError) {
    setSession(db, s.id, now, { poll_after: now + SESSION_ERROR_RETRY_MS, error_class: e.status ? `http_${e.status}` : e.reason.slice(0, 40) });
    bump(stats, 'session_errors');
    return;
  }
  throw e;
}

/**
 * SQL predicate on a contact_screenshots row: never read, and a new download can cure it. Expired (the 7-day rule or
 * a disconnect deleted its file) or failed for a reason other than the image itself; a re-pick downloads it again.
 */
const FINAL_FAILURES = `('too_large', 'not_image', 'payload_too_large', 'image_unreadable')`;
const AGAIN = `(status = 'expired' OR (status = 'failed' AND coalesce(error_class, '') NOT IN ${FINAL_FAILURES}))`;
/** The session still takes rows: the insert / reset itself is fenced too. */
const SESSION_LIVE = `EXISTS (SELECT 1 FROM gphotos_sessions WHERE id = @session AND status IN ('open','picked'))`;

const insertShot = (db: DB) =>
  db.prepare(
    `INSERT INTO contact_screenshots (id, source, source_ref, session_id, taken_at, status, error_class, created_at, updated_at)
     SELECT @id, 'gphotos', @ref, @session, @taken, @status, @error, @now, @now WHERE ${SESSION_LIVE}
     ON CONFLICT (source, source_ref) DO NOTHING`,
  );
/** A never-read row picked again: a fresh download under the same id, in the new session (the 7-day clock restarts). */
const resetShot = (db: DB) =>
  db.prepare(
    `UPDATE contact_screenshots SET session_id = @session, taken_at = @taken, status = @status, error_class = @error, kind = NULL, person_id = NULL,
       found = '{}', attempts = 0, created_at = @now, updated_at = @now
     WHERE id = @id AND ${AGAIN} AND ${SESSION_LIVE}`,
  );
/** items_new is the number of the session's rows: a reset moves one row from its old session to the new one. */
const countNew = (db: DB) => db.prepare('UPDATE gphotos_sessions SET items_new = max(items_new + ?, 0) WHERE id = ?');

type Got = 'added' | 'skipped' | 'fenced';

/**
 * Downloads one picked photo into its file and row. After the download (an await: the owner may disconnect
 * meanwhile) the fence is checked again, then the file and the row are written in one synchronous step; a file whose
 * row didn't go in is deleted.
 */
async function downloadOne(db: DB, api: PickerApi, dataDir: string, sessionId: string, item: PickedItem, now: number, signal: AbortSignal): Promise<Got> {
  let media = await api.download(item.baseUrl!, 'normal', signal);
  if (media.bytes.length > MAX_RAW_BYTES) media = await api.download(item.baseUrl!, 'small', signal);
  if (!live(db, sessionId)) return 'fenced';
  const prior = db
    .prepare(`SELECT id, session_id AS session, ${AGAIN} AS again FROM contact_screenshots WHERE source = 'gphotos' AND source_ref = ?`)
    .get(item.id) as { id: string; session: string | null; again: number } | undefined;
  if (prior && !prior.again) return 'skipped';
  const id = prior?.id ?? uuidv7(now);
  let error: string | null = null;
  if (!media.bytes.length) error = 'empty';
  else if (media.bytes.length > MAX_RAW_BYTES) error = 'too_large';
  else if (media.contentType && !media.contentType.startsWith('image/')) error = 'not_image';
  if (!error) writeScreenshot(dataDir, id, media.bytes);
  const row = { id, ref: item.id, session: sessionId, taken: item.createdAt, status: error ? 'failed' : 'downloaded', error, now };
  const added = tx(db, () => {
    if (!(prior ? resetShot(db) : insertShot(db)).run(row).changes) return false;
    if (prior?.session !== sessionId) {
      countNew(db).run(1, sessionId);
      if (prior?.session) countNew(db).run(-1, prior.session);
    }
    return true;
  });
  if (!added && !error) deleteScreenshot(dataDir, id);
  return added ? 'added' : 'skipped';
}

/** One open or picked session: poll, list, download, delete. Returns true when a download was refused. */
async function handleSession(
  db: DB,
  api: PickerApi,
  s: SessionRow,
  o: { now: number; dataDir: string; budget: { left: number }; signal: AbortSignal; stats: Stats },
): Promise<boolean> {
  const { now, stats } = o;
  if (s.poll_after !== null && now < s.poll_after) return false;
  if (s.status === 'open') {
    let got;
    try {
      got = await api.getSession(s.id, o.signal);
    } catch (e) {
      sessionError(db, s, e, now, stats);
      return false;
    }
    bump(stats, 'polled');
    const expiresAt = got.expiresAt ?? s.expires_at;
    if (!got.mediaItemsSet) {
      if (got.timeoutInMs === 0) {
        setSession(db, s.id, now, { status: 'expired', expires_at: expiresAt });
        bump(stats, 'sessions_expired');
      } else setSession(db, s.id, now, { poll_after: now + pollDelay(got.pollIntervalMs), expires_at: expiresAt, error_class: null });
      return false;
    }
    if (!setSession(db, s.id, now, { status: 'picked', expires_at: expiresAt, error_class: null })) {
      bump(stats, 'fenced'); // cancelled while Google answered
      return false;
    }
    bump(stats, 'sessions_picked');
  }

  let items: PickedItem[];
  try {
    items = await api.listAllItems(s.id, o.signal);
  } catch (e) {
    sessionError(db, s, e, now, stats);
    return false;
  }
  bump(stats, 'listed');
  const seen = new Set<string>();
  const photos = items.filter((i) => i.type === 'PHOTO' && i.baseUrl && !seen.has(i.id) && seen.add(i.id));
  const known = new Set(
    db
      .prepare(
        `SELECT source_ref FROM contact_screenshots
         WHERE source = 'gphotos' AND source_ref IN (SELECT value FROM json_each(?)) AND (session_id IS ? OR NOT ${AGAIN})`,
      )
      .pluck()
      .all(JSON.stringify(photos.map((p) => p.id)), s.id) as string[],
  );
  let added = 0;
  let left = 0;
  let failed = 0;
  let refused = false;
  let fenced = false;
  for (const item of photos) {
    if (known.has(item.id)) continue;
    if (o.budget.left <= 0 || o.signal.aborted) {
      left++;
      continue;
    }
    if (!live(db, s.id)) {
      fenced = true;
      break;
    }
    o.budget.left--;
    try {
      const got = await downloadOne(db, api, o.dataDir, s.id, item, now, o.signal);
      if (got === 'added') added++;
      else if (got === 'fenced') {
        fenced = true;
        break;
      }
    } catch (e) {
      if (e instanceof PickerDownloadRefusedError) {
        refused = true;
        break;
      }
      if (e instanceof GoogleAuthError) throw e;
      if (e instanceof GoogleApiError) {
        failed++;
        continue;
      }
      throw e;
    }
  }
  bump(stats, 'downloaded', added);
  bump(stats, 'skipped_not_photo', items.filter((i) => i.type !== 'PHOTO' || !i.baseUrl).length);
  if (fenced) {
    // Cancelled (or Photos disconnected) while this pass ran: the session is the disconnect's now.
    bump(stats, 'fenced');
    return false;
  }
  db.prepare(`UPDATE gphotos_sessions SET items_total = ?, updated_at = ? WHERE id = ? AND status IN ('open','picked')`).run(items.length, now, s.id);
  if (refused) {
    setSession(db, s.id, now, { poll_after: now + REFUSED_RETRY_MS, error_class: 'download_refused' });
    bump(stats, 'refused');
    return true;
  }
  if (left || failed) {
    setSession(db, s.id, now, { poll_after: failed ? now + SESSION_ERROR_RETRY_MS : null, error_class: failed ? 'download_failed' : null });
    bump(stats, 'download_failed', failed);
    return false;
  }
  try {
    await api.deleteSession(s.id, o.signal);
  } catch (e) {
    if (e instanceof GoogleAuthError) throw e;
    bump(stats, 'delete_failed'); // the session expires on Google's side anyway
  }
  bump(stats, setSession(db, s.id, now, { status: 'done', error_class: null }) ? 'sessions_done' : 'fenced');
  return false;
}

// ---------------------------------------------------------------------------------------------- the pass

/** Health-detail counts; `linked` counts visible people only (person_canon → person_visible), like sessions.ts. */
const counts = (db: DB) =>
  db
    .prepare(
      `SELECT count(*) AS screenshots, coalesce(sum(${LINKED_VISIBLE}), 0) AS linked, coalesce(sum(cs.status = 'downloaded'), 0) AS pending,
         max(cs.created_at) AS newest FROM contact_screenshots cs`,
    )
    .get() as { screenshots: number; linked: number; pending: number; newest: number | null };

export async function runGphotos(ctx: JobContext, deps: GphotosDeps, ocr?: ScreenshotOcr): Promise<JobOutcome> {
  const { db } = ctx;
  const now = ctx.now();
  const stats: Stats = {};
  const hk = housekeeping(db, deps.dataDir, now);
  bump(stats, 'expired_files', hk.expired);
  bump(stats, 'pruned_files', hk.pruned);
  // Past its expireTime a session ends here, whatever Google or the stored token would say.
  const expired = db
    .prepare(`UPDATE gphotos_sessions SET status = 'expired', updated_at = ? WHERE status IN ('open','picked') AND expires_at IS NOT NULL AND expires_at <= ?`)
    .run(now, now).changes;
  bump(stats, 'sessions_expired', expired);
  const open = db
    .prepare(`SELECT id, status, expires_at, poll_after FROM gphotos_sessions WHERE status IN ('open','picked') ORDER BY created_at, id`)
    .all() as SessionRow[];
  const pendingBefore = db.prepare(`SELECT count(*) FROM contact_screenshots WHERE status = 'downloaded'`).pluck().get() as number;
  if (!open.length && !pendingBefore && !hk.expired && !hk.pruned && !expired) return { status: 'skipped', stats: { idle: 1 } };

  let authFailed = false;
  let refused = false;
  let tokenUnreadable = false;
  // The token is read whenever a session was open this pass, so an unreadable one stays reported after expiry.
  if (open.length || expired) {
    let photos: ReturnType<typeof photosApi> | undefined;
    try {
      photos = photosApi(db, deps);
    } catch {
      // The stored token can't be decrypted (SECRETS_KEY changed): the sessions wait, waiting files are still read.
      tokenUnreadable = true;
      bump(stats, 'token_unreadable');
    }
    if (photos === null) {
      for (const s of open) setSession(db, s.id, now, { status: 'failed', error_class: 'not_connected' });
      bump(stats, 'sessions_failed', open.length);
    } else if (photos) {
      const budget = { left: DOWNLOADS_PER_PASS };
      try {
        for (const s of open) {
          if (ctx.signal.aborted) break;
          if (await handleSession(db, photos.api, s, { now, dataDir: deps.dataDir, budget, signal: ctx.signal, stats })) refused = true;
        }
      } catch (e) {
        if (!(e instanceof GoogleAuthError)) throw e;
        authFailed = true;
      }
    }
  }

  // OCR (no Google call): a collector without the route is retried every 15 min, its files wait.
  const ocrCursor = cursorMeta<{ routeMissingAt: number | null }>(readCursor(db, GPHOTOS_SOURCE, OCR_SCOPE));
  const pending = db.prepare(`SELECT count(*) FROM contact_screenshots WHERE status = 'downloaded'`).pluck().get() as number;
  const backoff = ocrCursor.routeMissingAt != null && now - ocrCursor.routeMissingAt < ROUTE_MISSING_RETRY_MS;
  // Only files that wait make a missing route worth reporting.
  let routeMissing = backoff && pending > 0;
  let unavailable = false;
  if (pending && !backoff && !ctx.signal.aborted) {
    const own = ocr ? null : ownOcr(deps);
    try {
      const st = await processPendingScreenshots(db, {
        dataDir: deps.dataDir,
        ocr: ocr ?? own!,
        now,
        jobRunId: ctx.jobRunId,
        region: regionForTimeZone(settingTimeZone(db)),
        signal: ctx.signal,
      });
      for (const [k, v] of Object.entries(st)) {
        if (k !== 'route_missing' && k !== 'unavailable') bump(stats, k === 'failed' ? 'shots_failed' : k === 'retry' ? 'ocr_retry' : k, v);
      }
      routeMissing = st.route_missing > 0;
      unavailable = st.unavailable > 0;
      if (routeMissing) writeCursor(db, GPHOTOS_SOURCE, OCR_SCOPE, '', now, { meta: { routeMissingAt: now } });
      else if (st.ocr > 0 && ocrCursor.routeMissingAt != null) writeCursor(db, GPHOTOS_SOURCE, OCR_SCOPE, '', now, { meta: { routeMissingAt: null } });
    } finally {
      await own?.close();
    }
  }
  if (routeMissing) bump(stats, 'ocr_route_missing');
  if (unavailable) bump(stats, 'collector_unavailable');

  // Read after the work: a disconnect during the pass leaves 'disabled', not the state the pass started from.
  const connected = isConnected(db, 'photos');
  const c = counts(db);
  const details = { connected, open_sessions: open.length, screenshots: c.screenshots, linked: c.linked, pending: c.pending };
  // A pass that never reached Google (no session due) can't tell a revoked grant is fixed: keep auth_required until a
  // Google call answers (reconnecting resets the health to 'unknown').
  const googleAnswered = (stats.polled ?? 0) + (stats.listed ?? 0) > 0;
  const prior = db.prepare('SELECT status FROM source_health WHERE source = ?').pluck().get(GPHOTOS_SOURCE) as string | undefined;
  if (connected && (authFailed || (!googleAnswered && prior === 'auth_required'))) {
    recordSourceHealth(db, GPHOTOS_SOURCE, now, 'auth_required', { error: AUTH_REQUIRED_TEXT, newestDataAt: c.newest, details });
  } else if (!connected) {
    recordSourceHealth(db, GPHOTOS_SOURCE, now, 'disabled', { error: NOT_CONNECTED_TEXT, newestDataAt: c.newest, details });
  } else if (tokenUnreadable) {
    recordSourceHealth(db, GPHOTOS_SOURCE, now, 'error', { error: TOKEN_UNREADABLE_TEXT, newestDataAt: c.newest, details });
  } else if ((stats.contract_broken ?? 0) > 0) {
    recordSourceHealth(db, GPHOTOS_SOURCE, now, 'contract_broken', { error: CONTRACT_TEXT, newestDataAt: c.newest, details });
  } else if (routeMissing) {
    recordSourceHealth(db, GPHOTOS_SOURCE, now, 'error', { error: UPDATE_COLLECTOR_TEXT, newestDataAt: c.newest, details });
  } else if (refused) {
    recordSourceHealth(db, GPHOTOS_SOURCE, now, 'error', { error: REFUSED_TEXT, newestDataAt: c.newest, details: { ...details, refused: 1 } });
  } else if (unavailable) {
    recordSourceHealth(db, GPHOTOS_SOURCE, now, 'error', { error: COLLECTOR_DOWN_TEXT, newestDataAt: c.newest, details });
  } else {
    recordSourceHealth(db, GPHOTOS_SOURCE, now, 'ok', { newestDataAt: c.newest, details });
  }
  const out = nonZero(stats);
  ctx.log.info('gphotos.pass', { job: 'gphotos', counts: out });
  if (authFailed) return { status: 'skipped', stats: { ...out, auth_required: 1 } };
  const partial =
    refused || routeMissing || unavailable || tokenUnreadable || (stats.session_errors ?? 0) > 0 || (stats.download_failed ?? 0) > 0 || (stats.contract_broken ?? 0) > 0;
  return { status: partial ? 'partial' : 'ok', stats: out };
}

const ownOcr = (deps: GphotosDeps): OcrClient =>
  new OcrClient({
    baseUrl: deps.collectorUrl ?? COLLECTOR_DEFAULT_URL,
    tokenFile: deps.collectorTokenFile ?? path.join(deps.dataDir, 'collector.token'),
    dispatcher: deps.collectorDispatcher,
  });

export function gphotosJobs(deps: GphotosDeps): JobDef[] {
  // One collector client for the job's lifetime: keep-alive connection and the cached token.
  let ocr: OcrClient | null = null;
  return [
    {
      name: 'gphotos',
      schedule: interval(GPHOTOS_INTERVAL_MS),
      leaseMs: 20 * MIN,
      run: (ctx) => runGphotos(ctx, deps, (ocr ??= ownOcr(deps))),
    },
  ];
}

// ---------------------------------------------------------------------------------------------- disconnect

/**
 * For the Photos disconnect route: cancels open sessions and deletes every downloaded file; rows still waiting for
 * OCR become 'expired'. With deleteData, every contact_screenshots row goes too (and the sessions' items_new with
 * them). All of that is local and synchronous, so a gphotos pass awaiting Google meanwhile finds it done and is fenced
 * out (see the header); only then are the sessions deleted at Google (best effort, when an API is given). Call it
 * before the photos secret is deleted.
 */
export async function disconnectGphotos(
  db: DB,
  o: { dataDir: string; deleteData?: boolean; api?: PickerApi | null; now?: number },
): Promise<{ sessions: number; files: number; screenshots: number }> {
  const now = o.now ?? Date.now();
  const open = db.prepare(`SELECT id FROM gphotos_sessions WHERE status IN ('open','picked')`).pluck().all() as string[];
  for (const id of open) setSession(db, id, now, { status: 'cancelled' });
  const files = pruneScreenshotFiles(o.dataDir);
  let screenshots = 0;
  if (o.deleteData) {
    screenshots = db.prepare('DELETE FROM contact_screenshots').run().changes;
    db.prepare('UPDATE gphotos_sessions SET items_new = 0 WHERE items_new <> 0').run();
  } else db.prepare(`UPDATE contact_screenshots SET status = 'expired', error_class = 'disconnected', updated_at = ? WHERE status = 'downloaded'`).run(now);
  if (o.api) for (const id of open) await o.api.deleteSession(id).catch(() => undefined);
  return { sessions: open.length, files, screenshots };
}
