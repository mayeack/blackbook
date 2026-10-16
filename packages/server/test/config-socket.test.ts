import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { adminSocketPathFor, dataPaths } from '../src/config';

describe('adminSocketPathFor', () => {
  it('keeps the socket in the data dir when the path fits', () => {
    const dir = path.join(os.homedir(), 'Library', 'Application Support', 'Yeackbot');
    expect(adminSocketPathFor(dir)).toBe(path.join(dir, 'admin.sock'));
  });

  it('falls back to a stable per-dir name in $TMPDIR for deep data dirs (macOS 104-byte limit)', () => {
    const deep = path.join(os.tmpdir(), 'x'.repeat(120));
    const sock = adminSocketPathFor(deep);
    expect(Buffer.byteLength(sock)).toBeLessThanOrEqual(103);
    expect(path.dirname(sock)).toBe(os.tmpdir());
    expect(adminSocketPathFor(deep)).toBe(sock);
    expect(adminSocketPathFor(deep + 'y')).not.toBe(sock);
  });

  it('server config and CLI paths agree', () => {
    const deep = path.join(os.tmpdir(), 'y'.repeat(120));
    expect(dataPaths({ YB_DATA_DIR: deep }).adminSocketPath).toBe(adminSocketPathFor(deep));
  });
});
