import { uuidv7 } from '@yb/shared';
import type { DB } from '../db/connection';
import { tx } from '../db/tx';
import { encodeKey, journaled, type RowKey } from './tables';

export type Actor = 'agent' | 'user' | 'system';
export type Row = Record<string, unknown>;

/** Known batch kinds (the column is open; unknown kinds undo through the generic inverse). */
export type BatchKind =
  | 'merge'
  | 'attach_identity'
  | 'create_person'
  | 'person_update'
  | 'fact'
  | 'edge_label'
  | 'commitment'
  | 'reply_debt'
  | 'circle'
  | 'tag'
  | 'location'
  | 'note'
  | 'setting'
  | 'attendee'
  | 'interaction'
  | 'user_edit'
  | 'migration'
  | 'undo'
  | (string & {});

export interface BatchMeta {
  runId: string;
  kind: BatchKind;
  /** Human-readable line for the activity feed. */
  title: string;
  subjectPersonId?: string | null;
  confidence?: number | null;
  actor: Actor;
  undoable?: boolean;
  revertsBatchId?: string | null;
}

export interface JournalTx {
  readonly db: DB;
  readonly batchId: string;
  readonly now: number;
  /** Inserts a row and logs the stored row (defaults included) as `after`. Returns the stored row. */
  insert(table: string, row: Row): Row;
  /** Updates only the columns that actually change; logs their before/after. Returns false if nothing changed. */
  update(table: string, key: RowKey, patch: Row): boolean;
  /** Applies the table's tombstone patch (plus `extra`). Tombstone, never delete. */
  tombstone(table: string, key: RowKey, extra?: Row): boolean;
  /** Hard delete, allowed only for link/block tables whose undo strategy is "delete". */
  delete(table: string, key: RowKey): boolean;
  get(table: string, key: RowKey): Row | undefined;
  readonly changeCount: number;
}

export interface BatchResult<T> {
  batchId: string;
  result: T;
  changes: number;
}

const columnCache = new WeakMap<DB, Map<string, string[]>>();

/** Writable columns (generated columns excluded) of a table, cached per connection. */
export function writableColumns(db: DB, table: string): string[] {
  let perDb = columnCache.get(db);
  if (!perDb) columnCache.set(db, (perDb = new Map()));
  let cols = perDb.get(table);
  if (!cols) {
    const info = db.pragma(`table_xinfo(${JSON.stringify(table)})`) as { name: string; hidden: number }[];
    if (!info.length) throw new Error(`unknown table ${table}`);
    cols = info.filter((c) => c.hidden === 0).map((c) => c.name);
    perDb.set(table, cols);
  }
  return cols;
}

/** better-sqlite3 binds only numbers/strings/bigints/buffers/null: booleans → 0/1, objects → JSON text. */
export function toSqlValue(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v !== null && typeof v === 'object' && !Buffer.isBuffer(v)) return JSON.stringify(v);
  return v;
}

export const sameValue = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return a == b;
  return JSON.stringify(a) === JSON.stringify(b);
};

const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

function whereKey(table: string, key: RowKey): { sql: string; params: unknown[] } {
  const cols = journaled(table).key;
  return { sql: cols.map((c) => `${q(c)} = ?`).join(' AND '), params: cols.map((c) => key[c]) };
}

function project(db: DB, table: string, row: Row | undefined): Row | undefined {
  if (!row) return undefined;
  const out: Row = {};
  for (const c of writableColumns(db, table)) out[c] = row[c] ?? null;
  return out;
}

export function readRow(db: DB, table: string, key: RowKey): Row | undefined {
  journaled(table);
  const w = whereKey(table, key);
  return project(db, table, db.prepare(`SELECT * FROM ${q(table)} WHERE ${w.sql}`).get(...w.params) as Row | undefined);
}

/**
 * Opens one SQLite transaction (joining an outer one), records a change_batches row, and gives `fn` a writer
 * whose every insert/update/tombstone also writes its change_log row atomically. A batch that changes nothing
 * is dropped (unless keepEmpty) so the activity feed only shows real changes.
 */
export function withBatch<T>(
  db: DB,
  meta: BatchMeta,
  fn: (t: JournalTx) => T,
  options: { now?: number; keepEmpty?: boolean } = {},
): BatchResult<T> {
  return tx(db, () => {
    const now = options.now ?? Date.now();
    const batchId = uuidv7(now);
    db.prepare(
      `INSERT INTO change_batches (id, run_id, kind, title, subject_person_id, confidence, actor, undoable, created_at, reverts_batch_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      batchId,
      meta.runId,
      meta.kind,
      meta.title,
      meta.subjectPersonId ?? null,
      meta.confidence ?? null,
      meta.actor,
      meta.undoable === false ? 0 : 1,
      now,
      meta.revertsBatchId ?? null,
    );
    const logStmt = db.prepare(
      'INSERT INTO change_log (batch_id, entity, entity_key, op, before, after, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    let changes = 0;
    const log = (table: string, key: RowKey, op: string, before: Row | null, after: Row | null) => {
      logStmt.run(batchId, table, encodeKey(table, key), op, before && JSON.stringify(before), after && JSON.stringify(after), now);
      changes++;
    };

    const checkColumns = (table: string, row: Row) => {
      const cols = new Set(writableColumns(db, table));
      for (const c of Object.keys(row)) if (!cols.has(c)) throw new Error(`${table} has no writable column ${c}`);
    };

    const applyPatch = (table: string, key: RowKey, patch: Row, op: 'update' | 'tombstone'): boolean => {
      checkColumns(table, patch);
      const keyCols = new Set(journaled(table).key);
      for (const c of Object.keys(patch)) if (keyCols.has(c)) throw new Error(`${table}: key column ${c} can't be updated`);
      const current = readRow(db, table, key);
      if (!current) throw new Error(`${table} ${encodeKey(table, key)} not found`);
      const before: Row = {};
      const after: Row = {};
      for (const [c, raw] of Object.entries(patch)) {
        const v = toSqlValue(raw);
        if (sameValue(current[c], v)) continue;
        before[c] = current[c];
        after[c] = v;
      }
      if (!Object.keys(after).length) return false;
      if ('updated_at' in current && !('updated_at' in patch)) {
        before.updated_at = current.updated_at;
        after.updated_at = now;
      }
      const cols = Object.keys(after);
      const w = whereKey(table, key);
      db.prepare(`UPDATE ${q(table)} SET ${cols.map((c) => `${q(c)} = ?`).join(', ')} WHERE ${w.sql}`).run(
        ...cols.map((c) => after[c]),
        ...w.params,
      );
      log(table, key, op, before, after);
      return true;
    };

    const t: JournalTx = {
      db,
      batchId,
      now,
      get changeCount() {
        return changes;
      },
      get: (table, key) => readRow(db, table, key),
      insert(table, row) {
        journaled(table);
        const cols = writableColumns(db, table);
        const full: Row = { ...row };
        if (cols.includes('created_at') && full.created_at === undefined) full.created_at = now;
        if (cols.includes('updated_at') && full.updated_at === undefined) full.updated_at = now;
        checkColumns(table, full);
        const names = Object.keys(full);
        db.prepare(`INSERT INTO ${q(table)} (${names.map(q).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).run(
          ...names.map((c) => toSqlValue(full[c])),
        );
        const stored = readRow(db, table, full)!;
        log(table, full, 'insert', null, stored);
        return stored;
      },
      update: (table, key, patch) => applyPatch(table, key, patch, 'update'),
      tombstone(table, key, extra = {}) {
        const def = journaled(table);
        if (!def.tombstone) throw new Error(`${table} has no tombstone`);
        return applyPatch(table, key, { ...def.tombstone(now), ...extra }, 'tombstone');
      },
      delete(table, key) {
        if (journaled(table).onUndoInsert !== 'delete') throw new Error(`${table} rows are tombstoned, never deleted`);
        const current = readRow(db, table, key);
        if (!current) return false;
        const w = whereKey(table, key);
        db.prepare(`DELETE FROM ${q(table)} WHERE ${w.sql}`).run(...w.params);
        log(table, key, 'delete', current, null);
        return true;
      },
    };

    const result = fn(t);
    if (changes === 0 && !options.keepEmpty) db.prepare('DELETE FROM change_batches WHERE id = ?').run(batchId);
    return { batchId, result, changes };
  });
}
