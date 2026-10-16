import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { uuidv7 } from '@yb/shared';
import { rebuildPersonCanon } from '../src/db/canon';
import { openDatabase, type DB } from '../src/db/connection';
import { migrate } from '../src/db/migrate';
import { withBatch, type Row } from '../src/journal/batch';
import { startRun } from '../src/journal/runs';

/** Fresh migrated in-memory database. */
export function memDb(): DB {
  const db = openDatabase(':memory:');
  migrate(db);
  return db;
}

/** A temp dir under the OS temp folder (never the real data dir); removed by the returned cleanup. */
export function tempDir(prefix = 'yb-test-'): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

export const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);

/** Inserts a person directly (outside the journal): seed state for tests. */
export function seedPerson(db: DB, p: Partial<Row> = {}): string {
  const id = (p.id as string) ?? uuidv7();
  const row: Row = {
    id,
    display_name: 'Test Person',
    first_name: 'Test',
    last_name: 'Person',
    origin: 'test',
    created_at: T0,
    updated_at: T0,
    ...p,
  };
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO people (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => row[c]));
  rebuildPersonCanon(db);
  return id;
}

export function seedIdentity(db: DB, personId: string, kind: string, key: string, extra: Partial<Row> = {}): string {
  const id = (extra.id as string) ?? uuidv7();
  const row: Row = { id, person_id: personId, kind, key, source: 'test', match_method: 'exact', created_at: T0, updated_at: T0, ...extra };
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO identities (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => row[c]));
  return id;
}

/** A conversation + message sent by `identityId`, for evidence tests. */
export function seedMessage(db: DB, identityId: string, text = 'hello'): number {
  const convId = uuidv7();
  db.prepare(
    `INSERT INTO conversations (id, source, source_conv_id, kind, created_at, updated_at) VALUES (?, 'imessage', ?, 'direct', ?, ?)`,
  ).run(convId, convId, T0, T0);
  return Number(
    db
      .prepare(
        `INSERT INTO messages (source, source_msg_id, conversation_id, sender_identity_id, is_from_me, sent_at, kind, text, ingested_at, updated_at)
         VALUES ('imessage', ?, ?, ?, 0, ?, 'text', ?, ?, ?)`,
      )
      .run(uuidv7(), convId, identityId, T0, text, T0, T0).lastInsertRowid,
  );
}

export function newRun(db: DB, kind: Parameters<typeof startRun>[1] = 'nightly'): string {
  return startRun(db, kind, { now: T0 });
}

/** Journaled person creation (kind create_person). */
export function createPerson(db: DB, runId: string, p: Partial<Row> = {}, identities: { kind: string; key: string }[] = []): string {
  const id = (p.id as string) ?? uuidv7();
  withBatch(db, { runId, kind: 'create_person', title: 'Created a person', actor: 'agent', subjectPersonId: id }, (t) => {
    t.insert('people', { id, display_name: 'New Person', origin: 'test', ...p });
    for (const i of identities) {
      t.insert('identities', { id: uuidv7(), person_id: id, kind: i.kind, key: i.key, source: 'test', match_method: 'exact' });
    }
  });
  rebuildPersonCanon(db);
  return id;
}

/** Every row of a table, ordered deterministically (for state comparisons). */
export function dump(db: DB, table: string): Row[] {
  return db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all() as Row[];
}
