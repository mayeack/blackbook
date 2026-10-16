/**
 * Finding and reading Instagram "Download your information" exports in IMPORTS_DIR, read-only: a zip as
 * downloaded, or its extracted folder. Files are never moved, renamed or deleted; what was imported is recorded
 * in import_files by content hash (a re-dropped or renamed export is recognised) and by (path, size, mtime) (so an
 * hourly scan of unchanged files hashes nothing).
 * Only the JSON entries the importer understands are read (dyiEntryType); media are never opened.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import yauzl from 'yauzl';
import type { DB } from '../../db/connection';

export const DYI_SOURCE = 'instagram_dyi';

export type DyiEntryType = 'thread' | 'followers' | 'following' | 'personal';

export interface DyiEntryInfo {
  type: DyiEntryType;
  /** For threads: the inbox folder (inbox, message_requests, …) and the thread folder name. */
  box?: string;
  folder?: string;
}

const THREAD = /(?:^|\/)messages\/([^/]+)\/([^/]+)\/message_\d+\.json$/i;
const FOLLOWERS = /(?:^|\/)followers_and_following\/followers(?:_\d+)?\.json$/i;
const FOLLOWING = /(?:^|\/)followers_and_following\/following(?:_\d+)?\.json$/i;
const PERSONAL = /(?:^|\/)personal_information\.json$/i;
const HTML_EXPORT = /(?:^|\/)messages\/[^/]+\/[^/]+\/message_\d+\.html$|(?:^|\/)followers_and_following\/[^/]+\.html$/i;

/** What a path inside an export is (null: not something the importer reads). */
export function dyiEntryType(rel: string): DyiEntryInfo | null {
  const p = rel.replaceAll('\\', '/');
  const t = THREAD.exec(p);
  if (t) return { type: 'thread', box: t[1]!.toLowerCase(), folder: t[2]! };
  if (FOLLOWERS.test(p)) return { type: 'followers' };
  if (FOLLOWING.test(p)) return { type: 'following' };
  if (PERSONAL.test(p)) return { type: 'personal' };
  return null;
}

export const isHtmlExportEntry = (rel: string): boolean => HTML_EXPORT.test(rel.replaceAll('\\', '/'));

/** One readable JSON document of an export. */
export interface DyiEntry extends DyiEntryInfo {
  /** Path inside the export (zip entry name, or the file path relative to IMPORTS_DIR). */
  rel: string;
  size: number;
  read(): Promise<string>;
}

/** A file the importer tracks in import_files: a zip, or one JSON file of an extracted export. */
export interface DyiUnit {
  kind: 'zip' | 'json';
  path: string;
  size: number;
  mtimeMs: number;
}

export interface ScanResult {
  folderMissing: boolean;
  units: DyiUnit[];
}

const MAX_DEPTH = 8;
const MAX_DIR_ENTRIES = 200_000;
/** Message JSON files are a few MB; anything this big is not one. */
export const MAX_ENTRY_BYTES = 512 * 1024 * 1024;

/** Zips and importer-relevant JSON files under `dir` (hidden entries and symlinks skipped). */
export async function scanImports(dir: string): Promise<ScanResult> {
  try {
    if (!(await fsp.stat(dir)).isDirectory()) return { folderMissing: true, units: [] };
  } catch {
    return { folderMissing: true, units: [] };
  }
  const units: DyiUnit[] = [];
  let seen = 0;
  const walk = async (d: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || seen > MAX_DIR_ENTRIES) return;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (++seen > MAX_DIR_ENTRIES) return;
      if (e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (e.isFile()) {
        const lower = e.name.toLowerCase();
        const kind = lower.endsWith('.zip') ? 'zip' : lower.endsWith('.json') && dyiEntryType(path.relative(dir, p)) ? 'json' : null;
        if (!kind) continue;
        try {
          const st = await fsp.stat(p);
          units.push({ kind, path: p, size: st.size, mtimeMs: Math.trunc(st.mtimeMs) });
        } catch {
          // vanished between readdir and stat
        }
      }
    }
  };
  await walk(dir, 0);
  units.sort((a, b) => a.path.localeCompare(b.path));
  return { folderMissing: false, units };
}

export async function sha256File(file: string): Promise<string> {
  const h = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}

// ---------------------------------------------------------------------------------------- import_files

export interface ImportFileRow {
  sha256: string;
  path: string;
  size: number;
  mtime_ms: number;
  status: 'imported' | 'failed' | 'ignored';
  attempts: number;
}

/** A failed file is retried on later scans up to this many attempts (then only when its content changes). */
export const MAX_ATTEMPTS = 3;

/** Unchanged since the last scan (same path, size and mtime) and finished or out of attempts: nothing to do. */
export function knownByStat(db: DB, u: DyiUnit): boolean {
  const row = db
    .prepare('SELECT status, attempts FROM import_files WHERE source = ? AND path = ? AND size = ? AND mtime_ms = ?')
    .get(DYI_SOURCE, u.path, u.size, u.mtimeMs) as { status: string; attempts: number } | undefined;
  return row !== undefined && (row.status !== 'failed' || row.attempts >= MAX_ATTEMPTS);
}

export const importFileBySha = (db: DB, sha: string): ImportFileRow | undefined =>
  db.prepare('SELECT sha256, path, size, mtime_ms, status, attempts FROM import_files WHERE source = ? AND sha256 = ?').get(DYI_SOURCE, sha) as
    | ImportFileRow
    | undefined;

/** Records where a known file is now (renamed, moved, touched) without re-importing it. */
export function touchImportFile(db: DB, sha: string, u: DyiUnit, now: number): void {
  db.prepare('UPDATE import_files SET path = ?, size = ?, mtime_ms = ?, updated_at = ? WHERE source = ? AND sha256 = ?').run(
    u.path,
    u.size,
    u.mtimeMs,
    now,
    DYI_SOURCE,
    sha,
  );
}

export function recordImportFile(
  db: DB,
  sha: string,
  u: DyiUnit,
  now: number,
  status: ImportFileRow['status'],
  o: { error?: string | null; stats?: Record<string, number> } = {},
): void {
  db.prepare(
    `INSERT INTO import_files (source, sha256, path, size, mtime_ms, status, attempts, error, stats, first_seen_at, updated_at)
     VALUES (@source, @sha, @path, @size, @mtime, @status, 1, @error, @stats, @now, @now)
     ON CONFLICT (source, sha256) DO UPDATE SET path = excluded.path, size = excluded.size, mtime_ms = excluded.mtime_ms,
       status = excluded.status, error = excluded.error, stats = coalesce(excluded.stats, import_files.stats),
       attempts = CASE WHEN excluded.status = 'failed' THEN import_files.attempts + 1 ELSE import_files.attempts END,
       updated_at = excluded.updated_at`,
  ).run({
    source: DYI_SOURCE,
    sha,
    path: u.path,
    size: u.size,
    mtime: u.mtimeMs,
    status,
    error: o.error ?? null,
    stats: o.stats ? JSON.stringify(o.stats) : null,
    now,
  });
}

// ---------------------------------------------------------------------------------------- reading

async function readStream(stream: NodeJS.ReadableStream, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of stream) {
    const b = c as Buffer;
    n += b.length;
    if (n > limit) throw new Error('export entry is too large');
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export interface OpenedUnit {
  entries: DyiEntry[];
  /** Entries of an HTML-format export (the importer needs the JSON format). */
  htmlEntries: number;
  close(): void;
}

/** The importer-relevant entries of a unit; read() is lazy. */
export async function openUnit(u: DyiUnit, importsDir: string): Promise<OpenedUnit> {
  if (u.kind === 'json') {
    const rel = path.relative(importsDir, u.path);
    const info = dyiEntryType(rel);
    const entries: DyiEntry[] = info ? [{ ...info, rel, size: u.size, read: () => fsp.readFile(u.path, 'utf8') }] : [];
    return { entries, htmlEntries: 0, close() {} };
  }
  const zip = await yauzl.openPromise(u.path, { lazyEntries: true, autoClose: false, decodeStrings: true });
  const entries: DyiEntry[] = [];
  let htmlEntries = 0;
  try {
    for await (const e of zip.eachEntry()) {
      if (e.fileName.endsWith('/')) continue;
      if (isHtmlExportEntry(e.fileName)) htmlEntries++;
      const info = dyiEntryType(e.fileName);
      if (!info || e.uncompressedSize > MAX_ENTRY_BYTES) continue;
      entries.push({
        ...info,
        rel: e.fileName,
        size: e.uncompressedSize,
        read: async () => readStream(await zip.openReadStreamPromise(e), MAX_ENTRY_BYTES),
      });
    }
  } catch (err) {
    zip.close();
    throw err;
  }
  let closed = false;
  const close = () => {
    if (!closed) {
      closed = true;
      zip.close();
    }
  };
  return { entries, htmlEntries, close };
}
