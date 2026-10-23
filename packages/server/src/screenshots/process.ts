/**
 * The OCR step of the gphotos job (design §3 "OCR"): up to 50 downloaded screenshots per pass, oldest first.
 * Each one: read `<dataDir>/screenshots/<id>.img` → collector POST /v1/vision/ocr → extract.ts → resolve.ts →
 * the contact_screenshots row (status, kind, person, found counts) → the file is deleted. All resolution writes of
 * a pass share one journaled run (runs.kind 'import'); a row and the people it created commit together.
 *   - A collector without the route (OcrRouteMissingError) or one that can't be reached stops the step: the files
 *     wait for the next pass (and 7 days at most, see adapters/gphotos/jobs.ts).
 *   - 413 is final: failed, payload_too_large. image_unreadable is final too. Other collector errors retry up to
 *     MAX_ATTEMPTS passes, then the row fails.
 *   - The disconnect fence: the Photos disconnect expires or deletes waiting rows, possibly while one is being read
 *     (the OCR call is an await). Only a row still 'downloaded' is read, resolved (checked again inside the
 *     transaction, before any person is created) or updated; the others are skipped and counted `fenced`.
 * `found` holds counts and the Instagram follower count only (`{phones, emails, handles, name, followers?, via? |
 * reason?}`);
 * the recognized text is never stored, logged or sent to an LLM.
 */
import type { CountryCode } from 'libphonenumber-js';
import type { DB } from '../db/connection';
import { tx } from '../db/tx';
import { sourceRun } from '../adapters/common/context';
import { deleteScreenshot, readScreenshot } from '../adapters/gphotos/files';
import { CollectorContractError, CollectorHttpError, CollectorUnavailableError, OcrRouteMissingError, type ScreenshotOcr } from './ocr';
import { extractContact, hasIdentifiers, type ExtractedContact } from './extract';
import { resolveScreenshot, type ScreenshotResolution } from './resolve';

export const SCREENSHOT_SOURCE = 'screenshot';
export const OCR_BATCH = 50;
export const MAX_ATTEMPTS = 3;

export interface ProcessOptions {
  dataDir: string;
  ocr: ScreenshotOcr;
  now: number;
  jobRunId?: number | null;
  region?: CountryCode;
  limit?: number;
  signal?: AbortSignal;
}

export interface ProcessStats {
  ocr: number;
  linked: number;
  created: number;
  ambiguous: number;
  self: number;
  no_text: number;
  no_contact: number;
  failed: number;
  retry: number;
  /** 1 when the collector has no OCR route (update it). */
  route_missing: number;
  /** 1 when the collector couldn't be reached (token missing, refused, timeout). */
  unavailable: number;
  /** Rows a disconnect expired or deleted while the pass was reading them: skipped. */
  fenced: number;
}

type FinalStatus = 'no_text' | 'no_contact' | 'linked' | 'ambiguous' | 'self' | 'failed';

interface PendingRow {
  id: string;
  taken_at: number | null;
  attempts: number;
}

export interface FoundSummary {
  phones: number;
  emails: number;
  handles: number;
  name: boolean;
  followers?: number;
  /** Which identifier linked it (linked rows). */
  via?: string;
  /** Why no person was picked (ambiguous rows). */
  reason?: string;
}

export function foundSummary(ex: ExtractedContact, r?: ScreenshotResolution): FoundSummary {
  return {
    phones: ex.phones.length,
    emails: ex.emails.length,
    handles: ex.handles.length,
    name: ex.name !== null,
    ...(ex.followers !== null ? { followers: ex.followers } : {}),
    ...(r?.status === 'linked' ? { via: r.via } : r?.status === 'ambiguous' ? { reason: r.reason } : {}),
  };
}

export async function processPendingScreenshots(db: DB, o: ProcessOptions): Promise<ProcessStats> {
  const stats: ProcessStats = {
    ocr: 0,
    linked: 0,
    created: 0,
    ambiguous: 0,
    self: 0,
    no_text: 0,
    no_contact: 0,
    failed: 0,
    retry: 0,
    route_missing: 0,
    unavailable: 0,
    fenced: 0,
  };
  const rows = db
    .prepare(`SELECT id, taken_at, attempts FROM contact_screenshots WHERE status = 'downloaded' ORDER BY created_at, id LIMIT ?`)
    .all(o.limit ?? OCR_BATCH) as PendingRow[];
  if (!rows.length) return stats;
  const run = sourceRun(db, SCREENSHOT_SOURCE, { now: o.now, jobRunId: o.jobRunId ?? null, kind: 'import' });
  // Every write is fenced on the row still waiting: a disconnect may have expired or deleted it meanwhile.
  const waiting = db.prepare(`SELECT 1 FROM contact_screenshots WHERE id = ? AND status = 'downloaded'`).pluck();
  const finish = db.prepare(
    `UPDATE contact_screenshots SET status = @status, kind = @kind, person_id = @person, found = @found, attempts = attempts + 1,
       error_class = @error, updated_at = @now WHERE id = @id AND status = 'downloaded'`,
  );
  const retry = db.prepare(`UPDATE contact_screenshots SET attempts = attempts + 1, error_class = ?, updated_at = ? WHERE id = ? AND status = 'downloaded'`);
  type Final = { kind?: string | null; person?: string | null; found?: object; error?: string | null };
  const record = (id: string, status: FinalStatus, p: Final): boolean => {
    const row = { id, status, kind: p.kind ?? null, person: p.person ?? null, found: JSON.stringify(p.found ?? {}), error: p.error ?? null, now: o.now };
    return finish.run(row).changes > 0;
  };
  /** A row the fence dropped: no waiting row owns its file any more. */
  const fenced = (id: string) => {
    deleteScreenshot(o.dataDir, id);
    stats.fenced++;
  };
  /** A final state: the row is written, then the file goes (never the other way round). */
  const done = (id: string, status: FinalStatus, p: Final = {}) => {
    if (!record(id, status, p)) return fenced(id);
    deleteScreenshot(o.dataDir, id);
    stats[status]++;
  };
  const again = (id: string, errorClass: string) => {
    if (!retry.run(errorClass, o.now, id).changes) return fenced(id);
    stats.retry++;
  };
  try {
    for (const row of rows) {
      if (o.signal?.aborted) break;
      if (waiting.get(row.id) === undefined) {
        fenced(row.id);
        continue;
      }
      const image = readScreenshot(o.dataDir, row.id);
      if (!image) {
        done(row.id, 'failed', { error: 'file_missing' });
        continue;
      }
      let lines;
      try {
        lines = (await o.ocr.ocr(image)).lines;
        stats.ocr++;
      } catch (e) {
        if (e instanceof OcrRouteMissingError) {
          stats.route_missing = 1;
          break;
        }
        if (e instanceof CollectorUnavailableError) {
          stats.unavailable = 1;
          break;
        }
        if (e instanceof CollectorHttpError && e.status === 401) {
          stats.unavailable = 1; // the token file is stale even after a re-read: nothing else will pass either
          break;
        }
        if (e instanceof CollectorHttpError && (e.status === 413 || e.code === 'payload_too_large' || e.code === 'image_unreadable')) {
          done(row.id, 'failed', { error: e.status === 413 ? 'payload_too_large' : e.code });
          continue;
        }
        const errorClass = e instanceof CollectorHttpError ? `http_${e.status}` : e instanceof CollectorContractError ? 'contract' : 'ocr_error';
        if (row.attempts + 1 >= MAX_ATTEMPTS) done(row.id, 'failed', { error: errorClass });
        else again(row.id, errorClass);
        continue;
      }
      if (!lines.some((l) => l.text.trim())) {
        done(row.id, 'no_text');
        continue;
      }
      const ex = extractContact(lines, { region: o.region });
      if (!hasIdentifiers(ex)) {
        done(row.id, 'no_contact', { kind: ex.kind, found: foundSummary(ex) });
        continue;
      }
      try {
        // The people a screenshot creates and its row commit together; the file goes once both are stored. A row no
        // longer waiting (a disconnect during the OCR call) creates nobody.
        const r = tx(db, () => {
          if (waiting.get(row.id) === undefined) return null;
          const res = resolveScreenshot(run.ctx, ex, { at: row.taken_at ?? o.now });
          record(row.id, res.status, { kind: ex.kind, person: res.status === 'linked' ? res.personId : null, found: foundSummary(ex, res) });
          return res;
        });
        if (!r) {
          fenced(row.id);
          continue;
        }
        deleteScreenshot(o.dataDir, row.id);
        stats[r.status]++;
        if (r.status === 'linked' && r.created) stats.created++;
      } catch (e) {
        const errorClass = (e as Error)?.name && /^[A-Za-z]{1,40}$/.test((e as Error).name) ? (e as Error).name : 'resolve_error';
        if (row.attempts + 1 >= MAX_ATTEMPTS) done(row.id, 'failed', { kind: ex.kind, error: errorClass });
        else again(row.id, errorClass);
      }
    }
  } finally {
    run.finish('ok', { screenshots: stats.ocr, linked: stats.linked, created: stats.created });
  }
  return stats;
}
