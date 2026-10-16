import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { adminRequest, AdminUnavailableError, startAdminServer } from '../src/admin/socket';
import { backupDatabase, preMigrateBackup, pruneDailyBackups } from '../src/db/backup';
import { closeDatabase, openDatabase } from '../src/db/connection';
import { LATEST_VERSION, migrate } from '../src/db/migrate';
import { daily, Scheduler } from '../src/scheduler/scheduler';
import { buildJobs } from '../src/scheduler/jobs/index';
import { memDb, seedPerson, tempDir } from './helpers';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
const tmp = () => {
  const t = tempDir('yb-');
  cleanups.push(t.cleanup);
  return t.dir;
};

describe('admin socket', () => {
  it('answers status and run-job over a 0600 unix socket', async () => {
    const dir = tmp();
    const db = memDb();
    let ran = 0;
    const scheduler = new Scheduler({ db, jobs: [{ name: 'noop', schedule: daily('03:00'), run: () => void ran++ }] });
    const socketPath = path.join(dir, 'admin.sock');
    const admin = await startAdminServer({ socketPath, db, scheduler, version: '0.1.0', startedAt: Date.now() });
    cleanups.push(() => admin.close());
    expect(fs.statSync(socketPath).mode & 0o777).toBe(0o600);

    const status = await adminRequest(socketPath, { cmd: 'status' });
    expect(status.ok).toBe(true);
    expect(status.ok && status.data).toMatchObject({ pid: process.pid, schemaVersion: LATEST_VERSION, jobs: [{ name: 'noop' }] });

    const run = await adminRequest(socketPath, { cmd: 'run-job', name: 'noop' });
    expect(run).toMatchObject({ ok: true, data: { job: 'noop', status: 'ok' } });
    expect(ran).toBe(1);

    expect(await adminRequest(socketPath, { cmd: 'run-job', name: 'missing' })).toMatchObject({ ok: false, error: { code: 'UNKNOWN_JOB' } });
    expect(await adminRequest(socketPath, { cmd: 'drop-tables' } as never)).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } });

    // setup-self through a running server: validated again, journaled, idempotent
    const set = await adminRequest(socketPath, { cmd: 'set-self-handles', handles: ['+12125550100', 'owner@example.com'] });
    expect(set).toEqual({ ok: true, data: { changed: true } });
    expect(JSON.parse(db.prepare(`SELECT value FROM settings WHERE key = 'self_handles'`).pluck().get() as string)).toEqual([
      '+12125550100',
      'owner@example.com',
    ]);
    expect(await adminRequest(socketPath, { cmd: 'set-self-handles', handles: ['owner@example.com', '+12125550100'] })).toEqual({
      ok: true,
      data: { changed: false },
    });
    expect(await adminRequest(socketPath, { cmd: 'set-self-handles', handles: ['not a handle'] })).toMatchObject({
      ok: false,
      error: { code: 'BAD_HANDLES' },
    });
  });

  it('reports unavailable when nothing listens', async () => {
    await expect(adminRequest(path.join(tmp(), 'none.sock'), { cmd: 'status' })).rejects.toBeInstanceOf(AdminUnavailableError);
  });
});

describe('backups', () => {
  it('db.backup() makes a consistent copy; pre-migrate backups are taken once per upgrade', async () => {
    const dir = tmp();
    const db = openDatabase(path.join(dir, 'yeackbot.db'));
    cleanups.push(() => closeDatabase(db));
    migrate(db);
    seedPerson(db, { display_name: 'Backup Probe' });
    const file = await backupDatabase(db, path.join(dir, 'backups'), 'manual-1');
    const copy = openDatabase(file, { readonly: true });
    expect(copy.prepare('SELECT display_name FROM people').pluck().all()).toEqual(['Backup Probe']);
    expect(copy.pragma('integrity_check', { simple: true })).toBe('ok');
    closeDatabase(copy);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);

    const first = await preMigrateBackup(db, path.join(dir, 'backups'), 1, 2);
    const second = await preMigrateBackup(db, path.join(dir, 'backups'), 1, 2);
    expect(first.created).toBe(true);
    expect(second).toEqual({ file: first.file, created: false });
  });

  it('retention keeps 7 dailies + 4 weeklies and never pre-migrate copies', () => {
    const dir = tmp();
    const today = '2026-10-14';
    const day = (n: number) => new Date(Date.parse(today) - n * 86_400_000).toISOString().slice(0, 10);
    for (let i = 0; i < 60; i++) fs.writeFileSync(path.join(dir, `daily-${day(i)}.db`), '');
    fs.writeFileSync(path.join(dir, 'pre-migrate-v1-to-v2-x.db'), '');
    pruneDailyBackups(dir, today);
    const left = fs.readdirSync(dir).sort();
    expect(left.filter((f) => f.startsWith('daily-'))).toHaveLength(11);
    expect(left).toContain(`daily-${day(0)}.db`);
    expect(left).toContain(`daily-${day(6)}.db`);
    expect(left).toContain('pre-migrate-v1-to-v2-x.db');
  });

  it('the registered backup job writes a daily backup', async () => {
    const dir = tmp();
    const db = openDatabase(path.join(dir, 'yeackbot.db'));
    cleanups.push(() => closeDatabase(db));
    migrate(db);
    const backupDir = path.join(dir, 'backups');
    const s = new Scheduler({ db, jobs: buildJobs({ config: { backupDir, logDir: path.join(dir, 'logs') } }) });
    expect(s.jobNames()).toEqual(['backup', 'logs-prune']);
    expect((await s.runNow('backup')).status).toBe('ok');
    expect(fs.readdirSync(backupDir).some((f) => /^daily-\d{4}-\d{2}-\d{2}\.db$/.test(f))).toBe(true);
  });
});
