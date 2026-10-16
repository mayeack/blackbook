/**
 * eval_items persistence: inserting sampled items (idempotent on (set, subject_ref)), labels, counts and the
 * cursor-paged listing. (S) tables, never journaled: a label is the owner's judgement, re-labeling replaces it.
 */
import { uuidv7 } from '@yb/shared';
import type { DB } from '../db/connection';
import { parseItem, SET_NAMES, type Item, type ItemRow, type NewItem, type SetName, type StoredLabel } from './types';

/** Golden-set sizes (intelligence §8 scaled down per critic §5; the task brief's ~200 / ~150 / ~100 / ~40). */
export const EVAL_SET_TARGET_SIZES: Readonly<Record<SetName, number>> = { extraction: 200, identity: 150, reply_debt: 100, ask: 40 };

/** Inserts items that aren't in the set yet; returns how many were added. */
export function insertItems(db: DB, items: readonly NewItem[], now: number): number {
  const ins = db.prepare(
    `INSERT OR IGNORE INTO eval_items (id, set_name, subject_ref, stratum, origin, shadow_run_id, title, frozen_at, payload, predictions, prompt_version, created_at, updated_at)
     VALUES (@id, @set, @subject, @stratum, @origin, @shadow, @title, @frozen, @payload, @predictions, @pv, @now, @now)`,
  );
  let added = 0;
  db.transaction(() => {
    for (const it of items) {
      added += ins.run({
        id: uuidv7(now),
        set: it.set,
        subject: it.subjectRef,
        stratum: it.stratum,
        origin: it.origin ?? 'sample',
        shadow: it.shadowRunId ?? null,
        title: it.title,
        frozen: it.frozenAt,
        payload: JSON.stringify(it.payload),
        predictions: JSON.stringify(it.predictions),
        pv: it.promptVersion,
        now,
      }).changes;
    }
  })();
  return added;
}

export function existingRefs(db: DB, set: SetName): Set<string> {
  return new Set(db.prepare('SELECT subject_ref FROM eval_items WHERE set_name = ?').pluck().all(set) as string[]);
}

export function getItem(db: DB, id: string): Item | null {
  const r = db.prepare('SELECT * FROM eval_items WHERE id = ?').get(id) as ItemRow | undefined;
  return r ? parseItem(r) : null;
}

export function itemsOf(db: DB, set: SetName, o: { origin?: 'sample' | 'shadow'; labeledOnly?: boolean; shadowRunId?: string } = {}): Item[] {
  const where = ['set_name = ?'];
  const params: unknown[] = [set];
  if (o.origin) {
    where.push('origin = ?');
    params.push(o.origin);
  }
  if (o.labeledOnly) where.push('label IS NOT NULL');
  if (o.shadowRunId) {
    where.push('shadow_run_id = ?');
    params.push(o.shadowRunId);
  }
  return (db.prepare(`SELECT * FROM eval_items WHERE ${where.join(' AND ')} ORDER BY id`).all(...params) as ItemRow[]).map(parseItem);
}

export function writeLabel(db: DB, id: string, label: StoredLabel, expectedPersonIds: string[] | null, now: number): void {
  db.prepare(
    `UPDATE eval_items SET label = ?, labeled_at = ?, expected_person_ids = coalesce(?, expected_person_ids), updated_at = ? WHERE id = ?`,
  ).run(JSON.stringify(label), label.labeledAt, expectedPersonIds ? JSON.stringify(expectedPersonIds) : null, now, id);
}

export interface SetCount {
  set: SetName;
  total: number;
  labeled: number;
  target: number;
}

export function setCounts(db: DB): SetCount[] {
  const rows = db.prepare(`SELECT set_name AS s, count(*) AS total, count(label) AS labeled FROM eval_items GROUP BY set_name`).all() as {
    s: SetName;
    total: number;
    labeled: number;
  }[];
  const by = new Map(rows.map((r) => [r.s, r]));
  return SET_NAMES.map((set) => ({ set, total: by.get(set)?.total ?? 0, labeled: by.get(set)?.labeled ?? 0, target: EVAL_SET_TARGET_SIZES[set] }));
}

export interface PageQuery {
  set?: SetName;
  status: 'unlabeled' | 'labeled' | 'all';
  cursor?: string;
  limit: number;
}

/** Items after `cursor` (an item id: uuidv7 ids sort in insertion order), at most `fetch` rows. */
export function pageRows(db: DB, q: PageQuery, fetch: number): Item[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.set) {
    where.push('set_name = ?');
    params.push(q.set);
  }
  if (q.status === 'unlabeled') where.push('label IS NULL');
  else if (q.status === 'labeled') where.push('label IS NOT NULL');
  if (q.cursor) {
    where.push('id > ?');
    params.push(q.cursor);
  }
  const sql = `SELECT * FROM eval_items ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id LIMIT ?`;
  return (db.prepare(sql).all(...params, fetch) as ItemRow[]).map(parseItem);
}

// ---------------------------------------------------------------------------------------------- sample state

export function sampleState(db: DB, set: SetName): { sampledAt: number; pool: number; added: number } | null {
  const r = db.prepare('SELECT sampled_at, pool, added FROM eval_sample_state WHERE set_name = ?').get(set) as
    | { sampled_at: number; pool: number; added: number }
    | undefined;
  return r ? { sampledAt: r.sampled_at, pool: r.pool, added: r.added } : null;
}

export function recordSample(db: DB, set: SetName, now: number, pool: number, added: number): void {
  db.prepare(
    `INSERT INTO eval_sample_state (set_name, sampled_at, pool, added) VALUES (?, ?, ?, ?)
     ON CONFLICT (set_name) DO UPDATE SET sampled_at = excluded.sampled_at, pool = excluded.pool, added = excluded.added`,
  ).run(set, now, pool, added);
}

/** Removes a set's items (labels included) and its sample state: `yb eval reset --set <set> --yes`. */
export function resetSet(db: DB, set: SetName): number {
  return db.transaction(() => {
    const n = db.prepare('DELETE FROM eval_items WHERE set_name = ?').run(set).changes;
    db.prepare('DELETE FROM eval_sample_state WHERE set_name = ?').run(set);
    return n;
  })();
}
