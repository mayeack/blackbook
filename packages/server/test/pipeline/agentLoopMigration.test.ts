import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/connection';
import { migrate } from '../../src/db/migrate';
import { T0 } from '../helpers';

describe('migration 011 (ties, graph, circles bookkeeping)', () => {
  it('upgrades a v10 database that already has stats and edges', () => {
    const db = openDatabase(':memory:');
    migrate(db, 10);
    db.prepare(`INSERT INTO person_stats (person_id, state, computed_at) VALUES ('p1', 'steady', ?)`).run(T0);
    db.prepare(
      `INSERT INTO edge_stats (a_id, b_id, weight, strength, tier, dominant_type, evidence_count, computed_at) VALUES ('a', 'b', 1, 0.39, 'acquainted', 'co_group', 1, ?)`,
    ).run(T0);
    migrate(db, 11);
    expect(db.prepare('SELECT types, breakdown FROM edge_stats').get()).toEqual({ types: '[]', breakdown: '{}' });
    expect(db.prepare('SELECT cold_start, i_start_share FROM person_stats').get()).toEqual({ cold_start: 0, i_start_share: null });
    const tables = db.prepare(`SELECT name FROM sqlite_schema WHERE type = 'table'`).pluck().all() as string[];
    for (const t of ['tie_stats_snapshot', 'circle_suggestions', 'circle_auto_meta']) expect(tables).toContain(t);
    expect(() => db.prepare(`UPDATE edge_stats SET types = 'not json'`).run()).toThrow(/CHECK/);
    expect(() =>
      db.prepare(`INSERT INTO tie_stats_snapshot (person_id, week, tie_strength, units, computed_at) VALUES ('p1', 'week 1', 1, 1, 1)`).run(),
    ).toThrow(/CHECK/);
    migrate(db);
  });
});
