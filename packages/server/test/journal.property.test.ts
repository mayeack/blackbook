/**
 * Journal property test: random sequences of person inserts/updates, merges, identity attaches and fact
 * operations, then undo everything → the journaled state equals the start state; then redo everything → it
 * equals the end state. "Equal" means: every row that existed is identical (except updated_at, which records the
 * undo itself), and every row created since is inert (tombstoned, undone, a block, or created by an undo batch —
 * e.g. the provisional person a detached identity moves to).
 */
import { describe, expect, it } from 'vitest';
import { uuidv7 } from '@yb/shared';
import { canonicalId, rebuildPersonCanon } from '../src/db/canon';
import type { DB } from '../src/db/connection';
import { mergePeople, MergeRefusedError } from '../src/identity/merge';
import { withBatch, type Row } from '../src/journal/batch';
import { encodeKey, JOURNALED } from '../src/journal/tables';
import { undoBatch } from '../src/journal/undo';
import { memDb, newRun, seedIdentity, seedPerson, T0 } from './helpers';

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TABLES = ['people', 'identities', 'merges', 'facts', 'do_not_merge', 'identity_blocks', 'fact_blocks'] as const;
const BLOCKS = new Set(['do_not_merge', 'identity_blocks', 'fact_blocks']);

type Snapshot = Map<string, Map<string, Row>>;

function snapshot(db: DB): Snapshot {
  const snap: Snapshot = new Map();
  for (const t of TABLES) {
    const rows = db.prepare(`SELECT * FROM ${t}`).all() as Row[];
    // updated_at records the undo/redo itself, so it is the one column not compared.
    snap.set(t, new Map(rows.map((r) => [encodeKey(t, r), { ...r, updated_at: undefined }])));
  }
  const canon = db.prepare('SELECT person_id, canonical_id FROM person_canon').all() as { person_id: string; canonical_id: string }[];
  snap.set('person_canon', new Map(canon.map((r) => [r.person_id, r as unknown as Row])));
  return snap;
}

/** (entity, key) pairs inserted by undo batches. */
function undoInserted(db: DB): Set<string> {
  const rows = db
    .prepare(`SELECT cl.entity, cl.entity_key FROM change_log cl JOIN change_batches cb ON cb.id = cl.batch_id WHERE cb.kind = 'undo' AND cl.op = 'insert'`)
    .all() as { entity: string; entity_key: string }[];
  return new Set(rows.map((r) => `${r.entity}\u0000${r.entity_key}`));
}

function assertRestored(db: DB, ref: Snapshot, label: string, allowNewBlocks: boolean): void {
  const now = snapshot(db);
  const byUndo = undoInserted(db);
  const people = now.get('people')!;
  const inertPerson = (id: unknown) => {
    const p = people.get(String(id));
    return !!p && !ref.get('people')!.has(String(id)) && (p.status === 'suppressed' || byUndo.has(`people\u0000${id}`));
  };
  for (const t of [...TABLES, 'person_canon'] as const) {
    const cur = now.get(t)!;
    const old = ref.get(t)!;
    for (const [k, row] of old) expect(cur.get(k), `${label}: ${t} ${k} changed`).toEqual(row);
    for (const [k, row] of cur) {
      if (old.has(k)) continue;
      const where = `${label}: new ${t} row ${k} is not inert`;
      if (BLOCKS.has(t)) expect(allowNewBlocks, where).toBe(true);
      else if (t === 'people') expect(inertPerson(k), where).toBe(true);
      else if (t === 'identities') expect(row.status === 'detached' || inertPerson(row.person_id), where).toBe(true);
      else if (t === 'merges') expect(row.undone_at, where).not.toBeNull();
      else if (t === 'facts') expect(row.status, where).toBe('rejected');
      else if (t === 'person_canon') expect(inertPerson(k), where).toBe(true);
    }
  }
}

function world(seed: number) {
  const rnd = mulberry32(seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const db = memDb();
  // Fictional 555-01xx numbers across a few area codes (600 distinct keys).
  const AREAS = ['212', '312', '415', '646', '718', '917'];
  let phone = 0;
  const nextPhone = () => {
    const n = phone++;
    return `+1${AREAS[Math.floor(n / 100) % AREAS.length]}55501${String(n % 100).padStart(2, '0')}`;
  };
  for (let i = 0; i < 8; i++) {
    const p = seedPerson(db, { display_name: `Seed ${i}`, company: rnd() < 0.5 ? `Co ${i}` : null });
    seedIdentity(db, p, 'phone', nextPhone());
    if (rnd() < 0.5) {
      db.prepare(
        `INSERT INTO facts (id, person_id, type, value, value_norm, confidence, recorded_at, source, created_at, updated_at)
         VALUES (?, ?, 'interest', 'hiking', 'hiking', 0.9, ?, 'seed', ?, ?)`,
      ).run(uuidv7(), p, T0, T0, T0);
    }
  }
  rebuildPersonCanon(db);

  const canonicalPeople = () =>
    db.prepare(`SELECT id FROM people WHERE merged_into_id IS NULL AND status <> 'suppressed'`).pluck().all() as string[];
  const runs: string[] = [];
  const run = () => {
    if (!runs.length || rnd() < 0.15) runs.push(newRun(db, pick(['nightly', 'ingest', 'user'] as const)));
    return runs[runs.length - 1]!;
  };

  const ops: Record<string, () => void> = {
    createPerson() {
      const id = uuidv7();
      withBatch(db, { runId: run(), kind: 'create_person', title: 'create', actor: 'agent', subjectPersonId: id }, (t) => {
        t.insert('people', { id, display_name: `New ${id.slice(-4)}`, status: pick(['active', 'provisional']), origin: 'test' });
        const n = Math.floor(rnd() * 3);
        for (let i = 0; i < n; i++) t.insert('identities', { id: uuidv7(), person_id: id, kind: 'phone', key: nextPhone(), source: 't', match_method: 'exact' });
      });
      rebuildPersonCanon(db);
    },
    updatePerson() {
      const id = pick(canonicalPeople());
      const patch: Row = {};
      if (rnd() < 0.6) patch.company = pick([null, 'Acme', 'Globex', 'Initech']);
      if (rnd() < 0.5) patch.job_title = pick([null, 'Chef', 'Pilot']);
      if (rnd() < 0.3) patch.nickname = pick([null, 'Ace', 'Bee']);
      if (rnd() < 0.3) patch.is_priority = rnd() < 0.5;
      if (rnd() < 0.3) patch.display_name = `Renamed ${Math.floor(rnd() * 100)}`;
      withBatch(db, { runId: run(), kind: 'person_update', title: 'update', actor: pick(['agent', 'user']) }, (t) => t.update('people', { id }, patch));
    },
    merge() {
      const ids = canonicalPeople();
      if (ids.length < 2) return;
      const a = pick(ids);
      const b = pick(ids.filter((x) => x !== a));
      try {
        mergePeople(db, { survivorId: a, mergedId: b, method: 'user', runId: run(), actor: 'user' });
      } catch (e) {
        if (!(e instanceof MergeRefusedError)) throw e;
      }
    },
    attachNewIdentity() {
      const p = pick(canonicalPeople());
      withBatch(db, { runId: run(), kind: 'attach_identity', title: 'attach', actor: 'agent', subjectPersonId: p }, (t) =>
        t.insert('identities', { id: uuidv7(), person_id: p, kind: 'phone', key: nextPhone(), display_name: 'Someone', source: 't', match_method: 'exact' }),
      );
    },
    moveIdentity() {
      const idents = db.prepare(`SELECT id, person_id FROM identities WHERE status = 'active'`).all() as { id: string; person_id: string }[];
      if (!idents.length) return;
      const ident = pick(idents);
      const targets = canonicalPeople().filter((p) => p !== canonicalId(db, ident.person_id));
      if (!targets.length) return;
      const target = pick(targets);
      withBatch(db, { runId: run(), kind: 'attach_identity', title: 'move', actor: 'agent', subjectPersonId: target }, (t) =>
        t.update('identities', { id: ident.id }, { person_id: target, match_method: 'probabilistic', confidence: 0.9 }),
      );
    },
    insertFact() {
      const p = pick(canonicalPeople());
      const v = pick(['climbing', 'jazz', 'ramen', 'chess']);
      withBatch(db, { runId: run(), kind: 'fact', title: 'fact', actor: 'agent', subjectPersonId: p }, (t) =>
        t.insert('facts', { id: uuidv7(), person_id: p, type: 'interest', value: v, value_norm: v, confidence: 0.8, recorded_at: T0, source: 'llm' }),
      );
    },
    updateFact() {
      const facts = db.prepare(`SELECT id FROM facts WHERE status <> 'rejected'`).pluck().all() as string[];
      if (!facts.length) return;
      const id = pick(facts);
      withBatch(db, { runId: run(), kind: 'fact', title: 'confirm', actor: 'agent' }, (t) =>
        t.update('facts', { id }, { status: pick(['tentative', 'confirmed']), support: 1 + Math.floor(rnd() * 4), confidence: rnd() }),
      );
    },
  };
  const weights: [string, number][] = [
    ['createPerson', 2],
    ['updatePerson', 3],
    ['merge', 2],
    ['attachNewIdentity', 2],
    ['moveIdentity', 2],
    ['insertFact', 2],
    ['updateFact', 2],
  ];
  const total = weights.reduce((s, [, w]) => s + w, 0);
  const step = () => {
    let r = rnd() * total;
    for (const [name, w] of weights) {
      if ((r -= w) < 0) return ops[name]!();
    }
  };
  return { db, rnd, pick, step };
}

const liveForward = (db: DB) =>
  db.prepare(`SELECT id FROM change_batches WHERE kind <> 'undo' AND undone_at IS NULL ORDER BY seq DESC`).pluck().all() as string[];

describe('journal property', () => {
  it('covers every journaled table it touches', () => {
    for (const t of TABLES) expect(JOURNALED[t], t).toBeDefined();
  });

  for (let seed = 1; seed <= 12; seed++) {
    it(`seed ${seed}: undo everything newest-first restores the start; redo restores the end`, () => {
      const { db, step } = world(seed);
      const start = snapshot(db);
      for (let i = 0; i < 60; i++) step();
      const end = snapshot(db);
      const forward = liveForward(db);
      expect(forward.length).toBeGreaterThan(20);

      for (const id of forward) expect(undoBatch(db, id).cascaded, `batch ${id} needed a cascade`).toEqual([]);
      assertRestored(db, start, `seed ${seed} undo`, true);
      expect(liveForward(db)).toEqual([]);

      const undos = db.prepare(`SELECT id FROM change_batches WHERE kind = 'undo' AND undone_at IS NULL ORDER BY seq DESC`).pluck().all() as string[];
      for (const id of undos) undoBatch(db, id);
      assertRestored(db, end, `seed ${seed} redo`, false);
      expect(liveForward(db).sort()).toEqual([...forward].sort());
    });
  }

  for (let seed = 101; seed <= 108; seed++) {
    it(`seed ${seed}: undo in random order with cascades also restores the start`, () => {
      const { db, step, pick } = world(seed);
      const start = snapshot(db);
      for (let i = 0; i < 50; i++) step();
      for (let live = liveForward(db); live.length; live = liveForward(db)) undoBatch(db, pick(live), { cascade: true });
      assertRestored(db, start, `seed ${seed} random`, true);
    });
  }
});
