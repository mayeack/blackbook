import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { uuidv7 } from '@yb/shared';
import {
  deleteScreenshot,
  listScreenshotFiles,
  pruneScreenshotFiles,
  readScreenshot,
  screenshotFile,
  screenshotsDir,
  writeScreenshot,
} from '../../../src/adapters/gphotos/files';
import { T0, tempDir } from '../../helpers';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

const dataDir = () => {
  const t = tempDir();
  cleanups.push(t.cleanup);
  return t.dir;
};
const mode = (p: string) => fs.statSync(p).mode & 0o777;

describe('screenshot files', () => {
  it('writes <id>.img 0600 in a 0700 directory, reads it back, deletes it', () => {
    const dir = dataDir();
    const id = uuidv7(T0);
    const file = writeScreenshot(dir, id, Buffer.from('fakeimg:x'));
    expect(path.basename(file)).toBe(`${id}.img`);
    expect(mode(file)).toBe(0o600);
    expect(mode(screenshotsDir(dir))).toBe(0o700);
    expect(readScreenshot(dir, id)?.toString()).toBe('fakeimg:x');
    expect(deleteScreenshot(dir, id)).toBe(true);
    expect(readScreenshot(dir, id)).toBeNull();
    expect(deleteScreenshot(dir, id)).toBe(false);
  });

  it('tightens an existing directory to 0700', () => {
    const dir = dataDir();
    fs.mkdirSync(screenshotsDir(dir), { mode: 0o755 });
    writeScreenshot(dir, uuidv7(T0), Buffer.from('x'));
    expect(mode(screenshotsDir(dir))).toBe(0o700);
  });

  it('refuses anything but a row id as a file name (no Picker ids, no path tricks)', () => {
    const dir = dataDir();
    for (const bad of ['media-1', '../escape', `${uuidv7(T0)}/x`, 'AF1QipN-example']) {
      expect(() => screenshotFile(dir, bad)).toThrow(/not a screenshot id/);
      expect(() => writeScreenshot(dir, bad, Buffer.from('x'))).toThrow();
    }
  });

  it('lists and prunes only its own files (tmp leftovers included), keeping the ones asked for', () => {
    const dir = dataDir();
    const keep = uuidv7(T0);
    const drop = uuidv7(T0 + 1);
    writeScreenshot(dir, keep, Buffer.from('a'));
    writeScreenshot(dir, drop, Buffer.from('b'));
    fs.writeFileSync(path.join(screenshotsDir(dir), `${keep}.img.tmp`), 'partial');
    fs.writeFileSync(path.join(screenshotsDir(dir), 'notes.txt'), 'not ours');
    expect(listScreenshotFiles(dir).map((f) => [f.id === keep ? 'keep' : 'drop', f.tmp]).sort()).toEqual([
      ['drop', false],
      ['keep', false],
      ['keep', true],
    ]);
    expect(pruneScreenshotFiles(dir, (id) => id === keep)).toBe(2);
    expect(fs.readdirSync(screenshotsDir(dir)).sort()).toEqual([`${keep}.img`, 'notes.txt'].sort());
    expect(pruneScreenshotFiles(dir)).toBe(1);
    expect(fs.readdirSync(screenshotsDir(dir))).toEqual(['notes.txt']);
  });

  it('a data dir without screenshots/ lists nothing and prunes nothing', () => {
    const dir = dataDir();
    expect(listScreenshotFiles(dir)).toEqual([]);
    expect(pruneScreenshotFiles(dir)).toBe(0);
  });
});
