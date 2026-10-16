import { describe, expect, it } from 'vitest';
import { uuidv7 } from '@yb/shared';
import { openDatabase } from '../../../src/db/connection';
import { migrate } from '../../../src/db/migrate';
import { widenCheck } from '../../../src/db/migrations/010_occasions';
import { memDb, seedPerson, T0 } from '../../helpers';

const indexes = (db: ReturnType<typeof memDb>) =>
  db.prepare(`SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'event_attendees' AND sql IS NOT NULL ORDER BY name`).pluck().all();

describe('010_occasions', () => {
  it('widens event_attendees source/status and keeps its rows and indexes', () => {
    const db = openDatabase(':memory:');
    migrate(db, 9);
    const before = indexes(db);
    const p = seedPerson(db);
    const ev = uuidv7();
    db.prepare(`INSERT INTO events (id, source, source_event_id, created_at, updated_at) VALUES (?, 'partiful', 'PtyEvt0009', ?, ?)`).run(ev, T0, T0);
    db.prepare(
      `INSERT INTO event_attendees (id, event_id, person_id, status, source, confidence, created_at, updated_at) VALUES (?, ?, ?, 'going', 'partiful', 1, ?, ?)`,
    ).run(uuidv7(), ev, p, T0, T0);
    expect(() =>
      db.prepare(`INSERT INTO event_attendees (id, event_id, person_id, status, source, created_at, updated_at) VALUES (?, ?, ?, 'going', 'inferred', ?, ?)`).run(uuidv7(), ev, seedPerson(db), T0, T0),
    ).toThrow(/CHECK/);

    migrate(db);
    expect(indexes(db)).toEqual(before);
    expect(db.prepare('SELECT count(*) FROM event_attendees').pluck().get()).toBe(1);
    const occ = uuidv7();
    db.prepare(`INSERT INTO occasions (id, starts_at, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(occ, T0, T0, T0);
    const ins = db.prepare(`INSERT INTO event_attendees (id, occasion_id, person_id, status, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const source of ['inferred', 'calendar_explicit', 'calendar_text', 'partiful']) ins.run(uuidv7(), occ, seedPerson(db), 'possible', source, T0, T0);
    ins.run(uuidv7(), occ, seedPerson(db), 'withdrawn', 'inferred', T0, T0);
    expect(() => ins.run(uuidv7(), occ, seedPerson(db), 'going', 'guesswork', T0, T0)).toThrow(/CHECK/);
    // the partial unique index survived the rebuild
    expect(() => ins.run(uuidv7(), occ, p, 'possible', 'inferred', T0, T0)).not.toThrow();
    expect(() => ins.run(uuidv7(), occ, p, 'possible', 'inferred', T0, T0)).toThrow(/UNIQUE/);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('widenCheck adds only missing values and refuses a table without the list', () => {
    const ddl = `CREATE TABLE t (source TEXT CHECK (source IN ('a','b')))`;
    expect(widenCheck(ddl, 'source', ['b', 'c'])).toBe(`CREATE TABLE t (source TEXT CHECK (source IN ('a','b', 'c')))`);
    expect(widenCheck(widenCheck(ddl, 'source', ['c']), 'source', ['c'])).toBe(widenCheck(ddl, 'source', ['c']));
    expect(() => widenCheck(ddl, 'status', ['x'])).toThrow(/no CHECK list/);
  });

  it('adds the occasion columns and the candidates table', () => {
    const db = memDb();
    const cols = db.prepare(`SELECT name FROM pragma_table_info('occasions')`).pluck().all();
    expect(cols).toEqual(expect.arrayContaining(['merged_into_id', 'calendar_treatment', 'classification_rule', 'candidate_count', 'inferred_at']));
    expect(db.prepare(`SELECT strict FROM pragma_table_list WHERE name = 'occasion_candidates'`).pluck().get()).toBe(1);
  });
});
