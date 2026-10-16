import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(import.meta.dirname, '../src');

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('source hygiene', () => {
  it('no console.* in packages/server/src (logs go through ops/logger, which scrubs PII)', () => {
    const offenders = files(SRC).flatMap((f) =>
      fs
        .readFileSync(f, 'utf8')
        .split('\n')
        .map((line, i) => ({ line, i }))
        .filter(({ line }) => /\bconsole\s*\.\s*(log|info|warn|error|debug|trace|dir|table)\b/.test(line))
        .map(({ i }) => `${path.relative(SRC, f)}:${i + 1}`),
    );
    expect(offenders).toEqual([]);
  });

  it('only the admin socket and loopback listener exist (no 0.0.0.0 binds)', () => {
    const bad = files(SRC).filter((f) => /listen\([^)]*['"]0\.0\.0\.0['"]/.test(fs.readFileSync(f, 'utf8')));
    expect(bad).toEqual([]);
  });
});
