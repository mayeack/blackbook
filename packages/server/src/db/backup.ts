import fs from 'node:fs';
import path from 'node:path';
import { localDate } from '@yb/shared';
import type { DB } from './connection';

const stamp = (d = new Date()) => d.toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');

/**
 * Consistent online copy via the SQLite backup API (db.backup), which copies in pages and yields to the event
 * loop between them. Not VACUUM INTO: that blocks the single writer for the whole copy.
 */
export async function backupDatabase(db: DB, dir: string, name: string): Promise<string> {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, name.endsWith('.db') ? name : `${name}.db`);
  const tmp = `${file}.partial`;
  fs.rmSync(tmp, { force: true });
  await db.backup(tmp, { progress: () => 256 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
  return file;
}

function listBackups(dir: string, prefix: string): { file: string; name: string }[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.db'))
    .sort()
    .reverse()
    .map((name) => ({ name, file: path.join(dir, name) }));
}

/**
 * Backup before migrating from `from` to `to`, taken once per upgrade: launchd relaunches a failing server
 * every ~10 s, so an existing copy for the same upgrade is reused instead of piling up new ones.
 */
export async function preMigrateBackup(db: DB, dir: string, from: number, to: number): Promise<{ file: string; created: boolean }> {
  const prefix = `pre-migrate-v${from}-to-v${to}-`;
  const existing = listBackups(dir, prefix)[0];
  if (existing) return { file: existing.file, created: false };
  return { file: await backupDatabase(db, dir, `${prefix}${stamp()}`), created: true };
}

/**
 * The nightly backup (daily-YYYY-MM-DD.db, local date), then retention: the 7 newest dailies plus the newest
 * daily of each of the 4 weeks before them. pre-migrate backups are never pruned.
 */
export async function dailyBackup(db: DB, dir: string, now = Date.now(), timeZone?: string): Promise<{ file: string; pruned: string[] }> {
  const today = localDate(now, timeZone);
  const file = await backupDatabase(db, dir, `daily-${today}`);
  return { file, pruned: pruneDailyBackups(dir, today) };
}

export function pruneDailyBackups(dir: string, today: string): string[] {
  const all = listBackups(dir, 'daily-');
  const keep = new Set(all.slice(0, 7).map((b) => b.name));
  const weekly = new Map<number, string>();
  for (const b of all.slice(7)) {
    const date = b.name.slice('daily-'.length, 'daily-'.length + 10);
    const ageDays = Math.round((Date.parse(today) - Date.parse(date)) / 86_400_000);
    const week = Math.floor(ageDays / 7);
    if (week >= 1 && week <= 5 && !weekly.has(week)) weekly.set(week, b.name);
  }
  for (const name of [...weekly.values()].slice(0, 4)) keep.add(name);
  const pruned: string[] = [];
  for (const b of all) {
    if (keep.has(b.name)) continue;
    fs.rmSync(b.file, { force: true });
    pruned.push(b.name);
  }
  return pruned;
}

