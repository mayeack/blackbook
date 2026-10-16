/**
 * Server boot: config → data-dir lock → SQLite ABI check → open DB → pre-migrate backup (existing DB only) →
 * migrate → HTTP on 127.0.0.1:PORT + admin socket → scheduler. SIGTERM/SIGINT shut down gracefully.
 * Boot failures exit 1 with one clear line on stderr (launchd discards stdout).
 */
import fs from 'node:fs';
import type { Server } from 'node:http';
import { startAdminServer } from './admin/socket';
import { ensureDataDir, loadConfig, loadDotEnv, type AppConfig } from './config';
import { preMigrateBackup } from './db/backup';
import { rebuildPersonCanon } from './db/canon';
import { checkSqliteAbi, closeDatabase, openDatabase, type DB } from './db/connection';
import { acquireLock, releaseLock } from './db/lock';
import { currentVersion, LATEST_VERSION, migrate } from './db/migrate';
import { createApp } from './http/app';
import type { AuthConfig } from './http/cfAccess';
import { createLogger, errorFields, fileSink, stderrSink, type Logger } from './ops/logger';
import { buildJobs } from './scheduler/jobs/index';
import { Scheduler } from './scheduler/scheduler';
import { VERSION } from './version';

const fail = (msg: string): never => {
  process.stderr.write(`[yeackbot] ${msg}\n`);
  process.exit(1);
};

async function boot(): Promise<{ config: AppConfig; db: DB; log: Logger }> {
  loadDotEnv();
  let config: AppConfig;
  try {
    config = loadConfig();
    ensureDataDir(config);
    acquireLock(config.lockPath);
  } catch (e) {
    return fail((e as Error).message);
  }
  process.on('exit', () => releaseLock(config.lockPath));
  const log = createLogger([fileSink(config.logDir), ...(config.logToStderr ? [stderrSink] : [])]);

  try {
    const { sqliteVersion } = checkSqliteAbi();
    const [major = 0, minor = 0] = sqliteVersion.split('.').map(Number);
    log.info('boot.sqlite', { counts: { sqlite_major: major, sqlite_minor: minor } });
  } catch (e) {
    log.error('boot.sqlite_failed', errorFields(e));
    return fail((e as Error).message);
  }

  const existed = fs.existsSync(config.dbPath);
  let db: DB;
  try {
    db = openDatabase(config.dbPath);
    fs.chmodSync(config.dbPath, 0o600);
  } catch (e) {
    return fail(`could not open the database: ${(e as Error).message} (restore one from ${config.backupDir})`);
  }
  try {
    const from = currentVersion(db);
    if (existed && from > 0 && from < LATEST_VERSION) {
      const b = await preMigrateBackup(db, config.backupDir, from, LATEST_VERSION);
      log.info('boot.pre_migrate_backup', { counts: { from, to: LATEST_VERSION, created: b.created ? 1 : 0 } });
    }
    const applied = migrate(db);
    rebuildPersonCanon(db);
    log.info('boot.migrated', { counts: { applied: applied.length, schema: currentVersion(db) } });
  } catch (e) {
    closeDatabase(db);
    log.error('boot.migrate_failed', errorFields(e));
    return fail(`could not prepare the database: ${(e as Error).message}`);
  }
  return { config, db, log };
}

async function main(): Promise<void> {
  const { config, db, log } = await boot();
  const startedAt = Date.now();
  const auth: AuthConfig = config.devAuthBypass
    ? { mode: 'dev-bypass', email: config.access?.allowedEmail ?? 'dev@example.com' }
    : { mode: 'access', ...config.access! };
  if (config.devAuthBypass) log.warn('boot.dev_auth_bypass');

  const app = createApp({ db, auth, log, webDist: config.webDist, production: config.nodeEnv === 'production', config });
  const server: Server = app.listen(config.port, config.host);
  await new Promise<void>((resolve) => {
    server.once('listening', resolve);
    server.once('error', (err: NodeJS.ErrnoException) => {
      closeDatabase(db);
      fail(err.code === 'EADDRINUSE' ? `port ${config.port} is already in use — is yeackbot already running?` : String(err));
    });
  });

  const scheduler = new Scheduler({ db, jobs: buildJobs({ config }), log });
  let admin: { close(): Promise<void> };
  try {
    admin = await startAdminServer({ socketPath: config.adminSocketPath, db, scheduler, version: VERSION, startedAt, log });
  } catch (e) {
    server.close();
    closeDatabase(db);
    return fail(`could not open the admin socket: ${(e as Error).message}`);
  }
  scheduler.start();
  log.info('boot.listening', { counts: { port: config.port } });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutdown.begin', { error_code: signal });
    const force = setTimeout(() => process.exit(1), 20_000);
    force.unref();
    server.closeIdleConnections();
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    await scheduler.stop(10_000);
    await admin.close();
    setTimeout(() => server.closeAllConnections(), 5000).unref();
    await closed;
    closeDatabase(db);
    log.info('shutdown.done');
    process.exit(0);
  };
  // Anything unexpected: log it (scrubbed) and exit; launchd restarts the server after ThrottleInterval.
  const crash = (event: string) => (e: unknown) => {
    log.error(event, errorFields(e));
    process.exit(1);
  };
  process.on('uncaughtException', crash('process.uncaught_exception'));
  process.on('unhandledRejection', crash('process.unhandled_rejection'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGHUP', () => void shutdown('SIGHUP'));
}

void main();
