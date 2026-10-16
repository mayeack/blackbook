/**
 * Partiful events → `events` (source 'partiful', class E: plain idempotent upserts on (source, source_event_id))
 * plus their partiful_event_sync row. A re-read only writes columns that changed and never blanks a descriptive
 * field an earlier read had (home-page lists carry less than getEventInfo). my_role is 'host' when I'm among
 * ownerIds (or the event came from getPublishedEvents); my_rsvp is my own guest record's status.
 */
import { createHash } from 'node:crypto';
import { uuidv7 } from '@yb/shared';
import type { DB } from '../../db/connection';
import { tx } from '../../db/tx';
import { mapGuestStatus, parseEvent, type ParsedEvent } from './schemas';

export const EVENT_URL = (id: string) => `https://partiful.com/e/${id}`;

/** Which call returned the event (a list name or getEventInfo). */
export type EventOrigin = 'getMyUpcomingEventsForHomePage' | 'getMyPastEventsForHomePage' | 'getMyRsvps' | 'getPublishedEvents' | 'getEventInfo';

export interface FoundEvent {
  ev: ParsedEvent;
  origins: Set<EventOrigin>;
}

/** Merges list results by id: later reads fill fields earlier ones lacked (raw objects are merged too). */
export function mergeFound(into: Map<string, FoundEvent>, ev: ParsedEvent, origin: EventOrigin): void {
  const cur = into.get(ev.id);
  if (!cur) {
    into.set(ev.id, { ev, origins: new Set([origin]) });
    return;
  }
  cur.origins.add(origin);
  const raw = { ...cur.ev.raw };
  for (const [k, v] of Object.entries(ev.raw)) if (raw[k] === undefined || raw[k] === null) raw[k] = v;
  const merged = parseEvent(raw);
  if (merged) cur.ev = merged;
}

interface EventRow {
  title: string | null;
  description: string | null;
  starts_at: number | null;
  ends_at: number | null;
  tz: string | null;
  location_text: string | null;
  url: string;
  my_role: string;
  my_rsvp: string | null;
  status: string | null;
  visibility: string | null;
  raw: string;
}

const RAW_MAX = 48_000;

/** The source payload kept in events.raw: description has its own column; oversized blobs are dropped. */
function rawJson(ev: ParsedEvent): string {
  const { description: _d, ...rest } = ev.raw;
  let s = JSON.stringify(rest);
  if (s.length <= RAW_MAX) return s;
  const small = Object.fromEntries(Object.entries(rest).filter(([, v]) => JSON.stringify(v ?? null).length <= 2_000));
  s = JSON.stringify(small);
  return s.length <= RAW_MAX ? s : JSON.stringify({ id: ev.id });
}

export function visibilityJson(ev: ParsedEvent): string | null {
  const v: Record<string, unknown> = {};
  if (ev.showGuestList !== null) v.showGuestList = ev.showGuestList;
  if (ev.showHostList !== null) v.showHostList = ev.showHostList;
  if (ev.showGuestCount !== null) v.showGuestCount = ev.showGuestCount;
  if (ev.visibility) v.visibility = ev.visibility;
  return Object.keys(v).length ? JSON.stringify(v) : null;
}

/** showGuestList from events.visibility (null when unknown). */
export function showGuestListOf(visibility: string | null): boolean | null {
  if (!visibility) return null;
  try {
    const v = JSON.parse(visibility) as { showGuestList?: unknown };
    return typeof v.showGuestList === 'boolean' ? v.showGuestList : null;
  } catch {
    return null;
  }
}

export const isHost = (ev: ParsedEvent, uid: string, origins?: ReadonlySet<EventOrigin>): boolean =>
  ev.ownerIds.includes(uid) || (origins?.has('getPublishedEvents') ?? false);

function toRow(f: FoundEvent, uid: string): EventRow {
  const ev = f.ev;
  const host = isHost(ev, uid, f.origins);
  const mine = ev.myGuest?.status ? mapGuestStatus(ev.myGuest.status).status : null;
  return {
    title: ev.title,
    description: ev.description,
    starts_at: ev.startsAt,
    ends_at: ev.endsAt,
    tz: ev.tz,
    location_text: ev.locationText,
    url: EVENT_URL(ev.id),
    my_role: host ? 'host' : 'guest',
    my_rsvp: mine ?? (host ? 'going' : null),
    status: ev.status,
    visibility: visibilityJson(ev),
    raw: rawJson(ev),
  };
}

/** Hash of what makes a guest-list re-read worthwhile (status, times, visibility, counts, hosts, my RSVP). */
export function contentHash(ev: ParsedEvent): string {
  const counts = Object.entries(ev.statusCounts).sort(([a], [b]) => a.localeCompare(b));
  const payload = [ev.status, ev.startsAt, ev.endsAt, ev.showGuestList, ev.showHostList, counts, ev.goingCount, ev.myGuest?.status ?? null, [...ev.ownerIds].sort()];
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
}

const KEEP_IF_NULL = ['title', 'description', 'starts_at', 'ends_at', 'tz', 'location_text', 'my_rsvp', 'status', 'visibility'] as const;

export interface UpsertResult {
  /** Partiful id → events.id */
  ids: Map<string, string>;
  created: number;
  updated: number;
}

/** Upserts events and their sync rows in one transaction. */
export function upsertEvents(db: DB, found: Iterable<FoundEvent>, uid: string, now: number): UpsertResult {
  const out: UpsertResult = { ids: new Map(), created: 0, updated: 0 };
  const get = db.prepare(
    `SELECT id, title, description, starts_at, ends_at, tz, location_text, url, my_role, my_rsvp, status, visibility, raw
     FROM events WHERE source = 'partiful' AND source_event_id = ?`,
  );
  const insert = db.prepare(
    `INSERT INTO events (id, source, source_event_id, kind, title, description, starts_at, ends_at, tz, location_text, url, my_role, my_rsvp,
       status, visibility, raw, created_at, updated_at)
     VALUES (@id, 'partiful', @sid, 'social', @title, @description, @starts_at, @ends_at, @tz, @location_text, @url, @my_role, @my_rsvp,
       @status, @visibility, @raw, @now, @now)`,
  );
  const sync = db.prepare(
    `INSERT INTO partiful_event_sync (event_id, first_api_at, last_api_at, content_hash, going_count, probe_status, updated_at)
     VALUES (@sid, @now, @now, @hash, @going, @probe, @now)
     ON CONFLICT (event_id) DO UPDATE SET first_api_at = coalesce(partiful_event_sync.first_api_at, excluded.first_api_at),
       last_api_at = excluded.last_api_at, content_hash = excluded.content_hash,
       going_count = coalesce(excluded.going_count, partiful_event_sync.going_count),
       probe_status = coalesce(excluded.probe_status, partiful_event_sync.probe_status), updated_at = excluded.updated_at`,
  );
  tx(db, () => {
    for (const f of found) {
      const row = toRow(f, uid);
      const cur = get.get(f.ev.id) as ({ id: string } & EventRow) | undefined;
      if (!cur) {
        const id = uuidv7(now);
        insert.run({ id, sid: f.ev.id, ...row, now });
        out.ids.set(f.ev.id, id);
        out.created++;
      } else {
        const next: EventRow = { ...row };
        for (const k of KEEP_IF_NULL) if (next[k] === null) (next as unknown as Record<string, unknown>)[k] = cur[k];
        const changed = (Object.keys(next) as (keyof EventRow)[]).filter((k) => next[k] !== cur[k]);
        if (changed.length) {
          db.prepare(`UPDATE events SET ${changed.map((c) => `${c} = @${c}`).join(', ')}, updated_at = @now WHERE id = @id`).run({
            ...Object.fromEntries(changed.map((c) => [c, next[c]])),
            now,
            id: cur.id,
          });
          out.updated++;
        }
        out.ids.set(f.ev.id, cur.id);
      }
      sync.run({ sid: f.ev.id, now, hash: contentHash(f.ev), going: f.ev.goingCount, probe: f.origins.has('getEventInfo') ? 'found' : null });
    }
  });
  return out;
}

/** A stored Partiful event, re-parsed from events.raw (for events not returned by this run's lists). */
export interface StoredEvent {
  rowId: string;
  ev: ParsedEvent;
  title: string | null;
  startsAt: number | null;
  myRole: string | null;
  myRsvp: string | null;
  status: string | null;
  visibility: string | null;
  contentHash: string | null;
  guestsHash: string | null;
  guestsFetchedAt: number | null;
  guestsStatus: string | null;
  goingCount: number | null;
}

interface StoredRow {
  id: string;
  source_event_id: string;
  title: string | null;
  starts_at: number | null;
  my_role: string | null;
  my_rsvp: string | null;
  status: string | null;
  visibility: string | null;
  raw: string | null;
  content_hash: string | null;
  guests_hash: string | null;
  guests_fetched_at: number | null;
  guests_status: string | null;
  going_count: number | null;
}

function fromStored(r: StoredRow): StoredEvent | null {
  let raw: Record<string, unknown> = { id: r.source_event_id };
  try {
    const parsed = r.raw ? (JSON.parse(r.raw) as unknown) : null;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = { ...(parsed as Record<string, unknown>), id: r.source_event_id };
  } catch {
    // keep the bare id
  }
  const ev = parseEvent(raw);
  if (!ev) return null;
  return {
    rowId: r.id,
    ev,
    title: r.title,
    startsAt: r.starts_at,
    myRole: r.my_role,
    myRsvp: r.my_rsvp,
    status: r.status,
    visibility: r.visibility,
    contentHash: r.content_hash,
    guestsHash: r.guests_hash,
    guestsFetchedAt: r.guests_fetched_at,
    guestsStatus: r.guests_status,
    goingCount: r.going_count,
  };
}

const STORED_SQL = `SELECT e.id, e.source_event_id, e.title, e.starts_at, e.my_role, e.my_rsvp, e.status, e.visibility, e.raw,
    s.content_hash, s.guests_hash, s.guests_fetched_at, s.guests_status, s.going_count
  FROM events e JOIN partiful_event_sync s ON s.event_id = e.source_event_id
  WHERE e.source = 'partiful' AND s.last_api_at IS NOT NULL`;

/** Every Partiful event the API has returned (the guest-list scheduler's input). */
export function storedEvents(db: DB): StoredEvent[] {
  return (db.prepare(STORED_SQL).all() as StoredRow[]).map(fromStored).filter((e): e is StoredEvent => e !== null);
}

export function storedEvent(db: DB, rowId: string): StoredEvent | null {
  const r = db.prepare(`${STORED_SQL} AND e.id = ?`).get(rowId) as StoredRow | undefined;
  return r ? fromStored(r) : null;
}
