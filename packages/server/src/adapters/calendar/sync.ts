/**
 * Google Calendar sync (job `gcal`, every 30 min while connected; PLAN "Ingestion → Google Calendar").
 *   1. calendarList → gcal_calendars with default treatments; calendars no longer listed get removed_at.
 *   2. For each listed calendar whose effective treatment isn't 'excluded': events.list with singleEvents and
 *      showDeleted, paged. With a stored syncToken (source_cursors 'gcal' / 'cal:<id>') only changes come back;
 *      without one, or after a 410, a full listing of −400…+60 days replaces it, and rows in that window the
 *      listing no longer has are marked cancelled.
 *   3. A sync token never brings back instances of a recurring series that were outside the first window, so
 *      once a week the window's far end is extended with a plain listing of the new days (the token is kept).
 * calendar_events are episodes: plain idempotent upserts keyed on (calendar_id, google_event_id), never
 * journaled; a listing older than the stored row (by `updated`) never overwrites it. One calendar failing (404,
 * 403, rate limit) doesn't stop the others; an auth failure stops the pass.
 * Data minimisation: an excluded or removed calendar keeps no synced events (purgeUnusedCalendars), and the
 * owner can delete everything synced when he disconnects (deleteCalendarData).
 */
import { uuidv7 } from '@yb/shared';
import type { DB } from '../../db/connection';
import { tx } from '../../db/tx';
import { nullLogger, type Logger } from '../../ops/logger';
import { cursorMeta, deleteCursor, readCursor, writeCursor } from '../common/cursors';
import {
  GoogleAuthError,
  GoogleEgressRefusedError,
  SyncTokenGoneError,
  type CalendarApi,
  type CalendarListEntry,
  type EventsQuery,
  type GoogleEvent,
} from './google';
import { toRow, type CalendarEventRow } from './mapping';
import { defaultTreatment } from './treatment';

export const GCAL_SOURCE = 'gcal';
export const cursorScope = (calendarId: string) => `cal:${calendarId}`;

const DAY = 86_400_000;
export const PAST_DAYS = 400;
export const FUTURE_DAYS = 60;
/** Extend the window once its far end is this much behind now + FUTURE_DAYS. */
const EXTEND_STEP_MS = 7 * DAY;
/** Reconciliation after a full listing skips a day at each edge (window boundaries vs. all-day dates). */
const RECONCILE_MARGIN_MS = DAY;
const MAX_PAGES = 200;

export interface CalendarSyncStats {
  calendars: number;
  included: number;
  synced: number;
  failed: number;
  removed_calendars: number;
  /** Synced events dropped because their calendar is excluded or no longer listed. */
  purged_events: number;
  full_syncs: number;
  resyncs: number;
  extensions: number;
  pages: number;
  inserted: number;
  updated: number;
  unchanged: number;
  stale: number;
  cancelled: number;
  unknown_cancelled: number;
  reconciled: number;
}

const emptyStats = (): CalendarSyncStats => ({
  calendars: 0,
  included: 0,
  synced: 0,
  failed: 0,
  removed_calendars: 0,
  purged_events: 0,
  full_syncs: 0,
  resyncs: 0,
  extensions: 0,
  pages: 0,
  inserted: 0,
  updated: 0,
  unchanged: 0,
  stale: 0,
  cancelled: 0,
  unknown_cancelled: 0,
  reconciled: 0,
});

export interface SyncOptions {
  now?: number;
  signal?: AbortSignal;
  log?: Logger;
}

interface CursorMeta {
  windowStart: number;
  windowEnd: number;
  fullAt: number;
}

interface Target {
  calendar_id: string;
  time_zone: string | null;
  kind: string;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Upserts the calendar list (defaults recomputed) and marks calendars that disappeared. */
export function upsertCalendars(db: DB, entries: CalendarListEntry[], now: number): { listed: number; removed: number } {
  const upsert = db.prepare(
    `INSERT INTO gcal_calendars (calendar_id, summary, time_zone, access_role, is_primary, kind, default_treatment,
       default_partiful_linked, removed_at, first_seen_at, last_listed_at, updated_at)
     VALUES (@id, @summary, @tz, @role, @primary, @kind, @treatment, @partiful, NULL, @now, @now, @now)
     ON CONFLICT (calendar_id) DO UPDATE SET summary = excluded.summary, time_zone = excluded.time_zone,
       access_role = excluded.access_role, is_primary = excluded.is_primary, kind = excluded.kind,
       default_treatment = excluded.default_treatment, default_partiful_linked = excluded.default_partiful_linked,
       removed_at = NULL, last_listed_at = excluded.last_listed_at, updated_at = excluded.updated_at`,
  );
  return tx(db, () => {
    const listed = entries.filter((e) => !e.deleted);
    for (const e of listed) {
      const d = defaultTreatment(e);
      upsert.run({
        id: e.id,
        summary: e.summaryOverride?.trim() || e.summary || null,
        tz: e.timeZone ?? null,
        role: e.accessRole ?? null,
        primary: e.primary ? 1 : 0,
        kind: d.kind,
        treatment: d.treatment,
        partiful: d.partifulLinked ? 1 : 0,
        now,
      });
    }
    // An empty list (never seen in practice: the primary calendar is always there) is not taken as "all removed".
    if (!listed.length) return { listed: 0, removed: 0 };
    const ids = new Set(listed.map((e) => e.id));
    const present = db.prepare('SELECT calendar_id FROM gcal_calendars WHERE removed_at IS NULL').pluck().all() as string[];
    const gone = present.filter((id) => !ids.has(id));
    const mark = db.prepare('UPDATE gcal_calendars SET removed_at = ?, updated_at = ? WHERE calendar_id = ?');
    for (const id of gone) mark.run(now, now, id);
    return { listed: listed.length, removed: gone.length };
  });
}

/**
 * A calendar that is excluded (the owner's choice or its default) or no longer in his calendar list keeps none of its
 * synced events (PLAN "Calendars", "Safety and privacy"): its calendar_events rows and its sync cursor go, so
 * including it again starts with a full listing. The next occasions pass retires the occasions built from them.
 */
export function purgeUnusedCalendars(db: DB): number {
  return tx(db, () => {
    const ids = db.prepare(`SELECT calendar_id FROM gcal_calendar_treatment WHERE treatment = 'excluded' OR removed_at IS NOT NULL`).pluck().all() as string[];
    if (!ids.length) return 0;
    db.prepare('DELETE FROM source_cursors WHERE source = ? AND scope IN (SELECT value FROM json_each(?))').run(GCAL_SOURCE, JSON.stringify(ids.map(cursorScope)));
    return db.prepare('DELETE FROM calendar_events WHERE calendar_id IN (SELECT value FROM json_each(?))').run(JSON.stringify(ids)).changes;
  });
}

/** Disconnect's "also delete synced calendar data": every synced event and calendar, and the sync cursors. */
export function deleteCalendarData(db: DB): { events: number; calendars: number } {
  return tx(db, () => {
    db.prepare('DELETE FROM source_cursors WHERE source = ?').run(GCAL_SOURCE);
    return { events: db.prepare('DELETE FROM calendar_events').run().changes, calendars: db.prepare('DELETE FROM gcal_calendars').run().changes };
  });
}

class EventWriter {
  private readonly find;
  private readonly insert;
  private readonly update;
  private readonly cancel;
  private readonly cancelSeries;

  constructor(
    private readonly db: DB,
    private readonly stats: CalendarSyncStats,
    private readonly now: number,
  ) {
    this.find = db.prepare('SELECT id, etag, status, remote_updated_at FROM calendar_events WHERE calendar_id = ? AND google_event_id = ?');
    this.insert = db.prepare(
      `INSERT INTO calendar_events (id, calendar_id, google_event_id, ical_uid, recurring_event_id, status, summary, description,
         location, starts_at, ends_at, all_day, tz, start_date, end_date, original_start_at, organizer_email, creator_email,
         self_organizer, self_response, attendees, html_link, partiful_event_id, event_type, etag, remote_updated_at, raw,
         ingested_at, updated_at)
       VALUES (@id, @calendar_id, @google_event_id, @ical_uid, @recurring_event_id, @status, @summary, @description,
         @location, @starts_at, @ends_at, @all_day, @tz, @start_date, @end_date, @original_start_at, @organizer_email,
         @creator_email, @self_organizer, @self_response, @attendees, @html_link, @partiful_event_id, @event_type, @etag,
         @remote_updated_at, @raw, @now, @now)`,
    );
    this.update = db.prepare(
      `UPDATE calendar_events SET ical_uid = @ical_uid, recurring_event_id = @recurring_event_id, status = @status,
         summary = @summary, description = @description, location = @location, starts_at = @starts_at, ends_at = @ends_at,
         all_day = @all_day, tz = @tz, start_date = @start_date, end_date = @end_date, original_start_at = @original_start_at,
         organizer_email = @organizer_email, creator_email = @creator_email, self_organizer = @self_organizer,
         self_response = @self_response, attendees = @attendees, html_link = @html_link,
         partiful_event_id = @partiful_event_id, event_type = @event_type, etag = @etag,
         remote_updated_at = @remote_updated_at, raw = @raw, updated_at = @now
       WHERE id = @id`,
    );
    this.cancel = db.prepare(
      `UPDATE calendar_events SET status = 'cancelled', etag = coalesce(?, etag), remote_updated_at = coalesce(?, remote_updated_at),
         updated_at = ? WHERE id = ?`,
    );
    this.cancelSeries = db.prepare(
      `UPDATE calendar_events SET status = 'cancelled', updated_at = ?
       WHERE calendar_id = ? AND recurring_event_id = ? AND status <> 'cancelled'`,
    );
  }

  apply(calendarId: string, ev: GoogleEvent, calendarTz: string | null): void {
    const existing = this.find.get(calendarId, ev.id) as
      | { id: string; etag: string | null; status: string; remote_updated_at: number | null }
      | undefined;
    const updatedAt = ev.updated ? Date.parse(ev.updated) : NaN;
    const remoteUpdated = Number.isFinite(updatedAt) ? updatedAt : null;
    const stale = existing?.remote_updated_at != null && remoteUpdated != null && remoteUpdated < existing.remote_updated_at;

    if (ev.status === 'cancelled') {
      // A deleted series comes back as one cancelled master: retire every stored instance of it.
      if (!ev.recurringEventId) this.stats.cancelled += this.cancelSeries.run(this.now, calendarId, ev.id).changes;
      if (!existing) {
        this.stats.unknown_cancelled++;
        return;
      }
      if (stale) this.stats.stale++;
      else if (existing.status !== 'cancelled') {
        this.cancel.run(ev.etag ?? null, remoteUpdated, this.now, existing.id);
        this.stats.cancelled++;
      } else this.stats.unchanged++;
      return;
    }

    const row: CalendarEventRow = toRow(calendarId, ev, calendarTz);
    if (!existing) {
      this.insert.run({ ...row, id: uuidv7(this.now), now: this.now });
      this.stats.inserted++;
    } else if (stale) {
      this.stats.stale++;
    } else if (existing.etag !== null && existing.etag === row.etag && existing.status === row.status) {
      this.stats.unchanged++;
    } else {
      this.update.run({ ...row, id: existing.id, now: this.now });
      this.stats.updated++;
    }
  }
}

/** One calendar: incremental with its sync token, else (or after 410) a full listing; then window upkeep. */
async function syncCalendar(db: DB, api: CalendarApi, target: Target, stats: CalendarSyncStats, now: number, signal?: AbortSignal): Promise<void> {
  const writer = new EventWriter(db, stats, now);
  const scope = cursorScope(target.calendar_id);
  let calendarTz = target.time_zone;

  /** Pages through one listing, writing each page in its own transaction. Returns the final nextSyncToken. */
  const list = async (q: EventsQuery, onEvent?: (ev: GoogleEvent) => void): Promise<string | null> => {
    let pageToken: string | undefined;
    for (let n = 0; n < MAX_PAGES; n++) {
      if (signal?.aborted) throw signal.reason ?? new Error('aborted');
      const page = await api.listEvents(target.calendar_id, { ...q, pageToken }, signal);
      stats.pages++;
      calendarTz = calendarTz ?? page.timeZone;
      tx(db, () => {
        for (const ev of page.items) {
          onEvent?.(ev);
          writer.apply(target.calendar_id, ev, calendarTz);
        }
      });
      if (!page.nextPageToken) return page.nextSyncToken;
      pageToken = page.nextPageToken;
    }
    throw new Error('events.list returned too many pages');
  };

  const full = async () => {
    const windowStart = now - PAST_DAYS * DAY;
    const windowEnd = now + FUTURE_DAYS * DAY;
    const seen = new Set<string>();
    const token = await list({ timeMin: iso(windowStart), timeMax: iso(windowEnd) }, (ev) => seen.add(ev.id));
    stats.full_syncs++;
    tx(db, () => {
      const rows = db
        .prepare(
          `SELECT id, google_event_id FROM calendar_events
           WHERE calendar_id = ? AND status <> 'cancelled' AND starts_at >= ? AND starts_at < ?`,
        )
        .all(target.calendar_id, windowStart + RECONCILE_MARGIN_MS, windowEnd - RECONCILE_MARGIN_MS) as { id: string; google_event_id: string }[];
      const retire = db.prepare(`UPDATE calendar_events SET status = 'cancelled', updated_at = ? WHERE id = ?`);
      for (const r of rows) {
        if (seen.has(r.google_event_id)) continue;
        retire.run(now, r.id);
        stats.reconciled++;
      }
      if (token) writeCursor(db, GCAL_SOURCE, scope, token, now, { meta: { windowStart, windowEnd, fullAt: now } satisfies CursorMeta });
      else deleteCursor(db, GCAL_SOURCE, scope);
    });
  };

  const cursor = readCursor(db, GCAL_SOURCE, scope);
  if (!cursor) {
    await full();
  } else {
    const meta = cursorMeta<CursorMeta>(cursor);
    try {
      const token = await list({ syncToken: cursor.cursor });
      writeCursor(db, GCAL_SOURCE, scope, token ?? cursor.cursor, now);
    } catch (e) {
      if (!(e instanceof SyncTokenGoneError)) throw e;
      deleteCursor(db, GCAL_SOURCE, scope);
      stats.resyncs++;
      await full();
      return finishCalendar(db, target.calendar_id, now);
    }
    const wantEnd = now + FUTURE_DAYS * DAY;
    const windowEnd = typeof meta.windowEnd === 'number' ? meta.windowEnd : null;
    if (windowEnd === null || wantEnd - windowEnd >= EXTEND_STEP_MS) {
      await list({ timeMin: iso(windowEnd ?? now), timeMax: iso(wantEnd) });
      stats.extensions++;
      writeCursor(db, GCAL_SOURCE, scope, readCursor(db, GCAL_SOURCE, scope)!.cursor, now, { meta: { ...meta, windowEnd: wantEnd } });
    }
  }
  finishCalendar(db, target.calendar_id, now);
}

function finishCalendar(db: DB, calendarId: string, now: number): void {
  db.prepare('UPDATE gcal_calendars SET last_synced_at = ? WHERE calendar_id = ?').run(now, calendarId);
}

/** A full pass over every calendar. Throws GoogleAuthError (reconnect needed) and contract/network errors on the list call. */
export async function syncCalendars(db: DB, api: CalendarApi, o: SyncOptions = {}): Promise<CalendarSyncStats> {
  const now = o.now ?? Date.now();
  const log = o.log ?? nullLogger;
  const stats = emptyStats();
  const entries = await api.listCalendars(o.signal);
  const { listed, removed } = upsertCalendars(db, entries, now);
  stats.calendars = listed;
  stats.removed_calendars = removed;
  stats.purged_events = purgeUnusedCalendars(db);

  const targets = db
    .prepare(
      `SELECT c.calendar_id, c.time_zone, c.kind FROM gcal_calendars c JOIN gcal_calendar_treatment t USING (calendar_id)
       WHERE c.removed_at IS NULL AND t.treatment <> 'excluded' ORDER BY c.is_primary DESC, c.first_seen_at, c.calendar_id`,
    )
    .all() as Target[];
  stats.included = targets.length;
  for (const target of targets) {
    if (o.signal?.aborted) break;
    try {
      await syncCalendar(db, api, target, stats, now, o.signal);
      stats.synced++;
    } catch (e) {
      if (e instanceof GoogleAuthError || e instanceof GoogleEgressRefusedError || o.signal?.aborted) throw e;
      stats.failed++;
      // Never the calendar id (the primary one is an email address): its kind and the error class only.
      const err = e as { name?: string; reason?: string; status?: number | null };
      log.warn('gcal.calendar_failed', {
        error_class: err.name ?? 'Error',
        error_code: typeof err.reason === 'string' ? err.reason : undefined,
        status: typeof err.status === 'number' ? err.status : undefined,
        counts: { [`kind_${target.kind}`]: 1 },
      });
    }
  }
  return stats;
}
