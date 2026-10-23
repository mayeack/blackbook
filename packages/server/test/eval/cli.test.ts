/**
 * `yb eval …` against a temp data dir (never the real one): status, sample, report (text + JSON), shadow --plan,
 * a fake-LLM shadow run, shadow-report, reset. Output is counts, rates and ids only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EvalReport } from '@yb/shared';
import { dataPaths } from '../../src/config';
import { evalCommand } from '../../src/eval/cli';
import { FakeLlmClient } from '../fakes/llm';
import { extraction } from '../extraction/world';
import { tempDir } from '../helpers';
import { buildEvalWorld, HOUR, NOW } from './world';

const PII = ['Sam', 'Rivera', 'Jordan', 'Priya', 'Dana', 'Avery', 'Lumen', 'Denver', 'climbing', '555', 'example.com'];
let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

async function setup() {
  const t = tempDir('yb-eval-cli-');
  cleanup = t.cleanup;
  const paths = dataPaths({ YB_DATA_DIR: t.dir });
  const w = await buildEvalWorld();
  fs.mkdirSync(path.dirname(paths.dbPath), { recursive: true });
  fs.writeFileSync(paths.dbPath, w.db.serialize());
  const lines: string[] = [];
  const errs: string[] = [];
  const io = { out: (s: string) => lines.push(s), err: (s: string) => errs.push(s) };
  const run = async (args: string[], llm?: FakeLlmClient) => {
    lines.length = 0;
    errs.length = 0;
    const code = await evalCommand(args, paths, io, { now: () => NOW + HOUR, ...(llm ? { llm: () => llm } : {}) });
    return { code, out: lines.join('\n'), err: errs.join('\n') };
  };
  return { paths, run, dir: t.dir };
}

/** Random ids (run UUIDs) can contain "555" by chance; they're not PII, so they're blanked first. */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const noPii = (s: string) => {
  const text = s.replace(UUID, '<id>');
  for (const p of PII) expect(text, p).not.toContain(p);
};

describe('yb eval', () => {
  it('status → sample → report, counts only', async () => {
    const { run, paths } = await setup();
    let r = await run(['status']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/extraction\s+0 labeled \/\s+0 items \(target 200\)/);
    r = await run(['sample', '--seed', '7']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/extraction\s+\+4 \(pool 4\) → 4 items/);
    expect(r.out).toMatch(/ask\s+\+2/);
    noPii(r.out);
    r = await run([]); // report is the default
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^extraction: 0 labeled · 4 items \(target 200\)/m);
    expect(r.out).toMatch(/groundedness/);
    expect(r.out).toMatch(/online \(last 30 days\):/);
    noPii(r.out);
    r = await run(['report', '--set', 'golden', '--json']);
    expect(EvalReport.safeParse(JSON.parse(r.out)).success).toBe(true);
    r = await run(['--set', 'identity']);
    expect(r.out).toMatch(/^identity:/);
    expect(r.out).not.toMatch(/^extraction:/m);
    // The data-dir lock is released after a write command.
    expect(fs.existsSync(paths.lockPath)).toBe(false);
  });

  it('shadow: --plan sends nothing; a run replays through the given client; shadow-report reprints', async () => {
    const { run, dir } = await setup();
    const llm = new FakeLlmClient({ responder: () => ({ json: extraction() }) });
    let r = await run(['shadow', '--plan'], llm);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/windows 3 \(golden 0, recent 3\)/);
    expect(llm.calls).toHaveLength(0);
    r = await run(['shadow'], new FakeLlmClient({ configured: false }));
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/no ANTHROPIC_API_KEY: nothing was sent/);
    const file = path.join(dir, 'candidate.txt');
    fs.writeFileSync(file, 'You extract nothing. Return the JSON schema with empty arrays.');
    r = await run(['shadow', '--system-file', file, '--effort', 'medium', '--spot-check', '5'], llm);
    expect(r.code).toBe(0);
    expect(llm.calls).toHaveLength(6); // 3 windows × (knowledge + obligations)
    expect(llm.calls.every((c) => c.effort === 'medium')).toBe(true);
    // The prompt file replaces the knowledge prompt; the obligations requests keep this build's.
    expect(llm.calls.filter((c) => c.system.startsWith('You extract nothing'))).toHaveLength(3);
    expect(r.out).toMatch(/shadow run [0-9a-f-]{36}: prompt [0-9a-f]{8} \(effort medium\) · done · 3 windows/);
    expect(r.out).toMatch(/claims: agree 0 · added 0 · removed \d+/);
    noPii(r.out);
    const again = await run(['shadow-report']);
    expect(again.code).toBe(0);
    expect(again.out).toMatch(/shadow run/);
    expect((await run(['shadow-report', '--json'])).out).toMatch(/"promptVersion"/);
  });

  it('attendance: read-only, counts and rates only (text and JSON)', async () => {
    const { run } = await setup();
    let r = await run(['attendance']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^attendance eval \(\d{4}-\d{2}-\d{2}\): \d+ past Partiful events you went to, guest lists held out/);
    expect(r.out).toMatch(/possible ≥ 0\.5 +precision/);
    noPii(r.out);
    r = await run(['attendance', '--json', '--without-plans']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ events: expect.any(Number), deduction: { possible: { n: expect.any(Number) } } });
  });

  it('reset needs one set and --yes; bad input exits 2', async () => {
    const { run } = await setup();
    await run(['sample', '--set', 'ask']);
    expect((await run(['reset', '--set', 'ask'])).code).toBe(2);
    const r = await run(['reset', '--set', 'ask', '--yes']);
    expect(r).toMatchObject({ code: 0, out: 'ask: removed 2 items' });
    expect((await run(['report', '--set', 'nope'])).code).toBe(2);
    expect((await run(['frobnicate'])).code).toBe(2);
    expect((await run(['shadow', '--days', '99'])).code).toBe(2);
    expect((await run(['sample', '--bogus'])).code).toBe(2);
    expect((await run(['help'])).out).toMatch(/^usage: yb eval/);
  });

  it('refuses a missing database or a schema mismatch', async () => {
    const t = tempDir('yb-eval-cli-');
    cleanup = t.cleanup;
    const errs: string[] = [];
    const code = await evalCommand(['status'], dataPaths({ YB_DATA_DIR: t.dir }), { out: () => undefined, err: (s) => errs.push(s) });
    expect(code).toBe(2);
    expect(errs.join()).toMatch(/no database/);
  });
});
