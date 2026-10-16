/**
 * GET /sources: one card per source from source_health + source_cursors, with message counts from the episode
 * table. Error text, cursor scopes and detail strings pass through redact(): a per-chat scope can embed a phone.
 */
import { Router } from 'express';
import type { DB } from '../db/connection';
import { redact } from '../ops/redact';
import type { RouteDeps } from './index';

export type SourceStatus = 'ok' | 'stale' | 'error' | 'auth_required' | 'contract_broken' | 'disabled' | 'unknown';

export interface SourceCursorView {
  scope: string;
  cursor: string;
  highWaterAt: number | null;
  updatedAt: number;
}

export interface SourceMessageCounts {
  total: number;
  last24h: number;
  last7d: number;
  oldestAt: number | null;
  newestAt: number | null;
}

export interface SourceView {
  source: string;
  status: SourceStatus;
  lastOkAt: number | null;
  newestDataAt: number | null;
  checkedAt: number | null;
  lastError: string | null;
  details: unknown;
  /** Newest first, at most CURSOR_CAP; cursorCount has the full number. */
  cursors: SourceCursorView[];
  cursorCount: number;
  messages: SourceMessageCounts | null;
}

export interface SourcesView {
  sources: SourceView[];
  generatedAt: number;
}

const ORDER = ['collector', 'imessage', 'addressbook', 'whatsapp', 'instagram', 'beeper', 'partiful', 'gcal', 'calendar', 'legacy'];
const rank = (s: string) => {
  const i = ORDER.indexOf(s);
  return i === -1 ? ORDER.length : i;
};

const CURSOR_CAP = 20;
const DAY = 86_400_000;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Redacts every string inside parsed JSON (keys kept). */
function redactDeep(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return redact(v);
  if (depth > 6 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => redactDeep(x, depth + 1));
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x, depth + 1)]));
}

export function sourcesView(db: DB, now = Date.now()): SourcesView {
  const health = db.prepare('SELECT * FROM source_health').all() as {
    source: string;
    status: SourceStatus;
    last_ok_at: number | null;
    newest_data_at: number | null;
    last_error: string | null;
    details: string | null;
    checked_at: number;
  }[];
  const cursors = db.prepare('SELECT source, scope, cursor, high_water_at, updated_at FROM source_cursors ORDER BY source, updated_at DESC, scope').all() as {
    source: string;
    scope: string;
    cursor: string;
    high_water_at: number | null;
    updated_at: number;
  }[];
  const counts = db
    .prepare(
      `SELECT source, count(*) AS total,
              coalesce(sum(sent_at >= @d1), 0) AS d1, coalesce(sum(sent_at >= @d7), 0) AS d7,
              min(sent_at) AS oldest, max(sent_at) AS newest
       FROM messages GROUP BY source`,
    )
    .all({ d1: now - DAY, d7: now - 7 * DAY }) as { source: string; total: number; d1: number; d7: number; oldest: number | null; newest: number | null }[];

  const names = new Set([...health.map((h) => h.source), ...cursors.map((c) => c.source), ...counts.map((c) => c.source)]);
  const sources = [...names]
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map((source): SourceView => {
      const h = health.find((x) => x.source === source);
      const cs = cursors.filter((c) => c.source === source);
      const m = counts.find((c) => c.source === source);
      return {
        source,
        status: h?.status ?? 'unknown',
        lastOkAt: h?.last_ok_at ?? null,
        newestDataAt: h?.newest_data_at ?? m?.newest ?? null,
        checkedAt: h?.checked_at ?? null,
        lastError: h?.last_error ? redact(h.last_error) : null,
        details: h?.details ? redactDeep(JSON.parse(h.details)) : null,
        cursors: cs.slice(0, CURSOR_CAP).map((c) => ({
          scope: redact(c.scope, 80),
          cursor: clip(redact(c.cursor), 32),
          highWaterAt: c.high_water_at,
          updatedAt: c.updated_at,
        })),
        cursorCount: cs.length,
        messages: m ? { total: m.total, last24h: m.d1, last7d: m.d7, oldestAt: m.oldest, newestAt: m.newest } : null,
      };
    });
  return { sources, generatedAt: now };
}

export function sourcesRoutes({ db }: RouteDeps): Router {
  const r = Router();
  r.get('/sources', (_req, res) => {
    res.json(sourcesView(db) satisfies SourcesView);
  });
  return r;
}
