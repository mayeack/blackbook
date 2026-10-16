import { describe, expect, it } from 'vitest';
import { uuidv7 } from '@yb/shared';
import { canonicalId } from '../src/db/canon';
import { chooseSurvivor, dataRichness, doNotMergeApplies, mergePeople, MergeRefusedError } from '../src/identity/merge';
import { withBatch } from '../src/journal/batch';
import { undoBatch } from '../src/journal/undo';
import { memDb, newRun, seedIdentity, seedMessage, seedPerson, T0 } from './helpers';

const merge = (db: ReturnType<typeof memDb>, survivorId: string, mergedId: string, method: 'user' | 'probabilistic' = 'user') =>
  mergePeople(db, { survivorId, mergedId, method, runId: newRun(db), actor: method === 'user' ? 'user' : 'agent', now: T0 + 1000 });

const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof MergeRefusedError) return e.reason;
    throw e;
  }
  return null;
};

describe('mergePeople', () => {
  it('points the merged person at the survivor and fills empty fields only (never names)', () => {
    const db = memDb();
    const s = seedPerson(db, { display_name: 'Sam Quill', first_name: 'Sam', last_name: 'Quill', company: null, job_title: '' });
    const m = seedPerson(db, {
      display_name: 'Samuel Q',
      first_name: 'Samuel',
      last_name: 'Q',
      company: 'Example Co',
      job_title: 'Designer',
      family_details: 'two cats',
      custom: JSON.stringify({ a: 1, shared: 'merged' }),
    });
    db.prepare(`UPDATE people SET custom = ? WHERE id = ?`).run(JSON.stringify({ shared: 'survivor' }), s);
    const res = merge(db, s, m);
    const sv = db.prepare('SELECT * FROM people WHERE id = ?').get(s) as Record<string, unknown>;
    const mv = db.prepare('SELECT * FROM people WHERE id = ?').get(m) as Record<string, unknown>;
    expect(mv.merged_into_id).toBe(s);
    expect(mv.status).toBe('merged');
    expect(sv.company).toBe('Example Co');
    expect(sv.job_title).toBe('Designer');
    expect(sv.family_details).toBe('two cats');
    expect(sv.first_name).toBe('Sam');
    expect(sv.display_name).toBe('Sam Quill');
    expect(JSON.parse(sv.custom as string)).toEqual({ a: 1, shared: 'survivor' });
    expect(canonicalId(db, m)).toBe(s);
    expect(db.prepare('SELECT canonical_id FROM person_canon WHERE person_id = ?').pluck().get(m)).toBe(s);
    const merges = db.prepare('SELECT * FROM merges').all() as Record<string, unknown>[];
    expect(merges).toMatchObject([{ id: res.mergeId, survivor_id: s, merged_id: m, batch_id: res.batchId }]);
  });

  it('never fills locked fields', () => {
    const db = memDb();
    const s = seedPerson(db, { locked_fields: JSON.stringify(['company']) });
    const m = seedPerson(db, { company: 'Example Co', job_title: 'Chef' });
    merge(db, s, m);
    expect(db.prepare('SELECT company, job_title FROM people WHERE id = ?').get(s)).toEqual({ company: null, job_title: 'Chef' });
  });

  it('merges canonical roots (merging into a merged person targets its root)', () => {
    const db = memDb();
    const a = seedPerson(db);
    const b = seedPerson(db);
    const c = seedPerson(db);
    merge(db, a, b);
    const r = merge(db, b, c); // b is merged into a → c joins a
    expect(r.survivorId).toBe(a);
    expect(canonicalId(db, c)).toBe(a);
    expect(refusal(() => merge(db, c, b))).toBe('same_person');
  });

  it('refuses across do_not_merge, transitively through canon', () => {
    const db = memDb();
    const [a, b, c, d] = [seedPerson(db), seedPerson(db), seedPerson(db), seedPerson(db)];
    const [x, y] = a < b ? [a, b] : [b, a];
    db.prepare(`INSERT INTO do_not_merge (a_id, b_id, source, created_at) VALUES (?, ?, 'user', 1)`).run(x, y);
    expect(refusal(() => merge(db, a, b))).toBe('do_not_merge');
    expect(refusal(() => merge(db, b, a))).toBe('do_not_merge');
    merge(db, c, a); // a now lives inside c
    expect(doNotMergeApplies(db, c, b)).toBe(true);
    expect(refusal(() => merge(db, c, b))).toBe('do_not_merge');
    merge(db, d, b); // b now lives inside d
    expect(refusal(() => merge(db, d, c))).toBe('do_not_merge');
    expect(refusal(() => merge(db, c, d))).toBe('do_not_merge');
    expect(db.prepare(`SELECT count(*) FROM people WHERE status = 'merged'`).pluck().get()).toBe(2);
  });

  it('guards: me, suppressed, G7 priority/hidden never absorbed probabilistically', () => {
    const db = memDb();
    const me = seedPerson(db, { kind: 'me' });
    const p = seedPerson(db);
    const vip = seedPerson(db, { is_priority: 1 });
    const gone = seedPerson(db, { status: 'suppressed' });
    expect(refusal(() => merge(db, me, p))).toBe('me_mismatch');
    expect(refusal(() => merge(db, p, gone))).toBe('suppressed');
    expect(refusal(() => merge(db, p, vip, 'probabilistic'))).toBe('priority_absorbed');
    expect(refusal(() => merge(db, p, 'nope'))).toBe('not_found');
    expect(merge(db, vip, p, 'probabilistic').survivorId).toBe(vip);
  });

  it('undo clears the pointer, restores fields, writes do_not_merge; re-merge is refused; redo works', () => {
    const db = memDb();
    const s = seedPerson(db);
    const m = seedPerson(db, { company: 'Example Co' });
    const { batchId } = merge(db, s, m);
    const undo = undoBatch(db, batchId, { now: T0 + 2000 });
    expect(undo.undone.map((u) => u.batchId)).toEqual([batchId]);
    expect(db.prepare('SELECT merged_into_id, status FROM people WHERE id = ?').get(m)).toEqual({ merged_into_id: null, status: 'active' });
    expect(db.prepare('SELECT company FROM people WHERE id = ?').pluck().get(s)).toBeNull();
    expect(canonicalId(db, m)).toBe(m);
    expect(db.prepare('SELECT canonical_id FROM person_canon WHERE person_id = ?').pluck().get(m)).toBe(m);
    expect(db.prepare('SELECT undone_at FROM merges').pluck().get()).toBe(T0 + 2000);
    expect(db.prepare('SELECT source FROM do_not_merge').pluck().all()).toEqual(['undo']);
    // the nightly matcher can't redo it
    expect(refusal(() => merge(db, s, m))).toBe('do_not_merge');
    // redo = undo the undo: pointer back, block removed
    undoBatch(db, undo.undone[0]!.undoBatchId, { now: T0 + 3000 });
    expect(canonicalId(db, m)).toBe(s);
    expect(db.prepare('SELECT company FROM people WHERE id = ?').pluck().get(s)).toBe('Example Co');
    expect(db.prepare('SELECT count(*) FROM do_not_merge').pluck().get()).toBe(0);
    expect(db.prepare('SELECT undone_at FROM change_batches WHERE id = ?').pluck().get(batchId)).toBeNull();
  });

  it('undo re-homes facts created after the merge whose evidence came from the split-off person', () => {
    const db = memDb();
    const s = seedPerson(db);
    const m = seedPerson(db);
    const mPhone = seedIdentity(db, m, 'phone', '+12125550101');
    const sPhone = seedIdentity(db, s, 'phone', '+12125550102');
    const { batchId } = merge(db, s, m);
    const run = newRun(db);
    const addFact = (value: string, fromIdentity: string) => {
      const id = uuidv7();
      withBatch(db, { runId: run, kind: 'fact', title: 'fact', actor: 'agent' }, (t) => {
        t.insert('facts', { id, person_id: s, type: 'interest', value, value_norm: value, confidence: 0.9, recorded_at: T0, source: 'llm' });
      }, { now: T0 + 1500 });
      db.prepare(`INSERT INTO evidence (subject_type, subject_id, message_id) VALUES ('fact', ?, ?)`).run(id, seedMessage(db, fromIdentity));
      return id;
    };
    const fromMerged = addFact('climbing', mPhone);
    const fromSurvivor = addFact('baking', sPhone);
    undoBatch(db, batchId, { now: T0 + 2000 });
    const owner = db.prepare('SELECT person_id FROM facts WHERE id = ?').pluck();
    expect(owner.get(fromMerged)).toBe(m);
    expect(owner.get(fromSurvivor)).toBe(s);
  });

  it('undo re-homes from the chain root when the survivor was later merged into someone else', () => {
    const db = memDb();
    const [a, b, c] = [seedPerson(db), seedPerson(db), seedPerson(db)];
    const bPhone = seedIdentity(db, b, 'phone', '+12125550103');
    const cPhone = seedIdentity(db, c, 'phone', '+12125550104');
    const bIntoA = merge(db, a, b).batchId;
    merge(db, c, a);
    const run = newRun(db);
    const addFact = (value: string, fromIdentity: string) => {
      const id = uuidv7();
      withBatch(db, { runId: run, kind: 'fact', title: 'fact', actor: 'agent' }, (t) => {
        t.insert('facts', { id, person_id: c, type: 'interest', value, value_norm: value, confidence: 0.9, recorded_at: T0, source: 'llm' });
      }, { now: T0 + 1500 });
      db.prepare(`INSERT INTO evidence (subject_type, subject_id, message_id) VALUES ('fact', ?, ?)`).run(id, seedMessage(db, fromIdentity));
      return id;
    };
    const fromB = addFact('climbing', bPhone);
    const fromC = addFact('baking', cPhone);
    undoBatch(db, bIntoA, { now: T0 + 2000 });
    expect(canonicalId(db, b)).toBe(b);
    expect(canonicalId(db, a)).toBe(c);
    const owner = db.prepare('SELECT person_id FROM facts WHERE id = ?').pluck();
    expect(owner.get(fromB)).toBe(b);
    expect(owner.get(fromC)).toBe(c);
  });
});

describe('survivor choice', () => {
  it('prefers me, then priority, then richer data, then the older record', () => {
    const db = memDb();
    const older = seedPerson(db, { created_at: T0 - 86_400_000 * 365 });
    const newer = seedPerson(db);
    expect(chooseSurvivor(db, newer, older, T0)).toEqual({ survivorId: older, mergedId: newer });
    const rich = seedPerson(db);
    seedIdentity(db, rich, 'phone', '+12125550111');
    seedIdentity(db, rich, 'email', 'rich@example.com');
    db.prepare(
      `INSERT INTO interactions (id, person_id, kind, started_at, origin, created_at, updated_at) VALUES (?, ?, 'text_log', ?, 'user', 1, 1)`,
    ).run(uuidv7(), rich, T0 - 86_400_000);
    expect(dataRichness(db, rich, T0)).toBeGreaterThan(dataRichness(db, older, T0));
    expect(chooseSurvivor(db, older, rich, T0).survivorId).toBe(rich);
    const vip = seedPerson(db, { is_priority: 1 });
    expect(chooseSurvivor(db, rich, vip, T0).survivorId).toBe(vip);
    const me = seedPerson(db, { kind: 'me' });
    expect(chooseSurvivor(db, vip, me, T0).survivorId).toBe(me);
  });
});
