import type { DB } from './connection';
import { sql as init } from './migrations/001_init';
import { sql as partifulTexts } from './migrations/002_partiful_texts';
import { sql as pendingReactions } from './migrations/003_pending_reactions';

export interface Migration {
  version: number;
  name: string;
  sql: string;
  /** Data changes that need code (run after `sql`, in the same transaction). */
  up?: (db: DB) => void;
  /** Rebuilds a table (SQLite's 12-step ALTER): foreign keys are off around it and checked before commit. */
  rebuildsTables?: boolean;
}

/** Ordered schema migrations; PRAGMA user_version records the last one applied. */
export const MIGRATIONS: Migration[] = [
  { version: 1, name: 'init', sql: init },
  { version: 2, name: 'partiful_texts', sql: partifulTexts },
  { version: 3, name: 'pending_reactions', sql: pendingReactions },
];

export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

export function currentVersion(db: DB): number {
  return db.pragma('user_version', { simple: true }) as number;
}

/** Applies pending migrations (up to `to`), each in its own transaction. Returns the versions applied. */
export function migrate(db: DB, to = Infinity): number[] {
  const applied: number[] = [];
  const from = currentVersion(db);
  if (from > LATEST_VERSION) {
    throw new Error(`Database schema v${from} is newer than this build (v${LATEST_VERSION}); refusing to run an older server on it.`);
  }
  for (const m of MIGRATIONS) {
    if (m.version <= currentVersion(db) || m.version > to) continue;
    const fkOn = db.pragma('foreign_keys', { simple: true }) === 1;
    if (m.rebuildsTables && fkOn) db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        db.exec(m.sql);
        m.up?.(db);
        if (m.rebuildsTables) {
          const broken = db.pragma('foreign_key_check') as unknown[];
          if (broken.length) throw new Error(`Migration ${m.version} (${m.name}) left ${broken.length} broken reference(s).`);
        }
        db.pragma(`user_version = ${m.version}`);
      }).immediate();
    } finally {
      if (m.rebuildsTables && fkOn) db.pragma('foreign_keys = ON');
    }
    applied.push(m.version);
  }
  return applied;
}
