/**
 * Downloaded screenshots on disk (design §3, review amendments [shots]): `<dataDir>/screenshots/<contact_screenshots.id>.img`,
 * the directory 0700 and every file 0600, written through a `.tmp` + rename so a crash never leaves a half image
 * under a real name. The Picker's media item id is never part of a file name. A file lives until its OCR finishes,
 * and 7 days at most whatever happened. Nothing here logs.
 */
import fs from 'node:fs';
import path from 'node:path';

export const SCREENSHOTS_DIR = 'screenshots';
const FILE_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.img(\.tmp)?$/;

export const screenshotsDir = (dataDir: string): string => path.join(dataDir, SCREENSHOTS_DIR);

/** The file of a contact_screenshots row (ids are uuids: anything else is refused). */
export function screenshotFile(dataDir: string, id: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new Error('not a screenshot id');
  return path.join(screenshotsDir(dataDir), `${id}.img`);
}

/** Creates the directory 0700 (and tightens an existing one). */
export function ensureScreenshotsDir(dataDir: string): string {
  const dir = screenshotsDir(dataDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  return dir;
}

/** Writes the image 0600 under its row id (tmp + rename). */
export function writeScreenshot(dataDir: string, id: string, bytes: Buffer): string {
  ensureScreenshotsDir(dataDir);
  const file = screenshotFile(dataDir, id);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, bytes, { mode: 0o600, flag: 'w' });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  return file;
}

export function readScreenshot(dataDir: string, id: string): Buffer | null {
  try {
    return fs.readFileSync(screenshotFile(dataDir, id));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/** Deletes a row's file (and a leftover tmp); true when something was removed. */
export function deleteScreenshot(dataDir: string, id: string): boolean {
  let removed = false;
  for (const f of [screenshotFile(dataDir, id), `${screenshotFile(dataDir, id)}.tmp`]) {
    try {
      fs.unlinkSync(f);
      removed = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
  return removed;
}

/** Row ids of the files currently in the directory (tmp files included, as their id). */
export function listScreenshotFiles(dataDir: string): { id: string; file: string; tmp: boolean }[] {
  let names: string[];
  try {
    names = fs.readdirSync(screenshotsDir(dataDir));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const out: { id: string; file: string; tmp: boolean }[] = [];
  for (const n of names) {
    const m = FILE_RE.exec(n);
    if (m) out.push({ id: m[1]!, file: path.join(screenshotsDir(dataDir), n), tmp: m[2] !== undefined });
  }
  return out;
}

/**
 * Deletes every screenshot file except those `keep` says to keep (a row still waiting for OCR). Files that don't
 * look like ours are left alone. Returns how many were removed.
 */
export function pruneScreenshotFiles(dataDir: string, keep: (id: string) => boolean = () => false): number {
  let removed = 0;
  for (const f of listScreenshotFiles(dataDir)) {
    if (!f.tmp && keep(f.id)) continue;
    try {
      fs.unlinkSync(f.file);
      removed++;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
  return removed;
}
