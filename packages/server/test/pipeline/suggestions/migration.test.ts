import { describe, expect, it } from 'vitest';
import { SUGGESTION_KINDS, uuidv7 } from '@yb/shared';
import { openDatabase, type DB } from '../../../src/db/connection';
import { migrate } from '../../../src/db/migrate';
import { widenTableCheck } from '../../../src/db/migrations/023_party_invite';
import { T0 } from '../../helpers';

const schemaOf = (db: DB) =>
  db.prepare(`SELECT type, name, sql FROM sqlite_schema WHERE tbl_name = 'suggestions' AND type IN ('index', 'trigger') AND sql IS NOT NULL ORDER BY name`).all();

function suggestion(db: DB, kind: string, dedupeKey = `${kind}:${uuidv7()}`, status = 'candidate'): string {
  const id = uuidv7();
  db.prepare(`INSERT INTO suggestions (id, kind, dedupe_key, score, signals, status, created_at, updated_at) VALUES (?, ?, ?, 0.5, '{}', ?, ?, ?)`).run(
    id,
    kind,
    dedupeKey,
    status,
    T0,
    T0,
  );
  return id;
}

describe('023_party_invite', () => {
  it('rebuilds suggestions with party_invite in its kind CHECK, keeping rows, references, indexes and columns', () => {
    const db = openDatabase(':memory:');
    migrate(db, 22);
    const before = schemaOf(db);
    const cols = db.prepare(`SELECT name FROM pragma_table_info('suggestions')`).pluck().all();
    const kept = suggestion(db, 'fading', 'fading:p1', 'selected');
    const digest = uuidv7();
    db.prepare(`INSERT INTO digests (id, local_date, status) VALUES (?, '2026-10-14', 'sent')`).run(digest);
    db.prepare(`INSERT INTO digest_items (digest_id, ordinal, suggestion_id) VALUES (?, 1, ?)`).run(digest, kept);
    db.prepare(`INSERT INTO suggestion_outcomes (suggestion_id, reward, weight, source, decided_at) VALUES (?, 1, 1, 'explicit', ?)`).run(kept, T0);
    expect(() => suggestion(db, 'party_invite')).toThrow(/CHECK/);

    migrate(db);
    expect(db.prepare(`SELECT id, kind, status FROM suggestions`).all()).toEqual([{ id: kept, kind: 'fading', status: 'selected' }]);
    expect(db.prepare(`SELECT name FROM pragma_table_info('suggestions')`).pluck().all()).toEqual(cols);
    expect(schemaOf(db)).toEqual(before);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    // every kind the app knows fits; anything else is still refused
    for (const k of SUGGESTION_KINDS) expect(() => suggestion(db, k)).not.toThrow();
    expect(() => suggestion(db, 'party_crasher')).toThrow(/CHECK/);
    // the partial unique index on live rows survived
    suggestion(db, 'party_invite', 'party_invite:occ:1');
    expect(() => suggestion(db, 'party_invite', 'party_invite:occ:1')).toThrow(/UNIQUE/);
    // digest_items still reference the rebuilt table
    expect(() => db.prepare(`INSERT INTO digest_items (digest_id, ordinal, suggestion_id) VALUES (?, 2, 'missing')`).run(digest)).toThrow(/FOREIGN KEY/);
  });

  it('is a no-op when the values are already there', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const ddl = db.prepare(`SELECT sql FROM sqlite_schema WHERE name = 'suggestions'`).pluck().get();
    expect(widenTableCheck(db, 'suggestions', 'kind', ['party_invite', 'fading'])).toBe(false);
    expect(db.prepare(`SELECT sql FROM sqlite_schema WHERE name = 'suggestions'`).pluck().get()).toBe(ddl);
    expect(() => widenTableCheck(db, 'suggestions', 'flavor', ['x'])).toThrow(/suggestions: no CHECK list for flavor/);
  });
});
