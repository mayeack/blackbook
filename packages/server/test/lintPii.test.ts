import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../src/config';
import { tempDir } from './helpers';

const SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'lint-pii.mjs');
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

function lint(content: string) {
  const t = tempDir();
  cleanups.push(t.cleanup);
  const file = path.join(t.dir, 'sample.ts');
  fs.writeFileSync(file, content);
  const r = spawnSync(process.execPath, [SCRIPT, file], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

// Real-looking values are assembled at runtime so this file itself stays lint-clean.
const join = (...p: string[]) => p.join('');

describe('scripts/lint-pii.mjs', () => {
  it('passes synthetic data', () => {
    const r = lint(
      [
        `const a = '+1 (212) 555-0123';`,
        `const b = '(415) 555-0199';`,
        `const c = '+44 20 7946 0123';`,
        `const d = 'owner@example.com, sam@team.example, x@host.test';`,
        `const e = 'toll-free ${join('+1 8', '44 555 1234')}';`,
        `const f = 978307200; const g = '+0123456789';`,
        `const h = { hash: "${'ab12'.repeat(16)}" };`,
        `const i = 'packages/server/src/scheduler/jobs/index-and-more-words.ts';`,
        `const j = '2125550123'; const k = '212 555 0123'; const l = 12125550123;`,
        `let fnv = 2166136261; const max = 2147483647; buildActionMask = 2147483647;`,
        `const ts = 1760443200000; const rowid = 4152345678901;`,
      ].join('\n'),
    );
    expect(r.out).toMatch(/1 files clean/);
    expect(r.code).toBe(0);
  });

  it('flags real-looking phones, emails and secrets, with the match masked', () => {
    const phone = join('+1 (303) ', '234-', '5678');
    const email = join('jordan.q', '@', 'corp-mail', '.co');
    // Deterministic "secrets" (hashes of a fixed string) so the test can't flake.
    const digest = (alg: string, enc: 'base64' | 'hex') => crypto.createHash(alg).update('lint-pii-fixture').digest(enc);
    const b64 = digest('sha512', 'base64');
    const hex = digest('sha1', 'hex');
    const token = join('sk-', 'ant-', 'api03-', digest('md5', 'hex'));
    const r = lint([`call ${phone}`, `mail ${email}`, `key = "${b64}"`, `id = ${hex}`, `t = ${token}`, join('-----BEGIN ', 'PRIVATE KEY-----')].join('\n'));
    expect(r.code).toBe(1);
    for (const kind of ['phone', 'email', 'base64-secret', 'hex-secret', 'token', 'private-key']) expect(r.out).toContain(`: ${kind} `);
    for (const raw of [phone, email, b64, hex, token]) expect(r.out).not.toContain(raw);
    expect(r.out).toMatch(/sample\.ts:1: phone/);
  });

  it('flags bare and space-separated NANP numbers (Contacts / Core Data shapes)', () => {
    const bare = join('41523', '45678');
    const withOne = join('1415', '2345678');
    const spaced = join('415 ', '234 5678');
    const r = lint([`a = "${bare}"`, `b = '${withOne}'`, `c: ${spaced}`].join('\n'));
    expect(r.code).toBe(1);
    for (const n of [1, 2, 3]) expect(r.out).toMatch(new RegExp(`sample\\.ts:${n}: phone`));
    for (const raw of [bare, withOne, spaced]) expect(r.out).not.toContain(raw);
  });
});
