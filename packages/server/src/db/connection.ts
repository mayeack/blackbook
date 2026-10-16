import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type DB = Database.Database;

export class SqliteAbiError extends Error {
  constructor(cause: Error) {
    super(
      `better-sqlite3 was built for a different Node.js ABI than this node (${process.version}, ` +
        `NODE_MODULE_VERSION ${process.versions.modules}). Run "npm rebuild better-sqlite3" in the repo, ` +
        `and "brew pin node" so upgrades don't break it again. (${cause.message.split('\n')[0]})`,
    );
    this.name = 'SqliteAbiError';
  }
}

const isAbiError = (e: unknown) =>
  e instanceof Error &&
  /NODE_MODULE_VERSION|was compiled against a different Node\.js version|ERR_DLOPEN_FAILED|incompatible architecture/i.test(
    `${e.message} ${(e as NodeJS.ErrnoException).code ?? ''}`,
  );

/** The native addon loads lazily on the first Database(); this surfaces an ABI mismatch with a clear message. */
function construct(file: string, options?: Database.Options): DB {
  try {
    return new Database(file, options);
  } catch (e) {
    if (isAbiError(e)) throw new SqliteAbiError(e as Error);
    throw e;
  }
}

/** Opens an in-memory database once: proves the native module loads and the SQLite build has what we need. */
export function checkSqliteAbi(): { sqliteVersion: string } {
  const db = construct(':memory:');
  try {
    const sqliteVersion = (db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v;
    const [maj = 0, min = 0] = sqliteVersion.split('.').map(Number);
    if (maj < 3 || (maj === 3 && min < 45)) throw new Error(`SQLite ${sqliteVersion} is too old (need ≥ 3.45 for STRICT + FTS5 trigram).`);
    const opts = (db.pragma('compile_options') as { compile_options: string }[]).map((o) => o.compile_options);
    if (!opts.includes('ENABLE_FTS5')) throw new Error('SQLite was built without FTS5.');
    return { sqliteVersion };
  } finally {
    db.close();
  }
}

/** Opens (creating if needed) the database with the pragmas the app relies on (architecture §1b). */
export function openDatabase(file: string, options: { readonly?: boolean } = {}): DB {
  const memory = file === ':memory:';
  if (!memory && !options.readonly) fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = construct(file, options.readonly ? { readonly: true, fileMustExist: true } : undefined);
  if (!memory && !options.readonly) {
    db.pragma('journal_mode = WAL');
    db.pragma('journal_size_limit = 67108864');
  }
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  db.pragma('temp_store = MEMORY');
  if (!memory) db.pragma('mmap_size = 268435456');
  return db;
}

export function closeDatabase(db: DB): void {
  if (!db.open) return;
  try {
    if (!db.readonly) {
      db.pragma('optimize');
      db.pragma('wal_checkpoint(TRUNCATE)');
    }
  } catch {
    // in-memory databases have no WAL
  }
  db.close();
}
