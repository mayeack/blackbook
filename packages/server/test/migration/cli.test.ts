import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dataPaths } from '../../src/config';
import { openDatabase } from '../../src/db/connection';
import { migrateLegacyCommand } from '../../src/migration/cli';
import { tempDir } from '../helpers';
import { buildLegacyStore } from './fixture';
import { scenario, TZ } from './scenario';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

function env() {
  const t = tempDir('yb-legacy-cli-');
  cleanups.push(t.cleanup);
  fs.mkdirSync(path.join(t.dir, 'source'));
  const source = buildLegacyStore(path.join(t.dir, 'source', 'default.store'), scenario());
  const paths = dataPaths({ YB_DATA_DIR: path.join(t.dir, 'data') });
  const lines: string[] = [];
  const errors: string[] = [];
  const io = { out: (s: string) => lines.push(s), err: (s: string) => errors.push(s) };
  const cmd = (...args: string[]) => migrateLegacyCommand(['--source', source, '--tz', TZ, ...args], paths, io);
  return { paths, lines, errors, cmd };
}

describe('yb migrate-legacy', () => {
  it('dry-runs into a fresh data dir, prints counts only, and leaves no lock behind', async () => {
    const e = env();
    expect(await e.cmd('--dry-run')).toBe(0);
    const text = e.lines.join('\n');
    expect(text).toMatch(/DRY RUN/);
    expect(text).toMatch(/idempotency: second pass inserted 0 row/);
    for (const s of ['Rivera', 'Jordan', '555', 'example.com']) expect(text).not.toContain(s);
    expect(fs.existsSync(e.paths.lockPath)).toBe(false);
    expect(fs.readdirSync(path.join(e.paths.dataDir, 'imports'))).toHaveLength(1);
    expect(fs.existsSync(e.paths.dbPath)).toBe(false); // no database yet → dry run used an in-memory one
  });

  it('dry-runs against an existing database without changing it', async () => {
    const e = env();
    expect(await e.cmd()).toBe(0);
    const db = openDatabase(e.paths.dbPath);
    const before = db.prepare('SELECT count(*) FROM change_batches').pluck().get();
    db.close();
    expect(await e.cmd('--dry-run')).toBe(0);
    const after = openDatabase(e.paths.dbPath);
    try {
      expect(after.prepare('SELECT count(*) FROM change_batches').pluck().get()).toBe(before);
      expect(after.prepare("SELECT count(*) FROM runs WHERE kind = 'migration'").pluck().get()).toBe(1);
    } finally {
      after.close();
    }
  });

  it('imports for real, then reports JSON with nothing new on a second run', async () => {
    const e = env();
    expect(await e.cmd()).toBe(0);
    e.lines.length = 0;
    expect(await e.cmd('--json')).toBe(0);
    const report = JSON.parse(e.lines.join('\n'));
    expect(report.ok).toBe(true);
    expect(report.core.inserted).toEqual({});
    expect(report.core.existing.people).toBe(14);
  });

  it('rejects bad arguments and refuses while a server holds the data dir', async () => {
    const e = env();
    expect(await e.cmd('--phase', 'everything')).toBe(2);
    expect(await e.cmd('--tz', 'Not/AZone')).toBe(2);
    fs.mkdirSync(e.paths.dataDir, { recursive: true });
    fs.writeFileSync(e.paths.lockPath, `${process.ppid}\n`);
    expect(await e.cmd('--dry-run')).toBe(1);
    expect(e.errors.join('\n')).toMatch(/stop it before migrating/);
  });
});
