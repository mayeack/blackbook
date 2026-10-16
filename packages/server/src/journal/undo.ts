/**
 * Undo engine (architecture.md §4). Undo is itself a journaled batch (kind 'undo', reverts_batch_id), so redo is
 * "undo the undo". Steps for each batch, newest first:
 *   1. dependency closure: later live batches that touched the same (entity, key, column) are undone first;
 *   2. conflict check: the touched columns must still hold the batch's `after` values;
 *   3. per-kind handler (merge, attach_identity, create_person, fact, …) or the generic inverse;
 *   4. the original is marked undone; canon is rebuilt.
 * Dry runs execute everything inside a transaction and roll it back.
 */
import { uuidv7, type UndoResult } from '@yb/shared';
import { canonicalId, canonicalMembers, rebuildPersonCanon } from '../db/canon';
import type { DB } from '../db/connection';
import { tx } from '../db/tx';
import { readRow, sameValue, withBatch, type Actor, type JournalTx, type Row } from './batch';
import { finishRun, getRun, startRun } from './runs';
import { ALWAYS_VOLATILE, decodeKey, journaled } from './tables';

export type UndoErrorCode = 'NOT_FOUND' | 'ALREADY_UNDONE' | 'NOT_UNDOABLE' | 'CASCADE_REQUIRED' | 'CONFLICT';

export class UndoError extends Error {
  constructor(
    readonly code: UndoErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'UndoError';
  }
}

export interface BatchRow {
  seq: number;
  id: string;
  run_id: string;
  kind: string;
  title: string;
  subject_person_id: string | null;
  confidence: number | null;
  actor: Actor;
  undoable: number;
  created_at: number;
  undone_at: number | null;
  undone_by_batch_id: string | null;
  reverts_batch_id: string | null;
}

interface LogRow {
  seq: number;
  batch_id: string;
  entity: string;
  entity_key: string;
  op: 'insert' | 'update' | 'tombstone' | 'delete';
  before: Row | null;
  after: Row | null;
}

export interface UndoOptions {
  actor?: Actor;
  /** Undo later dependent changes too. Without it, a request with dependents is refused (CASCADE_REQUIRED). */
  cascade?: boolean;
  dryRun?: boolean;
  /** Skip the conflict check (tests / repair tooling only; the API never sets it). */
  force?: boolean;
  now?: number;
}

const getBatch = (db: DB, id: string) => db.prepare('SELECT * FROM change_batches WHERE id = ?').get(id) as BatchRow | undefined;

function loadLogs(db: DB, batchId: string): LogRow[] {
  const rows = db.prepare('SELECT * FROM change_log WHERE batch_id = ? ORDER BY seq').all(batchId) as (Omit<LogRow, 'before' | 'after'> & {
    before: string | null;
    after: string | null;
  })[];
  return rows.map((r) => ({ ...r, before: r.before ? JSON.parse(r.before) : null, after: r.after ? JSON.parse(r.after) : null }));
}

const volatileCols = (entity: string) => new Set([...ALWAYS_VOLATILE, ...(journaled(entity).volatile ?? [])]);

/** Columns a change touches, for dependency overlap: '*' for whole-row ops. */
function touched(l: LogRow): Set<string> | '*' {
  if (l.op === 'insert' || l.op === 'delete') return '*';
  const vol = volatileCols(l.entity);
  return new Set(Object.keys(l.after ?? {}).filter((c) => !vol.has(c)));
}

const overlaps = (a: Set<string> | '*', b: Set<string> | '*') =>
  a === '*' || b === '*' ? true : [...a].some((c) => b.has(c));

/**
 * Later live batches that (transitively) touched what `targets` touched. Live undo batches are skipped: each
 * one cancels a batch that is itself undone, so the pair is a no-op for dependency purposes.
 */
export function dependentsOf(db: DB, targets: BatchRow[]): BatchRow[] {
  const targetIds = new Set(targets.map((b) => b.id));
  const closure = new Map<string, BatchRow>();
  const maxLogSeq = db.prepare('SELECT max(seq) FROM change_log WHERE batch_id = ?').pluck();
  const later = db.prepare(
    `SELECT cl.*, cb.seq AS b_seq FROM change_log cl JOIN change_batches cb ON cb.id = cl.batch_id
     WHERE cl.entity = ? AND cl.entity_key = ? AND cl.seq > ? AND cb.undone_at IS NULL AND cb.kind <> 'undo'
     ORDER BY cl.seq`,
  );
  const queue: { entity: string; key: string; cols: Set<string> | '*'; after: number }[] = [];
  const seen = new Set<string>();
  const enqueue = (batch: BatchRow) => {
    const after = (maxLogSeq.get(batch.id) as number | null) ?? 0;
    for (const l of loadLogs(db, batch.id)) {
      const cols = touched(l);
      const sig = `${l.entity}\u0000${l.entity_key}\u0000${after}\u0000${cols === '*' ? '*' : [...cols].sort().join(',')}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      queue.push({ entity: l.entity, key: l.entity_key, cols, after });
    }
  };
  targets.forEach(enqueue);
  while (queue.length) {
    const item = queue.shift()!;
    const rows = later.all(item.entity, item.key, item.after) as (LogRow & { before: string | null; after: string | null })[];
    for (const r of rows) {
      if (targetIds.has(r.batch_id) || closure.has(r.batch_id)) continue;
      const parsed: LogRow = { ...r, before: r.before ? JSON.parse(r.before) : null, after: r.after ? JSON.parse(r.after) : null };
      if (!overlaps(item.cols, touched(parsed))) continue;
      const b = getBatch(db, r.batch_id)!;
      closure.set(b.id, b);
      enqueue(b);
    }
  }
  return [...closure.values()].sort((a, b) => a.seq - b.seq);
}

function checkConflicts(db: DB, batch: BatchRow, logs: LogRow[]): void {
  const conflicts: { entity: string; key: string; column: string }[] = [];
  for (const l of logs) {
    const key = decodeKey(l.entity, l.entity_key);
    const current = readRow(db, l.entity, key);
    if (l.op === 'delete') {
      if (current) conflicts.push({ entity: l.entity, key: l.entity_key, column: '*' });
      continue;
    }
    if (!current) {
      conflicts.push({ entity: l.entity, key: l.entity_key, column: '*' });
      continue;
    }
    const vol = volatileCols(l.entity);
    for (const [c, v] of Object.entries(l.after ?? {})) {
      if (!vol.has(c) && !sameValue(current[c], v)) conflicts.push({ entity: l.entity, key: l.entity_key, column: c });
    }
  }
  if (conflicts.length) {
    throw new UndoError('CONFLICT', `"${batch.title}" was changed afterwards outside the journal; it can't be undone safely.`, {
      batchId: batch.id,
      conflicts,
    });
  }
}

/** Reverses one change_log row with the table's generic inverse (volatile columns excepted). */
function invert(t: JournalTx, l: LogRow): void {
  const key = decodeKey(l.entity, l.entity_key);
  switch (l.op) {
    case 'insert': {
      const how = journaled(l.entity).onUndoInsert;
      if (how === 'tombstone') t.tombstone(l.entity, key);
      else if (how === 'delete') t.delete(l.entity, key);
      return;
    }
    case 'update':
    case 'tombstone': {
      // Volatile columns are not restored: updated_at records the undo itself, and ingestion owns the seen-at
      // columns (restoring them would be order-dependent across independent batches).
      const vol = volatileCols(l.entity);
      t.update(l.entity, key, Object.fromEntries(Object.entries(l.before ?? {}).filter(([c]) => !vol.has(c))));
      return;
    }
    case 'delete':
      t.insert(l.entity, l.before ?? {});
      return;
  }
}

type Handler = (t: JournalTx, batch: BatchRow, logs: LogRow[]) => void;

const generic: Handler = (t, _batch, logs) => {
  for (const l of [...logs].reverse()) invert(t, l);
};

/** Tables whose rows can carry "evidence" and get re-homed to the split-off person when a merge is undone. */
const REHOME: { table: string; subjectType: string; dead: string[] }[] = [
  { table: 'facts', subjectType: 'fact', dead: ['rejected', 'invalidated'] },
  { table: 'commitments', subjectType: 'commitment', dead: ['retracted'] },
  { table: 'reply_debts', subjectType: 'reply_debt', dead: ['retracted'] },
];

const HANDLERS: Record<string, Handler> = {
  merge(t, batch, logs) {
    generic(t, batch, logs);
    const m = logs.find((l) => l.entity === 'merges' && l.op === 'insert')?.after;
    if (!m) return;
    const survivorId = String(m.survivor_id);
    const mergedId = String(m.merged_id);
    const mergedAt = Number(m.created_at);
    // The survivor may since have been merged into someone else: rows to re-home can sit anywhere under its root.
    const survivorSide = new Set(canonicalMembers(t.db, canonicalId(t.db, survivorId)));
    const mergedSide = new Set(canonicalMembers(t.db, mergedId));
    // Rows created on the survivor after the merge whose evidence all comes from the split-off side go back.
    const evidence = t.db.prepare(
      `SELECT i.person_id FROM evidence e JOIN messages m ON m.id = e.message_id
       LEFT JOIN identities i ON i.id = m.sender_identity_id WHERE e.subject_type = ? AND e.subject_id = ?`,
    );
    for (const r of REHOME) {
      const rows = t.db
        .prepare(`SELECT id, person_id, status FROM ${r.table} WHERE created_at >= ?`)
        .all(mergedAt) as { id: string; person_id: string; status: string }[];
      for (const row of rows) {
        if (!survivorSide.has(row.person_id) || r.dead.includes(row.status)) continue;
        const owners = (evidence.all(r.subjectType, row.id) as { person_id: string | null }[]).map((e) => e.person_id);
        if (owners.length && owners.every((p) => p !== null && mergedSide.has(p))) {
          t.update(r.table, { id: row.id }, { person_id: mergedId });
        }
      }
    }
    const [a, b] = survivorId < mergedId ? [survivorId, mergedId] : [mergedId, survivorId];
    if (!t.get('do_not_merge', { a_id: a, b_id: b })) {
      t.insert('do_not_merge', { a_id: a, b_id: b, reason: 'merge undone', source: 'undo', created_at: t.now });
    }
  },

  attach_identity(t, batch, logs) {
    for (const l of [...logs].reverse()) {
      if (l.entity !== 'identities' || !l.after) {
        invert(t, l);
        continue;
      }
      const key = decodeKey(l.entity, l.entity_key);
      if (l.op === 'insert') {
        // No prior owner: the identity moves to a new provisional person, and may never come back here.
        const ident = l.after;
        const owner = String(ident.person_id);
        const provisionalId = uuidv7(t.now);
        t.insert('people', {
          id: provisionalId,
          display_name: (ident.display_name as string | null) ?? '(unknown)',
          status: 'provisional',
          origin: 'undo',
          created_by_run: batch.run_id,
        });
        t.update('identities', key, { person_id: provisionalId });
        blockIdentity(t, ident, owner);
      } else if ('person_id' in l.after && l.before && 'person_id' in l.before) {
        invert(t, l); // back to the prior owner
        blockIdentity(t, readRow(t.db, 'identities', key)!, String(l.after.person_id));
      } else {
        invert(t, l);
      }
    }
  },

  create_person(t, _batch, logs) {
    // Identities created with the person stay bound to it, so future ingest routes back to the suppressed
    // person instead of creating it again.
    for (const l of [...logs].reverse()) if (!(l.entity === 'identities' && l.op === 'insert')) invert(t, l);
  },

  fact(t, _batch, logs) {
    for (const l of [...logs].reverse()) {
      invert(t, l);
      if (l.entity === 'facts' && l.op === 'insert' && l.after) {
        const block = { person_id: l.after.person_id, type: l.after.type, value_norm: l.after.value_norm };
        if (!t.get('fact_blocks', block)) t.insert('fact_blocks', { ...block, created_at: t.now });
      }
    }
  },
};

function blockIdentity(t: JournalTx, ident: Row, personId: string): void {
  const block = { kind: ident.kind, key: ident.key, person_id: personId };
  if (!t.get('identity_blocks', block)) t.insert('identity_blocks', { ...block, created_at: t.now });
}

/** Reverses one batch inside the current transaction and returns the undo batch id. */
function undoOne(db: DB, batch: BatchRow, runId: string, actor: Actor, force: boolean, now: number): string {
  if (!batch.undoable) throw new UndoError('NOT_UNDOABLE', `"${batch.title}" can't be undone.`, { batchId: batch.id });
  if (batch.undone_at !== null) throw new UndoError('ALREADY_UNDONE', `"${batch.title}" is already undone.`, { batchId: batch.id });
  const logs = loadLogs(db, batch.id);
  if (!force) checkConflicts(db, batch, logs);
  const handler = HANDLERS[batch.kind] ?? generic;
  const isRedo = batch.kind === 'undo';
  const title = isRedo ? `Redo: ${batch.title.replace(/^Undo: /, '')}` : `Undo: ${batch.title}`;
  const { batchId } = withBatch(
    db,
    { runId, kind: 'undo', title, subjectPersonId: batch.subject_person_id, actor, revertsBatchId: batch.id },
    (t) => handler(t, batch, logs),
    { now, keepEmpty: true },
  );
  db.prepare('UPDATE change_batches SET undone_at = ?, undone_by_batch_id = ? WHERE id = ?').run(now, batchId, batch.id);
  if (isRedo && batch.reverts_batch_id) {
    // A batch is undone iff a live undo batch reverts it: reviving the reverted batch puts its run back in play
    // ("Undo entire run" applies again), and a revived undo batch re-undoes its own target.
    const revived = getBatch(db, batch.reverts_batch_id)!;
    db.prepare('UPDATE change_batches SET undone_at = NULL, undone_by_batch_id = NULL WHERE id = ?').run(revived.id);
    db.prepare('UPDATE runs SET undone_at = NULL, undo_run_id = NULL WHERE id = ? AND undone_at IS NOT NULL').run(revived.run_id);
    if (revived.kind === 'undo' && revived.reverts_batch_id) {
      db.prepare('UPDATE change_batches SET undone_at = ?, undone_by_batch_id = ? WHERE id = ?').run(now, revived.id, revived.reverts_batch_id);
    }
  }
  return batchId;
}

class DryRunRollback extends Error {
  constructor(readonly result: UndoResult) {
    super('dry run');
  }
}

function execute(db: DB, dryRun: boolean, fn: () => UndoResult): UndoResult {
  if (!dryRun) return tx(db, fn);
  if (db.inTransaction) throw new Error('an undo dry run cannot run inside another transaction');
  try {
    db.transaction(() => {
      throw new DryRunRollback(fn());
    }).immediate();
  } catch (e) {
    if (e instanceof DryRunRollback) return e.result;
    throw e;
  }
  throw new Error('unreachable');
}

function runUndo(db: DB, targets: BatchRow[], dependents: BatchRow[], o: UndoOptions, onRun?: (runId: string) => void): UndoResult {
  const now = o.now ?? Date.now();
  const dryRun = o.dryRun ?? false;
  return execute(db, dryRun, () => {
    const runId = startRun(db, 'undo', { now });
    const ordered = [...targets, ...dependents].sort((a, b) => b.seq - a.seq);
    const undone: UndoResult['undone'] = [];
    const countsByKind: Record<string, number> = {};
    for (const b of ordered) {
      const fresh = getBatch(db, b.id)!;
      const undoBatchId = undoOne(db, fresh, runId, o.actor ?? 'user', o.force ?? false, now);
      undone.push({ batchId: b.id, kind: b.kind, title: b.title, runId: b.run_id, undoBatchId: dryRun ? '' : undoBatchId });
      countsByKind[b.kind] = (countsByKind[b.kind] ?? 0) + 1;
    }
    rebuildPersonCanon(db);
    onRun?.(runId);
    finishRun(db, runId, 'ok', { now, summary: { undone: undone.length } });
    return { dryRun, runId: dryRun ? null : runId, undone, cascaded: dependents.map((d) => d.id), countsByKind };
  });
}

/** Per-change undo (POST /api/v1/activity/:batchId/undo). Also redoes: undoing an undo batch re-applies it. */
export function undoBatch(db: DB, batchId: string, o: UndoOptions = {}): UndoResult {
  const batch = getBatch(db, batchId);
  if (!batch) throw new UndoError('NOT_FOUND', 'No such change.');
  if (batch.undone_at !== null) throw new UndoError('ALREADY_UNDONE', `"${batch.title}" is already undone.`, { batchId });
  if (!batch.undoable) throw new UndoError('NOT_UNDOABLE', `"${batch.title}" can't be undone.`, { batchId });
  const dependents = dependentsOf(db, [batch]);
  if (dependents.length && !o.cascade && !o.dryRun) {
    throw new UndoError('CASCADE_REQUIRED', `Undoing this also undoes ${dependents.length} later change(s).`, {
      dependents: dependents.map(summary),
    });
  }
  return runUndo(db, [batch], dependents, o);
}

/** Per-run undo ("Undo all from last night"): every live batch of the run, newest first, as one undo run. */
export function undoRun(db: DB, runId: string, o: UndoOptions = {}): UndoResult {
  const run = getRun(db, runId);
  if (!run) throw new UndoError('NOT_FOUND', 'No such run.');
  if (run.undone_at !== null) throw new UndoError('ALREADY_UNDONE', 'This run is already undone.', { runId });
  const targets = db
    .prepare('SELECT * FROM change_batches WHERE run_id = ? AND undone_at IS NULL AND undoable = 1 ORDER BY seq')
    .all(runId) as BatchRow[];
  const dependents = dependentsOf(db, targets);
  if (dependents.length && !o.cascade && !o.dryRun) {
    throw new UndoError('CASCADE_REQUIRED', `Undoing this run also undoes ${dependents.length} later change(s) from other runs.`, {
      dependents: dependents.map(summary),
    });
  }
  return runUndo(db, targets, dependents, o, (undoRunId) => {
    db.prepare('UPDATE runs SET undone_at = ?, undo_run_id = ? WHERE id = ?').run(o.now ?? Date.now(), undoRunId, runId);
  });
}

const summary = (b: BatchRow) => ({ batchId: b.id, kind: b.kind, title: b.title, runId: b.run_id, createdAt: b.created_at });
