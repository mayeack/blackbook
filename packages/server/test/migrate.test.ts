import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { uuidv7 } from '@yb/shared';
import { closeDatabase, openDatabase } from '../src/db/connection';
import { currentVersion, LATEST_VERSION, migrate, MIGRATIONS } from '../src/db/migrate';
import { memDb, seedIdentity, seedPerson, T0, tempDir } from './helpers';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

describe('migrations', () => {
  it('migrating twice is idempotent', () => {
    const { dir, cleanup } = tempDir();
    cleanups.push(cleanup);
    const file = path.join(dir, 'yeackbot.db');
    const db = openDatabase(file);
    expect(migrate(db)).toEqual(MIGRATIONS.map((m) => m.version));
    expect(migrate(db)).toEqual([]);
    const schema = db.prepare(`SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_stat%' ORDER BY name`).all();
    closeDatabase(db);
    const again = openDatabase(file);
    expect(migrate(again)).toEqual([]);
    expect(currentVersion(again)).toBe(LATEST_VERSION);
    expect(again.prepare(`SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_stat%' ORDER BY name`).all()).toEqual(schema);
    expect(again.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(again.pragma('foreign_keys', { simple: true })).toBe(1);
    closeDatabase(again);
  });

  it('refuses a database from a newer build', () => {
    const db = memDb();
    db.pragma(`user_version = ${LATEST_VERSION + 1}`);
    expect(() => migrate(db)).toThrow(/newer than this build/);
  });

  it('every ordinary table is STRICT', () => {
    const db = memDb();
    const tables = db.prepare(`SELECT name, strict FROM pragma_table_list WHERE schema = 'main' AND type = 'table'`).all() as {
      name: string;
      strict: number;
    }[];
    const ordinary = tables.filter((t) => !t.name.startsWith('sqlite_') && !/_fts(_|$)/.test(t.name));
    expect(ordinary.length).toBeGreaterThan(60);
    expect(ordinary.filter((t) => !t.strict).map((t) => t.name)).toEqual([]);
  });

  it('has the critic-fix tables', () => {
    const db = memDb();
    const names = new Set((db.prepare(`SELECT name FROM sqlite_schema`).all() as { name: string }[]).map((r) => r.name));
    for (const t of [
      'edge_evidence',
      'edge_labels',
      'windows',
      'alias_obs',
      'match_candidates',
      'pending_mention_facts',
      'learner_arms',
      'suggestion_outcomes',
      'calendar_events',
      'occasions',
      'occasion_sources',
      'person_visible',
      'messages_fts',
      'facts_fts',
      'notes_fts',
      'people_fts',
    ]) {
      expect(names, t).toContain(t);
    }
  });

  it('person_visible: canonical, active or provisional, not hidden, not merged, kind=person', () => {
    const db = memDb();
    const visible = seedPerson(db);
    const survivor = seedPerson(db);
    const provisional = seedPerson(db, { status: 'provisional' });
    seedPerson(db, { is_hidden: 1 });
    seedPerson(db, { status: 'provisional', is_hidden: 1 });
    seedPerson(db, { status: 'roster_only' });
    seedPerson(db, { status: 'suppressed' });
    seedPerson(db, { kind: 'business' });
    seedPerson(db, { kind: 'me' });
    seedPerson(db, { status: 'merged', merged_into_id: survivor });
    const ids = (db.prepare('SELECT id FROM person_visible ORDER BY id').all() as { id: string }[]).map((r) => r.id);
    expect(ids).toEqual([visible, survivor, provisional].sort());
  });

  it('merged_into_id and status=merged must agree', () => {
    const db = memDb();
    const a = seedPerson(db);
    expect(() => seedPerson(db, { merged_into_id: a })).toThrow(/CHECK/);
    expect(() => seedPerson(db, { status: 'merged' })).toThrow(/CHECK/);
  });

  it('no NULL inside unique keys: derived interactions and membership events dedupe', () => {
    const db = memDb();
    const p = seedPerson(db);
    const ins = db.prepare(
      `INSERT INTO interactions (id, person_id, kind, session_id, started_at, origin, created_at, updated_at)
       VALUES (?, ?, 'dm_session', 's1', ?, 'derived', ?, ?) ON CONFLICT DO NOTHING`,
    );
    ins.run(uuidv7(), p, T0, T0, T0);
    ins.run(uuidv7(), p, T0, T0, T0);
    expect(db.prepare('SELECT count(*) FROM interactions').pluck().get()).toBe(1);
    // user/agent interactions (log:) may repeat
    const manual = db.prepare(
      `INSERT INTO interactions (id, person_id, kind, started_at, origin, created_at, updated_at) VALUES (?, ?, 'text_log', ?, 'user', ?, ?)`,
    );
    manual.run(uuidv7(), p, T0, T0, T0);
    manual.run(uuidv7(), p, T0, T0, T0);
    expect(db.prepare('SELECT count(*) FROM interactions').pluck().get()).toBe(3);

    db.prepare(`INSERT INTO conversations (id, source, source_conv_id, kind, created_at, updated_at) VALUES ('c1','imessage','g1','group',1,1)`).run();
    const me = db.prepare(`INSERT INTO membership_events (conversation_id, identity_id, action, at, message_id) VALUES ('c1', NULL, 'rename', 5, 77) ON CONFLICT DO NOTHING`);
    me.run();
    me.run();
    expect(db.prepare('SELECT count(*) FROM membership_events').pluck().get()).toBe(1);
  });

  it('facts FTS uses the INTEGER surrogate and survives VACUUM', () => {
    const db = memDb();
    const p = seedPerson(db);
    const add = db.prepare(
      `INSERT INTO facts (id, person_id, type, value, value_norm, confidence, recorded_at, source, created_at, updated_at)
       VALUES (?, ?, 'interest', ?, ?, 0.9, 1, 'test', 1, 1)`,
    );
    for (const v of ['rock climbing', 'sourdough baking', 'trail running']) add.run(uuidv7(), p, v, v);
    db.prepare(`DELETE FROM facts WHERE value = 'sourdough baking'`).run();
    db.exec('VACUUM');
    const hits = db.prepare(`SELECT f.value FROM facts_fts JOIN facts f ON f.seq = facts_fts.rowid WHERE facts_fts MATCH 'running'`).all();
    expect(hits).toEqual([{ value: 'trail running' }]);
    expect(db.prepare(`SELECT count(*) FROM facts_fts WHERE facts_fts MATCH 'sourdough'`).pluck().get()).toBe(0);
  });

  it('messages FTS follows inserts and edits; people_fts matches partial names', () => {
    const db = memDb();
    const p = seedPerson(db);
    const ident = seedIdentity(db, p, 'phone', '+12125550123');
    db.prepare(`INSERT INTO conversations (id, source, source_conv_id, kind, created_at, updated_at) VALUES ('c1','imessage','x','direct',1,1)`).run();
    db.prepare(
      `INSERT INTO messages (id, source, source_msg_id, conversation_id, sender_identity_id, is_from_me, sent_at, kind, text, ingested_at, updated_at)
       VALUES (1, 'imessage', 'g1', 'c1', ?, 0, 1, 'text', 'brunch at the café?', 1, 1)`,
    ).run(ident);
    expect(db.prepare(`SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'cafe'`).pluck().all()).toEqual([1]);
    db.prepare(`UPDATE messages SET text = 'dinner instead' WHERE id = 1`).run();
    expect(db.prepare(`SELECT count(*) FROM messages_fts WHERE messages_fts MATCH 'brunch'`).pluck().get()).toBe(0);
    expect(db.prepare(`SELECT count(*) FROM messages_fts WHERE messages_fts MATCH 'dinner'`).pluck().get()).toBe(1);
    db.prepare(`INSERT INTO people_fts (person_id, names) VALUES (?, 'Zoë Quillfeather')`).run(p);
    expect(db.prepare(`SELECT person_id FROM people_fts WHERE people_fts MATCH 'quillf'`).pluck().all()).toEqual([p]);
  });
});
