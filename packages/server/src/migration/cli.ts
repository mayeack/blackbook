/**
 * `yb migrate-legacy` handler. Runs offline only: it takes the data-dir lock, so it refuses while the server is
 * running (the import is one long write transaction; the server is the single writer otherwise).
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { DataPaths } from '../config';
import { closeDatabase, openDatabase } from '../db/connection';
import { acquireLock, lockOwner, releaseLock } from '../db/lock';
import { currentVersion, LATEST_VERSION, migrate } from '../db/migrate';
import { DEFAULT_LEGACY_STORE, formatReport, migrateLegacy, type MigrationPhase } from './index';

export const MIGRATE_LEGACY_USAGE = `usage: yb migrate-legacy [--dry-run] [--phase core|reconcile] [--json]
                         [--source <default.store>] [--imports-dir <dir>] [--tz <zone>] [--force]
  --dry-run       do everything (twice, to prove idempotency) inside a transaction, print the report, roll back
  --phase         core (default): people, identities, merges, collections, notes, facts, activities
                  reconcile: match legacy interactions to ingested iMessage history (after the backfill)
  --source        legacy store to snapshot (default: ${DEFAULT_LEGACY_STORE})
  --imports-dir   where the snapshot copy goes (default: $YB_DATA_DIR/imports)
  --tz            time zone legacy birthdays were entered in (default: this Mac's)
  --force         reconcile even if no iMessage history is ingested yet
  --json          print the report as JSON`;

export interface CliIO {
  out: (s: string) => void;
  err: (s: string) => void;
}

export async function migrateLegacyCommand(args: string[], paths: DataPaths, io: CliIO): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: {
        'dry-run': { type: 'boolean', default: false },
        phase: { type: 'string', default: 'core' },
        source: { type: 'string' },
        'imports-dir': { type: 'string' },
        tz: { type: 'string' },
        force: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (e) {
    io.err((e as Error).message);
    io.out(MIGRATE_LEGACY_USAGE);
    return 2;
  }
  if (values.help) {
    io.out(MIGRATE_LEGACY_USAGE);
    return 0;
  }
  if (values.phase !== 'core' && values.phase !== 'reconcile') {
    io.err(`--phase must be core or reconcile`);
    return 2;
  }
  if (values.tz) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: values.tz });
    } catch {
      io.err(`unknown time zone ${values.tz}`);
      return 2;
    }
  }

  const owner = lockOwner(paths.lockPath);
  if (owner !== null) {
    io.err(`the yeackbot server (pid ${owner}) is using ${paths.dataDir}; stop it before migrating (npm run service:stop)`);
    return 1;
  }
  const fresh = !fs.existsSync(paths.dbPath);
  // A dry run before the database exists runs against an empty in-memory one instead of creating the file.
  const inMemory = values['dry-run'] && fresh;
  if (!inMemory) acquireLock(paths.lockPath);
  const db = openDatabase(inMemory ? ':memory:' : paths.dbPath);
  try {
    if (fresh) migrate(db);
    const v = currentVersion(db);
    if (v !== LATEST_VERSION) {
      io.err(`database is schema v${v}, this build expects v${LATEST_VERSION}; start the server once to migrate it`);
      return 1;
    }
    const report = migrateLegacy({
      db,
      sourcePath: path.resolve(values.source ?? DEFAULT_LEGACY_STORE),
      importsDir: path.resolve(values['imports-dir'] ?? path.join(paths.dataDir, 'imports')),
      phase: values.phase as MigrationPhase,
      dryRun: values['dry-run'],
      timeZone: values.tz,
      force: values.force,
    });
    io.out(values.json ? JSON.stringify(report, null, 2) : formatReport(report));
    return report.ok ? 0 : 1;
  } finally {
    closeDatabase(db);
    if (!inMemory) releaseLock(paths.lockPath);
  }
}
