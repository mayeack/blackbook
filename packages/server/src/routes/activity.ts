import { Router } from 'express';
import { z } from 'zod';
import { UndoRequest, type ActivityBatch, type ActivityPage, type ActivityRun } from '@yb/shared';
import type { DB } from '../db/connection';
import { undoBatch, undoRun, type BatchRow } from '../journal/undo';
import type { RunRow } from '../journal/runs';
import type { RouteDeps } from './index';

const PageQuery = z.object({
  cursor: z
    .string()
    .regex(/^\d{1,15}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const DryRunQuery = z.object({ dryRun: z.enum(['1', 'true', '0', 'false']).optional() });
const IdParam = z.object({ id: z.string().regex(/^[0-9a-f-]{36}$/i) });

const toBatch = (b: BatchRow & { change_count: number }): ActivityBatch => ({
  id: b.id,
  seq: b.seq,
  kind: b.kind,
  title: b.title,
  subjectPersonId: b.subject_person_id,
  confidence: b.confidence,
  actor: b.actor,
  undoable: b.undoable === 1,
  createdAt: b.created_at,
  undoneAt: b.undone_at,
  undoneByBatchId: b.undone_by_batch_id,
  revertsBatchId: b.reverts_batch_id,
  changeCount: b.change_count,
});

const toRun = (r: RunRow): ActivityRun => ({
  id: r.id,
  kind: r.kind,
  status: r.status,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  undoneAt: r.undone_at,
});

/** change_batches newest first (by seq), grouped by run within the page. */
export function activityPage(db: DB, cursor: number | null, limit: number): ActivityPage {
  const rows = db
    .prepare(
      `SELECT cb.*, (SELECT count(*) FROM change_log cl WHERE cl.batch_id = cb.id) AS change_count
       FROM change_batches cb WHERE cb.seq < ? ORDER BY cb.seq DESC LIMIT ?`,
    )
    .all(cursor ?? Number.MAX_SAFE_INTEGER, limit + 1) as (BatchRow & { change_count: number })[];
  const page = rows.slice(0, limit);
  const runs = new Map<string, ActivityPage['groups'][number]>();
  const getRun = db.prepare('SELECT * FROM runs WHERE id = ?');
  for (const b of page) {
    let g = runs.get(b.run_id);
    if (!g) {
      g = { run: toRun(getRun.get(b.run_id) as RunRow), batches: [] };
      runs.set(b.run_id, g);
    }
    g.batches.push(toBatch(b));
  }
  return { groups: [...runs.values()], nextCursor: rows.length > limit ? String(page[page.length - 1]!.seq) : null };
}

const isDry = (q: unknown) => {
  const v = DryRunQuery.parse(q).dryRun;
  return v === '1' || v === 'true';
};

export function activityRoutes({ db }: RouteDeps): Router {
  const r = Router();

  r.get('/activity', (req, res) => {
    const q = PageQuery.parse(req.query);
    res.json(activityPage(db, q.cursor ? Number(q.cursor) : null, q.limit));
  });

  r.post('/activity/:id/undo', (req, res) => {
    const { id } = IdParam.parse(req.params);
    const { cascade } = UndoRequest.parse(req.body ?? {});
    res.json(undoBatch(db, id, { cascade, dryRun: isDry(req.query), actor: 'user' }));
  });

  r.post('/runs/:id/undo', (req, res) => {
    const { id } = IdParam.parse(req.params);
    const { cascade } = UndoRequest.parse(req.body ?? {});
    res.json(undoRun(db, id, { cascade, dryRun: isDry(req.query), actor: 'user' }));
  });

  return r;
}
