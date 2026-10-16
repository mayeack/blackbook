/**
 * Settings → Hidden: THE one place hidden people are listed (CLAUDE.md; PLAN "Hidden/merged people"). Reads people
 * directly, not person_visible. Unhiding is a journaled, undoable person_update.
 *
 *   GET  /settings/hidden                 hidden canonical people, last name A–Z
 *   POST /settings/hidden/:id/unhide      → {batchId}
 */
import { Router } from 'express';
import { z } from 'zod';
import type { DB } from '../db/connection';
import { notFound } from '../http/errors';
import { withBatch } from '../journal/batch';
import { withRun } from '../journal/runs';
import type { RouteDeps } from './index';
import { compareByName, maskText } from './people';

export interface HiddenPerson {
  id: string;
  displayName: string;
  company: string | null;
}

export interface HiddenPage {
  items: HiddenPerson[];
}

interface HiddenRow {
  id: string;
  display_name: string;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  created_at: number;
}

const HIDDEN_SQL = `SELECT id, display_name, first_name, last_name, company, created_at FROM people
  WHERE is_hidden = 1 AND kind = 'person' AND merged_into_id IS NULL AND status IN ('active', 'provisional')`;

export function listHidden(db: DB): HiddenPage {
  const rows = db.prepare(HIDDEN_SQL).all() as HiddenRow[];
  const key = (r: HiddenRow) => {
    const last = r.last_name?.trim() ?? '';
    const first = r.first_name?.trim() ?? '';
    return { id: r.id, last, first: first || (last ? '' : r.display_name.trim()), display: r.display_name.trim(), lastAt: null, createdAt: r.created_at };
  };
  rows.sort((a, b) => compareByName(key(a), key(b)));
  return { items: rows.map((r) => ({ id: r.id, displayName: maskText(r.display_name), company: r.company ? maskText(r.company) : null })) };
}

/** Unhides one hidden person; 404 for anyone who isn't currently listed under Hidden. */
export function unhidePerson(db: DB, id: string, now = Date.now()): { batchId: string } {
  if (!db.prepare(`${HIDDEN_SQL} AND id = ?`).get(id)) throw notFound('Hidden person');
  return withRun(
    db,
    'user',
    (runId) => {
      // The title never names the person: an undo hides them again, and the feed must not leak a hidden name.
      const { batchId } = withBatch(
        db,
        { runId, kind: 'person_update', title: 'Unhid a person', subjectPersonId: id, actor: 'user' },
        (t) => t.update('people', { id }, { is_hidden: 0 }),
        { now },
      );
      return { batchId };
    },
    { now },
  );
}

const IdParam = z.object({ id: z.string().regex(/^[0-9a-f-]{36}$/i) });

export function settingsRoutes({ db }: RouteDeps): Router {
  const r = Router();
  r.get('/settings/hidden', (_req, res) => {
    res.json(listHidden(db) satisfies HiddenPage);
  });
  r.post('/settings/hidden/:id/unhide', (req, res) => {
    const { id } = IdParam.parse(req.params);
    res.json(unhidePerson(db, id));
  });
  return r;
}
