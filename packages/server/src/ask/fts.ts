/**
 * Ask retrieval indexes (intelligence §7 "Retrieval"):
 *   messages_fts  unicode61 over messages.text (001, trigger-maintained)        → prefix queries stand in for stemming
 *   facts_fts     unicode61 over facts.value (001, trigger-maintained)
 *   people_fts    trigram over names / aliases / org / places (001; maintained HERE, one row per visible
 *                 canonical person, rowid = ask_fts_docs.n)
 *   ask_events_fts trigram over occasion / Partiful titles and venues (018; maintained HERE)
 *
 * The two app-maintained indexes refresh lazily before a search: incrementally (rows changed since the watermark,
 * minus a slack for writers whose clocks run a little behind) and fully every FULL_EVERY_MS, so an undo that
 * restores an older updated_at is caught by the next full pass. Work is chunked and yields the event loop
 * between chunks (the 10 s iMessage tail stays responsive). Concurrent callers share one refresh.
 */
import { setImmediate as yieldLoop } from 'node:timers/promises';
import type { DB } from '../db/connection';

export const FULL_EVERY_MS = 6 * 3_600_000;
const SLACK_MS = 10_000;
const CHUNK = 200;

// ---------------------------------------------------------------------------------------------- query builders

const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'’]*/gu;

/** Normalized search terms (lowercased, ≤ 8, deduped; apostrophes dropped). */
export function ftsTerms(q: string | null | undefined, max = 8): string[] {
  const out: string[] = [];
  for (const m of (q ?? '').toLowerCase().matchAll(WORD_RE)) {
    const t = m[0].replace(/['’]/g, '');
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

/** A term as an FTS5 string (quotes doubled, so no term can be FTS syntax). */
const quote = (t: string) => `"${t.replace(/"/g, '""')}"`;

/** unicode61 MATCH expression: each term as a prefix (`"ski"*`), AND or OR. Null when there are no terms. */
export function unicodeMatch(terms: string[], mode: 'and' | 'or'): string | null {
  if (!terms.length) return null;
  const parts = terms.map((t) => ([...t].length >= 3 ? `${quote(t)}*` : quote(t)));
  return parts.join(mode === 'and' ? ' AND ' : ' OR ');
}

/** trigram MATCH expression (substring match; only terms of ≥ 3 characters can use the index). */
export function trigramMatch(terms: string[], mode: 'and' | 'or' = 'or'): string | null {
  const long = terms.filter((t) => [...t].length >= 3);
  if (!long.length) return null;
  return long.map(quote).join(mode === 'and' ? ' AND ' : ' OR ');
}

export const STOPWORDS = new Set(
  `a about after all also am an and any anyone are around as at be been before being both but by can could did do does doing
  done for friend friends from get go going got had has have he her here hers him his how i if in into is it its just know knows
  last lately like live lives living me met more most my near new next of on or our out over people person recently said say she should
  so some someone talk talked tell than that the their them then there these they this those to told up us was we were what when
  where which who whom whose why will with would you your anybody everyone everybody somebody any most best
  ever never often still since ago`.split(/\s+/),
);

/** Content words of a natural-language question (degraded retrieval). */
export function keywords(q: string, max = 6): string[] {
  return ftsTerms(q, 20)
    .filter((t) => !STOPWORDS.has(t) && (t.length > 1 || /\d/.test(t)))
    .slice(0, max);
}

// ---------------------------------------------------------------------------------------------- doc surrogates

export type DocKind = 'person' | 'occasion' | 'event';

/** The stable INTEGER surrogate for (kind, id), created on first use. */
export function docNumber(db: DB, kind: DocKind, refId: string, now = Date.now()): number {
  const got = db.prepare('SELECT n FROM ask_fts_docs WHERE kind = ? AND ref_id = ?').pluck().get(kind, refId) as number | undefined;
  if (got !== undefined) return got;
  return Number(db.prepare('INSERT INTO ask_fts_docs (kind, ref_id, created_at) VALUES (?, ?, ?)').run(kind, refId, now).lastInsertRowid);
}

export function docByNumber(db: DB, n: number): { kind: DocKind; refId: string } | null {
  const r = db.prepare('SELECT kind, ref_id FROM ask_fts_docs WHERE n = ?').get(n) as { kind: DocKind; ref_id: string } | undefined;
  return r ? { kind: r.kind, refId: r.ref_id } : null;
}

// ---------------------------------------------------------------------------------------------- people_fts

const PLACE_FACTS = ['location_current', 'home_location', 'hometown', 'location_next', 'address'];
const ORG_FACTS = ['employer', 'job', 'role', 'school', 'education'];

interface PersonDocRow {
  id: string;
  display_name: string;
  first_name: string | null;
  last_name: string | null;
  nickname: string | null;
  company: string | null;
  job_title: string | null;
}

const uniqJoin = (xs: (string | null | undefined)[], cap = 40) => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    const v = x?.trim();
    if (!v) continue;
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
    if (out.length >= cap) break;
  }
  return out.join(' | ');
};

function personDocText(db: DB, p: PersonDocRow, now: number): { names: string; aliases: string; org: string; places: string } {
  const cluster = db.prepare('SELECT person_id FROM person_canon WHERE canonical_id = ?').pluck().all(p.id) as string[];
  if (!cluster.includes(p.id)) cluster.push(p.id);
  const json = JSON.stringify(cluster);
  const aliases = db
    .prepare(
      `SELECT a.name_raw FROM alias_obs a JOIN identities i ON i.id = a.identity_id
       WHERE i.person_id IN (SELECT value FROM json_each(?)) AND i.status <> 'detached'
       ORDER BY a.seen_count DESC, a.last_seen_at DESC LIMIT 30`,
    )
    .pluck()
    .all(json) as string[];
  const identNames = db
    .prepare(
      `SELECT CASE WHEN kind IN ('instagram_username','x_username') THEN key ELSE display_name END
       FROM identities WHERE person_id IN (SELECT value FROM json_each(?)) AND status <> 'detached'
         AND (display_name IS NOT NULL OR kind IN ('instagram_username','x_username'))`,
    )
    .pluck()
    .all(json) as (string | null)[];
  const facts = db
    .prepare(
      `SELECT type, value FROM facts
       WHERE person_id IN (SELECT value FROM json_each(?)) AND status IN ('tentative','confirmed')
         AND retracted_at IS NULL AND superseded_at IS NULL AND sensitive = 0
         AND type IN (SELECT value FROM json_each(?))
         AND (valid_to IS NULL OR valid_to >= ? OR type = 'hometown')
       ORDER BY confidence DESC LIMIT 40`,
    )
    .all(json, JSON.stringify([...PLACE_FACTS, ...ORG_FACTS]), now) as { type: string; value: string }[];
  const locations = db
    .prepare(
      `SELECT DISTINCT l.name FROM person_locations pl JOIN locations l ON l.id = pl.location_id
       WHERE pl.person_id IN (SELECT value FROM json_each(?)) AND l.status = 'active'`,
    )
    .pluck()
    .all(json) as string[];
  // Records merged into this person: their names are aliases ("Sammy Rivera" finds Sam).
  const merged = db
    .prepare(`SELECT display_name, first_name, last_name, nickname FROM people WHERE id IN (SELECT value FROM json_each(?)) AND id <> ?`)
    .all(json, p.id) as { display_name: string; first_name: string | null; last_name: string | null; nickname: string | null }[];
  const fullName = [p.first_name, p.last_name].filter(Boolean).join(' ');
  return {
    names: uniqJoin([p.display_name, fullName, p.first_name, p.last_name, p.nickname]),
    aliases: uniqJoin([...merged.flatMap((m) => [m.display_name, m.first_name, m.nickname]), ...aliases, ...identNames]),
    org: uniqJoin([p.company, p.job_title, ...facts.filter((f) => ORG_FACTS.includes(f.type)).map((f) => f.value)]),
    places: uniqJoin([...facts.filter((f) => PLACE_FACTS.includes(f.type)).map((f) => f.value), ...locations]),
  };
}

function writePersonDoc(db: DB, personId: string, now: number): boolean {
  const p = db
    .prepare('SELECT id, display_name, first_name, last_name, nickname, company, job_title FROM person_visible WHERE id = ?')
    .get(personId) as PersonDocRow | undefined;
  const n = p ? docNumber(db, 'person', personId, now) : (db.prepare(`SELECT n FROM ask_fts_docs WHERE kind = 'person' AND ref_id = ?`).pluck().get(personId) as number | undefined);
  if (n === undefined) return false;
  db.prepare('DELETE FROM people_fts WHERE rowid = ?').run(n);
  if (!p) {
    db.prepare('UPDATE ask_fts_docs SET indexed = 0, indexed_at = ? WHERE n = ?').run(now, n);
    return false;
  }
  const t = personDocText(db, p, now);
  db.prepare('INSERT INTO people_fts (rowid, person_id, names, aliases, org, places) VALUES (?, ?, ?, ?, ?, ?)').run(n, p.id, t.names, t.aliases, t.org, t.places);
  db.prepare('UPDATE ask_fts_docs SET indexed = 1, indexed_at = ? WHERE n = ?').run(now, n);
  return true;
}

/** Canonical ids of people whose index text may have changed since `since`. */
function changedPeople(db: DB, since: number): string[] {
  const rows = db
    .prepare(
      `WITH touched(pid) AS (
         SELECT id FROM people WHERE updated_at > @s
         UNION SELECT person_id FROM facts WHERE updated_at > @s
         UNION SELECT person_id FROM identities WHERE updated_at > @s
         UNION SELECT i.person_id FROM alias_obs a JOIN identities i ON i.id = a.identity_id WHERE a.last_seen_at > @s
         UNION SELECT person_id FROM person_locations WHERE created_at > @s
         UNION SELECT pl.person_id FROM person_locations pl JOIN locations l ON l.id = pl.location_id WHERE l.updated_at > @s
         UNION SELECT survivor_id FROM merges WHERE created_at > @s OR undone_at > @s
         UNION SELECT merged_id FROM merges WHERE created_at > @s OR undone_at > @s
       )
       SELECT DISTINCT coalesce(pc.canonical_id, t.pid) FROM touched t LEFT JOIN person_canon pc ON pc.person_id = t.pid
       UNION SELECT pid FROM touched`,
    )
    .pluck()
    .all({ s: since }) as string[];
  return rows;
}

// ---------------------------------------------------------------------------------------------- ask_events_fts

/** Occasions and Partiful events Ask may show (mirrors the Events screen: social + trips, never sensitive). */
export const EVENT_KINDS = ['social', 'lodging', 'travel'] as const;
export const PARTIFUL_ATTENDING = `(lower(coalesce(e.my_rsvp, '')) IN ('going','approved','maybe','checked_in','attended') OR lower(coalesce(e.my_role, '')) IN ('host','co_host','cohost'))`;

function eventDocRow(db: DB, kind: 'occasion' | 'event', id: string): { title: string; place: string } | null {
  if (kind === 'occasion') {
    const o = db
      .prepare(
        `SELECT o.title, o.venue_text FROM occasions o
         WHERE o.id = ? AND o.merged_into_id IS NULL AND o.status = 'active' AND o.sensitive = 0
           AND o.kind IN (SELECT value FROM json_each(?))`,
      )
      .get(id, JSON.stringify(EVENT_KINDS)) as { title: string | null; venue_text: string | null } | undefined;
    return o ? { title: o.title ?? '', place: o.venue_text ?? '' } : null;
  }
  const e = db
    .prepare(
      `SELECT e.title, e.location_text FROM events e
       WHERE e.id = ? AND e.source = 'partiful' AND e.starts_at IS NOT NULL AND ${PARTIFUL_ATTENDING}
         AND NOT EXISTS (SELECT 1 FROM occasions o WHERE o.event_id = e.id AND o.merged_into_id IS NULL AND o.status IN ('active','candidate'))`,
    )
    .get(id) as { title: string | null; location_text: string | null } | undefined;
  return e ? { title: e.title ?? '', place: e.location_text ?? '' } : null;
}

function writeEventDoc(db: DB, kind: 'occasion' | 'event', id: string, now: number): boolean {
  const row = eventDocRow(db, kind, id);
  const n = row ? docNumber(db, kind, id, now) : (db.prepare('SELECT n FROM ask_fts_docs WHERE kind = ? AND ref_id = ?').pluck().get(kind, id) as number | undefined);
  if (n === undefined) return false;
  db.prepare('DELETE FROM ask_events_fts WHERE rowid = ?').run(n);
  if (!row) {
    db.prepare('UPDATE ask_fts_docs SET indexed = 0, indexed_at = ? WHERE n = ?').run(now, n);
    return false;
  }
  db.prepare('INSERT INTO ask_events_fts (rowid, title, place) VALUES (?, ?, ?)').run(n, row.title, row.place);
  db.prepare('UPDATE ask_fts_docs SET indexed = 1, indexed_at = ? WHERE n = ?').run(now, n);
  return true;
}

// ---------------------------------------------------------------------------------------------- refresh

interface IndexState {
  watermark: number;
  full_at: number;
}

const inflight = new WeakMap<DB, Promise<RefreshStats>>();

export interface RefreshStats {
  full: boolean;
  people: number;
  events: number;
}

/** Brings people_fts and ask_events_fts up to date (shared by concurrent callers). */
export function ensureAskIndexes(db: DB, now = Date.now()): Promise<RefreshStats> {
  const running = inflight.get(db);
  if (running) return running;
  const p = refresh(db, now).finally(() => inflight.delete(db));
  inflight.set(db, p);
  return p;
}

async function inChunks<T>(items: T[], fn: (item: T) => void, db: DB): Promise<void> {
  for (let i = 0; i < items.length; i += CHUNK) {
    const slice = items.slice(i, i + CHUNK);
    db.transaction(() => {
      for (const it of slice) fn(it);
    })();
    if (i + CHUNK < items.length) await yieldLoop();
  }
}

async function refresh(db: DB, now: number): Promise<RefreshStats> {
  const state = (name: 'people' | 'events') =>
    db.prepare('SELECT watermark, full_at FROM ask_index_state WHERE name = ?').get(name) as IndexState | undefined;
  const save = (name: 'people' | 'events', full: boolean, rows: number) =>
    db
      .prepare(
        `INSERT INTO ask_index_state (name, watermark, full_at, rows, updated_at) VALUES (@name, @now, @now, @rows, @now)
         ON CONFLICT(name) DO UPDATE SET watermark = @now, full_at = CASE WHEN @full = 1 THEN @now ELSE full_at END,
           rows = CASE WHEN @full = 1 THEN @rows ELSE rows + @rows END, updated_at = @now`,
      )
      .run({ name, now, rows, full: full ? 1 : 0 });

  const ps = state('people');
  const es = state('events');
  const full = !ps || !es || now - ps.full_at >= FULL_EVERY_MS || now - es.full_at >= FULL_EVERY_MS;
  let people = 0;
  let events = 0;

  if (full) {
    const visible = db.prepare('SELECT id FROM person_visible').pluck().all() as string[];
    db.transaction(() => {
      db.prepare('DELETE FROM people_fts').run();
      db.prepare(`UPDATE ask_fts_docs SET indexed = 0 WHERE kind = 'person'`).run();
    })();
    await inChunks(visible, (id) => void (writePersonDoc(db, id, now) && people++), db);
    save('people', true, people);

    const evs = [
      ...(db
        .prepare(`SELECT id FROM occasions WHERE merged_into_id IS NULL AND status = 'active' AND sensitive = 0 AND kind IN (SELECT value FROM json_each(?))`)
        .pluck()
        .all(JSON.stringify(EVENT_KINDS)) as string[]).map((id) => ['occasion', id] as const),
      ...(db.prepare(`SELECT id FROM events WHERE source = 'partiful'`).pluck().all() as string[]).map((id) => ['event', id] as const),
    ];
    db.transaction(() => {
      db.prepare('DELETE FROM ask_events_fts').run();
      db.prepare(`UPDATE ask_fts_docs SET indexed = 0 WHERE kind IN ('occasion','event')`).run();
    })();
    await inChunks(evs, ([k, id]) => void (writeEventDoc(db, k, id, now) && events++), db);
    save('events', true, events);
    return { full, people, events };
  }

  const since = Math.min(ps!.watermark, es!.watermark) - SLACK_MS;
  const ids = changedPeople(db, since);
  await inChunks(ids, (id) => void (writePersonDoc(db, id, now) && people++), db);
  save('people', false, people);

  const evs = [
    ...(db.prepare('SELECT id FROM occasions WHERE updated_at > ?').pluck().all(since) as string[]).map((id) => ['occasion', id] as const),
    // An occasion linking a Partiful event hides that event's own row.
    ...(db.prepare(`SELECT id FROM events WHERE source = 'partiful' AND (updated_at > @s OR id IN (SELECT event_id FROM occasions WHERE updated_at > @s AND event_id IS NOT NULL))`).pluck().all({ s: since }) as string[]).map(
      (id) => ['event', id] as const,
    ),
  ];
  await inChunks(evs, ([k, id]) => void (writeEventDoc(db, k, id, now) && events++), db);
  save('events', false, events);
  return { full, people, events };
}
