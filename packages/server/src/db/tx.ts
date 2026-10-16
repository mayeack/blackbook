import type { DB } from './connection';

/** Runs fn inside an IMMEDIATE transaction; nested calls join the outer one. */
export function tx<T>(db: DB, fn: () => T): T {
  if (db.inTransaction) return fn();
  return db.transaction(fn).immediate();
}
