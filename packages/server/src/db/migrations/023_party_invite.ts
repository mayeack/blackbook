/**
 * 023 party invites (owner: intel/invites.ts): a new suggestion kind, `party_invite` — whom to invite to a party or
 * event the owner hosts 2–14 days out, Party invites people first. suggestions.kind carries a CHECK list (001), so
 * the table is rebuilt with the wider list (SQLite's 12-step ALTER, as 010 did for event_attendees): the stored DDL
 * with one more value, rows copied as they are, indexes and triggers re-created. digest_items and
 * suggestion_outcomes keep referencing it by name; foreign keys are off around the rebuild and checked before commit.
 */
import type { DB } from '../connection';
import { widenCheck } from './010_occasions';

export const sql = /* sql */ `
-- no schema changes outside up(): suggestions is rebuilt there
`;

export const rebuildsTables = true;

/** Kinds this migration adds (frozen: later kinds get their own migration). */
export const ADDED_KINDS = ['party_invite'] as const;

/**
 * Rebuilds `table` with `column`'s CHECK list widened to `values` (no-op when they're all present). The table keeps
 * its name, column order, rows, indexes and triggers. Returns whether it rebuilt.
 */
export function widenTableCheck(db: DB, table: string, column: string, values: readonly string[]): boolean {
  const ddl = db.prepare(`SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?`).pluck().get(table) as string | undefined;
  if (!ddl) throw new Error(`${table}: no such table`);
  const next = widenCheck(ddl, column, values, table);
  if (next === ddl) return false;
  const dependents = db
    .prepare(`SELECT sql FROM sqlite_schema WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL`)
    .pluck()
    .all(table) as string[];
  const tmp = `${table}_rebuild`;
  db.exec(next.replace(new RegExp(String.raw`^CREATE TABLE\s+("?)${table}\1`, 'i'), `CREATE TABLE ${tmp}`));
  db.exec(`INSERT INTO ${tmp} SELECT * FROM ${table}`);
  db.exec(`DROP TABLE ${table}`);
  db.exec(`ALTER TABLE ${tmp} RENAME TO ${table}`);
  for (const s of dependents) db.exec(s);
  return true;
}

export function up(db: DB): void {
  widenTableCheck(db, 'suggestions', 'kind', ADDED_KINDS);
}
