import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { readSelfHandles } from '../src/adapters/imessage/ingest';
import { undoBatch } from '../src/journal/undo';
import { GENERATED_SWIFT, parseSelfHandles, selfHandlesSwift, writeSelfHandlesSetting, writeSelfHandlesSwift } from '../src/setup/selfHandles';
import { memDb, T0, tempDir } from './helpers';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

// Synthetic handles only (555-01xx, example.com).
const FILE = ['# my handles', '+1 (212) 555-0100', '212-555-0100   # same number', 'Owner@Example.com', '', 'owner@example.com'].join('\n');

describe('setup-self', () => {
  it('normalizes to E.164 phones and lowercase emails, de-duplicated; rejects anything else', () => {
    expect(parseSelfHandles(FILE)).toEqual({ handles: ['+12125550100', 'owner@example.com'], phones: 1, emails: 1, rejected: 0 });
    expect(parseSelfHandles('not a handle\n39781\nurn:biz:abc\n+12125550101').rejected).toBe(3);
  });

  it('writes a 0600 Swift allowlist and refuses anything that is not a plain handle', () => {
    const t = tempDir('yb-self-');
    cleanups.push(t.cleanup);
    const file = writeSelfHandlesSwift(t.dir, ['+12125550100', 'owner@example.com']);
    expect(file).toBe(path.join(t.dir, GENERATED_SWIFT));
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const src = fs.readFileSync(file, 'utf8');
    expect(src).toContain('enum GeneratedSelfHandles {');
    expect(src).toContain('        "+12125550100",\n        "owner@example.com",\n');
    expect(() => selfHandlesSwift(['x"; evil()'])).toThrow();
  });

  it('settings.self_handles is a journaled, undoable setting the ingester reads', () => {
    const db = memDb();
    expect(writeSelfHandlesSetting(db, ['+12125550100', 'owner@example.com'], T0)).toBe(true);
    expect(readSelfHandles(db).map((k) => k.key)).toEqual(['+12125550100', 'owner@example.com']);
    expect(writeSelfHandlesSetting(db, ['+12125550100', 'owner@example.com'], T0 + 1)).toBe(false);
    expect(writeSelfHandlesSetting(db, ['+12125550101'], T0 + 2)).toBe(true);
    const batches = db.prepare(`SELECT id FROM change_batches WHERE kind = 'setting' ORDER BY seq`).pluck().all() as string[];
    expect(batches).toHaveLength(2);
    undoBatch(db, batches[1]!);
    expect(readSelfHandles(db).map((k) => k.key)).toEqual(['+12125550100', 'owner@example.com']);
    undoBatch(db, batches[0]!);
    expect(readSelfHandles(db)).toEqual([]);
  });
});
