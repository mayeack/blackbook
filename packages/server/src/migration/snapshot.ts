/**
 * Snapshot of the legacy store (architecture.md §5 "Snapshot"): the live store is only ever COPIED (main file +
 * WAL, never -shm, which belongs to the running BlackbookServer's memory map). The copy is checkpointed, switched
 * to journal_mode=DELETE, quick_check'ed, then opened read-only.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { DB } from '../db/connection';

export const DEFAULT_LEGACY_STORE = path.join(os.homedir(), 'Library', 'Application Support', 'Blackbook', 'Server', 'default.store');

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

export interface Snapshot {
  dir: string;
  storePath: string;
  takenAt: number;
  copiedWal: boolean;
  attempts: number;
}

const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

/** size + mtime of the store and its WAL: a change during the copy means the copy may be torn. */
function fingerprint(storePath: string): string {
  return [storePath, `${storePath}-wal`]
    .map((p) => {
      try {
        const s = fs.statSync(p);
        return `${s.size}:${s.mtimeMs}`;
      } catch {
        return '-';
      }
    })
    .join('|');
}

const inside = (child: string, parent: string) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** Copies the legacy store into `<importsDir>/legacy-<ts>/` and prepares the copy. Never writes next to the source. */
export function takeSnapshot(opts: { sourcePath: string; importsDir: string; now?: number; maxAttempts?: number }): Snapshot {
  const source = path.resolve(opts.sourcePath);
  if (!fs.existsSync(source)) throw new SnapshotError(`legacy store not found at ${source}`);
  const importsDir = path.resolve(opts.importsDir);
  if (inside(importsDir, path.dirname(source))) throw new SnapshotError('the imports dir must not be inside the legacy store folder');
  const takenAt = opts.now ?? Date.now();
  const dir = path.join(importsDir, `legacy-${stamp(takenAt)}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const storePath = path.join(dir, 'default.store');

  const maxAttempts = opts.maxAttempts ?? 3;
  let attempts = 0;
  let copiedWal = false;
  for (;;) {
    attempts++;
    for (const f of [storePath, `${storePath}-wal`, `${storePath}-shm`, `${storePath}-journal`]) fs.rmSync(f, { force: true });
    const before = fingerprint(source);
    fs.copyFileSync(source, storePath);
    copiedWal = fs.existsSync(`${source}-wal`);
    if (copiedWal) fs.copyFileSync(`${source}-wal`, `${storePath}-wal`);
    if (fingerprint(source) === before) break;
    if (attempts >= maxAttempts) throw new SnapshotError(`the legacy store kept changing during ${attempts} copy attempts; try again`);
  }
  for (const f of [storePath, `${storePath}-wal`]) if (fs.existsSync(f)) fs.chmodSync(f, 0o600);

  const rw = new Database(storePath);
  try {
    rw.pragma('wal_checkpoint(TRUNCATE)');
    rw.pragma('journal_mode = DELETE');
    const check = rw.pragma('quick_check') as { quick_check: string }[];
    if (check.length !== 1 || check[0]?.quick_check !== 'ok') {
      throw new SnapshotError(`quick_check failed on the snapshot (${check.length} problem row(s))`);
    }
  } finally {
    rw.close();
  }
  for (const f of [`${storePath}-wal`, `${storePath}-shm`]) fs.rmSync(f, { force: true });
  return { dir, storePath, takenAt, copiedWal, attempts };
}

/** Opens a prepared snapshot read-only. */
export function openSnapshot(storePath: string): DB {
  const db = new Database(storePath, { readonly: true, fileMustExist: true });
  db.pragma('query_only = ON');
  return db;
}
