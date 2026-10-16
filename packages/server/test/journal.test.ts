import { describe, expect, it } from 'vitest';
import { uuidv7 } from '@yb/shared';
import { withBatch } from '../src/journal/batch';
import { getRun } from '../src/journal/runs';
import { undoBatch, UndoError, undoRun } from '../src/journal/undo';
import { createPerson, memDb, newRun, seedPerson, T0 } from './helpers';

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof UndoError) return e.code;
    throw e;
  }
  return null;
};

const logs = (db: ReturnType<typeof memDb>, batchId: string) =>
  (db.prepare('SELECT entity, op, before, after FROM change_log WHERE batch_id = ? ORDER BY seq').all(batchId) as {
    entity: string;
    op: string;
    before: string | null;
    after: string | null;
  }[]).map((r) => ({ ...r, before: r.before && JSON.parse(r.before), after: r.after && JSON.parse(r.after) }));

describe('withBatch', () => {
  it('logs only the columns that change (plus updated_at) and drops empty batches', () => {
    const db = memDb();
    const run = newRun(db);
    const p = seedPerson(db, { company: 'Old Co', job_title: 'Chef' });
    const { batchId, changes } = withBatch(db, { runId: run, kind: 'person_update', title: 'edit', actor: 'user' }, (t) =>
      t.update('people', { id: p }, { company: 'New Co', job_title: 'Chef', is_priority: true }),
    { now: T0 + 5 });
    expect(changes).toBe(1);
    expect(logs(db, batchId)).toEqual([
      {
        entity: 'people',
        op: 'update',
        before: { company: 'Old Co', is_priority: 0, updated_at: T0 },
        after: { company: 'New Co', is_priority: 1, updated_at: T0 + 5 },
      },
    ]);
    const empty = withBatch(db, { runId: run, kind: 'person_update', title: 'noop', actor: 'user' }, (t) =>
      t.update('people', { id: p }, { company: 'New Co' }),
    );
    expect(empty.result).toBe(false);
    expect(db.prepare('SELECT count(*) FROM change_batches WHERE id = ?').pluck().get(empty.batchId)).toBe(0);
  });

  it('logs the stored row (defaults included) for inserts; refuses deletes on tombstone tables and key updates', () => {
    const db = memDb();
    const run = newRun(db);
    const id = uuidv7();
    const { batchId } = withBatch(db, { runId: run, kind: 'create_person', title: 'new', actor: 'agent' }, (t) => {
      t.insert('people', { id, display_name: 'Nova Quell', origin: 'test' });
      expect(() => t.delete('people', { id })).toThrow(/never deleted/);
      expect(() => t.update('people', { id }, { id: 'x' })).toThrow(/key column/);
      expect(() => t.update('people', { id }, { no_such: 1 })).toThrow(/no writable column/);
    });
    const [ins] = logs(db, batchId);
    expect(ins!.op).toBe('insert');
    expect(ins!.after).toMatchObject({ id, status: 'active', kind: 'person', is_hidden: 0, locked_fields: '[]' });
    expect(() => withBatch(db, { runId: run, kind: 'x', title: 'x', actor: 'agent' }, (t) => t.insert('messages', {}))).toThrow(
      /not a journaled table/,
    );
  });
});

describe('undo engine', () => {
  it('refuses with CASCADE_REQUIRED, then cascades newest-first', () => {
    const db = memDb();
    const run = newRun(db);
    const p = createPerson(db, run, { display_name: 'Nova Quell' });
    const b1 = withBatch(db, { runId: run, kind: 'person_update', title: 'company', actor: 'agent' }, (t) =>
      t.update('people', { id: p }, { company: 'A' }),
    ).batchId;
    const b2 = withBatch(db, { runId: run, kind: 'person_update', title: 'company again', actor: 'agent' }, (t) =>
      t.update('people', { id: p }, { company: 'B' }),
    ).batchId;
    const other = withBatch(db, { runId: run, kind: 'person_update', title: 'unrelated column', actor: 'agent' }, (t) =>
      t.update('people', { id: p }, { job_title: 'Chef' }),
    ).batchId;
    expect(code(() => undoBatch(db, b1))).toBe('CASCADE_REQUIRED');
    const res = undoBatch(db, b1, { cascade: true });
    expect(res.undone.map((u) => u.batchId)).toEqual([b2, b1]);
    expect(res.cascaded).toEqual([b2]);
    expect(db.prepare('SELECT company, job_title FROM people WHERE id = ?').get(p)).toEqual({ company: null, job_title: 'Chef' });
    expect(db.prepare('SELECT undone_at IS NULL FROM change_batches WHERE id = ?').pluck().get(other)).toBe(1);
    expect(code(() => undoBatch(db, b1))).toBe('ALREADY_UNDONE');
    expect(code(() => undoBatch(db, 'missing'))).toBe('NOT_FOUND');
  });

  it('dry run reports the plan and changes nothing', () => {
    const db = memDb();
    const run = newRun(db);
    const p = createPerson(db, run);
    const b = withBatch(db, { runId: run, kind: 'person_update', title: 'c', actor: 'agent' }, (t) => t.update('people', { id: p }, { company: 'A' })).batchId;
    const before = db.prepare('SELECT (SELECT count(*) FROM change_batches), (SELECT count(*) FROM runs), (SELECT company FROM people)').raw().get();
    const res = undoBatch(db, b, { dryRun: true });
    expect(res.dryRun).toBe(true);
    expect(res.runId).toBeNull();
    expect(res.undone.map((u) => u.batchId)).toEqual([b]);
    expect(db.prepare('SELECT (SELECT count(*) FROM change_batches), (SELECT count(*) FROM runs), (SELECT company FROM people)').raw().get()).toEqual(before);
  });

  it('refuses when a journaled column was changed outside the journal, and rolls back', () => {
    const db = memDb();
    const run = newRun(db);
    const p = createPerson(db, run);
    const b = withBatch(db, { runId: run, kind: 'person_update', title: 'c', actor: 'agent' }, (t) => t.update('people', { id: p }, { company: 'A' })).batchId;
    db.prepare(`UPDATE people SET company = 'sneaky' WHERE id = ?`).run(p);
    expect(code(() => undoBatch(db, b))).toBe('CONFLICT');
    expect(db.prepare('SELECT company FROM people WHERE id = ?').pluck().get(p)).toBe('sneaky');
    expect(db.prepare(`SELECT count(*) FROM runs WHERE kind = 'undo'`).pluck().get()).toBe(0);
    // volatile columns don't conflict
    db.prepare(`UPDATE people SET company = 'A', updated_at = 999 WHERE id = ?`).run(p);
    expect(undoBatch(db, b).undone).toHaveLength(1);
  });

  it('fact undo rejects + blocks; edge label undo rejects; create_person undo suppresses and keeps identities bound', () => {
    const db = memDb();
    const run = newRun(db);
    const [a, b] = [seedPerson(db), seedPerson(db)].sort();
    const factId = uuidv7();
    const fb = withBatch(db, { runId: run, kind: 'fact', title: 'fact', actor: 'agent' }, (t) =>
      t.insert('facts', { id: factId, person_id: a, type: 'interest', value: 'Climbing', value_norm: 'climbing', confidence: 0.9, recorded_at: T0, source: 'llm' }),
    ).batchId;
    const eb = withBatch(db, { runId: run, kind: 'edge_label', title: 'edge', actor: 'agent' }, (t) =>
      t.insert('edge_labels', { id: uuidv7(), a_id: a, b_id: b, label: 'friend', confidence: 0.9, origin: 'llm' }),
    ).batchId;
    const p = createPerson(db, run, {}, [{ kind: 'phone', key: '+12125550150' }]);
    const cb = db.prepare(`SELECT id FROM change_batches WHERE kind = 'create_person'`).pluck().get() as string;
    for (const id of [fb, eb, cb]) undoBatch(db, id);
    expect(db.prepare('SELECT status, retracted_at IS NOT NULL FROM facts').raw().get()).toEqual(['rejected', 1]);
    expect(db.prepare('SELECT person_id, type, value_norm FROM fact_blocks').raw().all()).toEqual([[a, 'interest', 'climbing']]);
    expect(db.prepare('SELECT status FROM edge_labels').pluck().get()).toBe('rejected');
    expect(db.prepare('SELECT status FROM people WHERE id = ?').pluck().get(p)).toBe('suppressed');
    expect(db.prepare('SELECT person_id, status FROM identities').raw().get()).toEqual([p, 'active']);
  });

  it('attach_identity undo: back to the prior owner + block; a fresh attach moves to a provisional person', () => {
    const db = memDb();
    const run = newRun(db);
    const [owner, target] = [seedPerson(db), seedPerson(db)];
    const moved = uuidv7();
    db.prepare(`INSERT INTO identities (id, person_id, kind, key, source, match_method, created_at, updated_at) VALUES (?, ?, 'email', 'sam@example.com', 't', 'exact', 1, 1)`).run(moved, owner);
    const move = withBatch(db, { runId: run, kind: 'attach_identity', title: 'move', actor: 'agent' }, (t) =>
      t.update('identities', { id: moved }, { person_id: target, match_method: 'probabilistic' }),
    ).batchId;
    const fresh = uuidv7();
    const attach = withBatch(db, { runId: run, kind: 'attach_identity', title: 'attach', actor: 'agent' }, (t) =>
      t.insert('identities', { id: fresh, person_id: target, kind: 'phone', key: '+12125550160', display_name: 'Nova', source: 't', match_method: 'exact' }),
    ).batchId;
    undoBatch(db, attach);
    undoBatch(db, move);
    expect(db.prepare('SELECT person_id FROM identities WHERE id = ?').pluck().get(moved)).toBe(owner);
    const provisional = db.prepare('SELECT person_id FROM identities WHERE id = ?').pluck().get(fresh) as string;
    expect(db.prepare('SELECT status, display_name, origin FROM people WHERE id = ?').raw().get(provisional)).toEqual(['provisional', 'Nova', 'undo']);
    expect(db.prepare('SELECT kind, key, person_id FROM identity_blocks ORDER BY kind').raw().all()).toEqual([
      ['email', 'sam@example.com', target],
      ['phone', '+12125550160', target],
    ]);
  });

  it('per-run undo: everything in the run, refuses dependents from later runs unless cascading', () => {
    const db = memDb();
    const night = newRun(db);
    const p = createPerson(db, night);
    withBatch(db, { runId: night, kind: 'person_update', title: 'c', actor: 'agent' }, (t) => t.update('people', { id: p }, { company: 'A' }));
    const later = newRun(db, 'user');
    const userEdit = withBatch(db, { runId: later, kind: 'user_edit', title: 'u', actor: 'user' }, (t) => t.update('people', { id: p }, { company: 'B' })).batchId;
    const preview = undoRun(db, night, { dryRun: true });
    expect(preview.countsByKind).toEqual({ create_person: 1, person_update: 1, user_edit: 1 });
    expect(preview.cascaded).toEqual([userEdit]);
    expect(code(() => undoRun(db, night))).toBe('CASCADE_REQUIRED');
    const res = undoRun(db, night, { cascade: true });
    expect(res.undone).toHaveLength(3);
    expect(getRun(db, night)?.undone_at).not.toBeNull();
    expect(getRun(db, night)?.undo_run_id).toBe(res.runId);
    expect(db.prepare('SELECT status, company FROM people WHERE id = ?').raw().get(p)).toEqual(['suppressed', null]);
    expect(code(() => undoRun(db, night))).toBe('ALREADY_UNDONE');
  });

  it('per-run undo → redo → undo again; redo of a redo re-undoes the original', () => {
    const db = memDb();
    const night = newRun(db);
    const p = createPerson(db, night);
    const edit = withBatch(db, { runId: night, kind: 'person_update', title: 'c', actor: 'agent' }, (t) =>
      t.update('people', { id: p }, { company: 'A' }),
    ).batchId;
    const first = undoRun(db, night);
    expect(db.prepare('SELECT status FROM people WHERE id = ?').pluck().get(p)).toBe('suppressed');

    const redo = undoRun(db, first.runId!);
    expect(db.prepare('SELECT status, company FROM people WHERE id = ?').raw().get(p)).toEqual(['active', 'A']);
    expect(getRun(db, night)?.undone_at).toBeNull();
    expect(getRun(db, night)?.undo_run_id).toBeNull();
    expect(getRun(db, first.runId!)?.undone_at).not.toBeNull();
    expect(db.prepare('SELECT count(*) FROM change_batches WHERE run_id = ? AND undone_at IS NULL').pluck().get(night)).toBe(2);

    const again = undoRun(db, night);
    expect(again.undone).toHaveLength(2);
    expect(db.prepare('SELECT status, company FROM people WHERE id = ?').raw().get(p)).toEqual(['suppressed', null]);
    expect(db.prepare('SELECT undone_at IS NOT NULL FROM change_batches WHERE id = ?').pluck().get(edit)).toBe(1);
    expect(redo.undone).toHaveLength(2);
  });

  it('redo of a redo (per batch) keeps undone flags consistent', () => {
    const db = memDb();
    const run = newRun(db);
    const p = seedPerson(db, { company: 'Old' });
    const edit = withBatch(db, { runId: run, kind: 'person_update', title: 'c', actor: 'agent' }, (t) =>
      t.update('people', { id: p }, { company: 'New' }),
    ).batchId;
    const flags = (id: string) => db.prepare('SELECT undone_at IS NOT NULL AS undone, undone_by_batch_id AS by FROM change_batches WHERE id = ?').get(id) as { undone: number; by: string | null };
    const u1 = undoBatch(db, edit).undone[0]!.undoBatchId;
    const r1 = undoBatch(db, u1).undone[0]!.undoBatchId;
    expect(flags(edit)).toEqual({ undone: 0, by: null });
    undoBatch(db, r1);
    expect(db.prepare('SELECT company FROM people WHERE id = ?').pluck().get(p)).toBe('Old');
    expect(flags(u1)).toEqual({ undone: 0, by: null });
    expect(flags(edit)).toEqual({ undone: 1, by: u1 });
    expect(code(() => undoBatch(db, edit))).toBe('ALREADY_UNDONE');
  });
});
