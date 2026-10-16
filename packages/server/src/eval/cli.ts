/**
 * `yb eval …` / `npm run eval -- …` (scripts/eval.mjs): the eval harness from the terminal. Prints counts,
 * rates and ids only — never names, values or message text (the golden items themselves are labeled on
 * /settings/eval). Database access:
 *   report, status, shadow --plan, shadow-report   read-only (safe while the server runs; WAL readers never block)
 *   sample, shadow, reset                           write eval tables (and, for shadow, the LLM ledger). With no
 *                                                   server running they take the data-dir lock first; while the
 *                                                   server runs they write alongside it (WAL + busy timeout:
 *                                                   short transactions on tables only this module uses).
 * The shadow replay calls Claude only with ANTHROPIC_API_KEY set (environment / .env); without it nothing is sent.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { EvalMetric, EvalReport } from '@yb/shared';
import type { DataPaths } from '../config';
import { closeDatabase, openDatabase, type DB } from '../db/connection';
import { acquireLock, lockOwner, releaseLock } from '../db/lock';
import { currentVersion, LATEST_VERSION } from '../db/migrate';
import { formatUsd as fmtUsd } from '../llm/models';
import type { LlmClient, LlmEffort } from '../llm/types';
import { servicesFor } from '../services';
import { buildReport, shadowSummary, type ShadowSummary } from './metrics';
import { sampleSet } from './sample';
import { planShadow, runShadow, type ShadowPlan } from './shadow';
import { getShadowRun, latestShadowRun } from './shadowStore';
import { resetSet, setCounts } from './store';
import { SET_NAMES, type SetName } from './types';

export const EVAL_USAGE = `usage: yb eval <command> [options]        (also: npm run eval -- <command>)
  report [--set <set>|golden] [--json]   metrics vs the targets (default command; read-only)
  status [--json]                        golden-set sizes and labeling progress
  sample [--set <set>] [--size <n>] [--seed <n>] [--json]
                                         build or top up the golden sets from local data (stored in the database)
  shadow [--days 7] [--limit 600] [--max-usd 1] [--effort low|medium|high] [--system-file <path>]
         [--spot-check 20] [--no-golden] [--plan] [--json]
                                         prompt_version comparison: replay recent + golden windows through Claude
                                         into shadow rows (nothing applied). --plan: estimate only, sends nothing
  shadow-report [<runId>] [--json]       the diff and promotion gate of a shadow run (latest by default)
  reset --set <set> --yes                delete a golden set and its labels
sets: extraction, identity, reply_debt, ask ("golden" = all)`;

export interface CliIO {
  out: (s: string) => void;
  err: (s: string) => void;
}

export interface EvalCliDeps {
  /** Tests inject a fake; default: servicesFor(db, {anthropicApiKey from the environment}).llm */
  llm?: (db: DB) => LlmClient;
  now?: () => number;
}

const COMMANDS = ['report', 'status', 'sample', 'shadow', 'shadow-report', 'reset'] as const;
type Command = (typeof COMMANDS)[number];

function parseSet(v: string | undefined): SetName[] | 'bad' {
  if (!v || v === 'golden' || v === 'all') return [...SET_NAMES];
  const sets = v.split(',').map((s) => s.trim().replace('-', '_'));
  return sets.every((s) => (SET_NAMES as readonly string[]).includes(s)) ? (sets as SetName[]) : 'bad';
}

const pct = (v: number | null) => (v === null ? '–' : `${(v * 100).toFixed(1)}%`);
const fmtValue = (m: EvalMetric) => (m.name.startsWith('shadow[') && m.name.endsWith('precision_drop_max') ? (m.value === null ? '–' : `${(m.value * 100).toFixed(1)} pts`) : pct(m.value));
const mark = (m: EvalMetric) => (m.pass === null ? (m.value === null ? '·' : 'i') : m.pass ? '✓' : '✗');

function printMetrics(io: CliIO, metrics: readonly EvalMetric[], indent = '  '): void {
  const w = Math.max(10, ...metrics.map((m) => m.name.length));
  for (const m of metrics) {
    const target = `${m.higherIsBetter ? '≥' : '≤'} ${m.name.endsWith('precision_drop_max') ? `${(m.target * 100).toFixed(0)} pts` : pct(m.target)}`;
    io.out(`${indent}${mark(m)} ${m.name.padEnd(w)}  ${fmtValue(m).padStart(7)}  ${target.padEnd(9)}  n=${m.n}`);
  }
}

function printReport(io: CliIO, r: EvalReport, counts: ReturnType<typeof setCounts>): void {
  for (const s of r.sets) {
    const c = counts.find((x) => x.set === s.set)!;
    io.out(`${s.set}: ${s.labeled} labeled · ${c.total} items (target ${c.target})`);
    printMetrics(io, s.metrics);
  }
  io.out('online (last 30 days):');
  printMetrics(io, r.online);
  if (r.promptVersions.length) io.out(`prompt versions: ${r.promptVersions.join(', ')}`);
  io.out('✓ meets target · ✗ misses it · i informational · · no data yet');
}

function printPlan(io: CliIO, p: ShadowPlan): void {
  io.out(`shadow plan: prompt ${p.promptVersion} (effort ${p.effort}, ${p.systemSource === 'file' ? 'prompt file' : 'this build'})${p.sameAsCurrent ? ' = the current version (a stability re-run)' : ''}`);
  io.out(`  windows ${p.windows} (golden ${p.golden}, recent ${p.recent}) · skipped: excluded ${p.excluded}, no stored input ${p.noInput}`);
  io.out(`  estimated cost ≈ ${fmtUsd(p.estimateUsd)} (synchronous pricing, cached system prompt)`);
}

function printShadow(io: CliIO, s: ShadowSummary): void {
  io.out(`shadow run ${s.runId}: prompt ${s.promptVersion} (effort ${s.effort}) · ${s.status} · ${s.windows} windows · ${fmtUsd(s.costUsd)}`);
  io.out(`  outcomes: ${Object.entries(s.byStatus).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k} ${v}`).join(' · ') || 'none'}`);
  const union = s.agree + s.added + s.removed;
  io.out(`  claims: agree ${s.agree} · added ${s.added} · removed ${s.removed} · agreement ${pct(union ? s.agree / union : null)}`);
  for (const [b, x] of Object.entries(s.byBucket).sort(([a], [b2]) => a.localeCompare(b2))) io.out(`    ${b.padEnd(24)} agree ${x.agree} · added ${x.added} · removed ${x.removed}`);
  const golden = Object.entries(s.golden).sort(([a], [b]) => a.localeCompare(b));
  if (golden.length) {
    io.out('  golden (labeled G1 windows): precision baseline → replay');
    for (const [b, x] of golden) io.out(`    ${b.padEnd(24)} ${pct(x.baseline)} → ${pct(x.shadow)}  n=${x.n}${x.unlabeled ? ` · ${x.unlabeled} new claims unlabeled` : ''}`);
  }
  io.out(
    `  gate: worst precision drop ${s.maxPrecisionDrop === null ? '–' : `${(s.maxPrecisionDrop * 100).toFixed(1)} pts`} (≤ 2 pts) · spot-check ${s.spotCheck.labeled}/${Math.min(20, s.spotCheck.items)} labeled` +
      (s.spotCheck.addedN ? ` · added precision ${pct(s.spotCheck.addedPrecision)} (n=${s.spotCheck.addedN})` : ''),
  );
  const pass = s.maxPrecisionDrop !== null && s.maxPrecisionDrop <= 0.02 && s.spotCheck.labeled >= Math.min(20, s.spotCheck.items);
  io.out(`  promote: ${pass ? 'yes — the gate passes' : 'not yet — label the spot-check items on /settings/eval and keep the drop ≤ 2 pts'}`);
}

function openChecked(paths: DataPaths, readonly: boolean): DB {
  const db = openDatabase(paths.dbPath, readonly ? { readonly: true } : {});
  const v = currentVersion(db);
  if (v !== LATEST_VERSION) {
    closeDatabase(db);
    throw new Error(`database is schema v${v}, this build expects v${LATEST_VERSION}; start the server to migrate.`);
  }
  return db;
}

/** Writes: take the data-dir lock when no server holds it (so one can't start and migrate underneath). */
async function withWriteDb<T>(paths: DataPaths, fn: (db: DB) => Promise<T>): Promise<T> {
  const owner = lockOwner(paths.lockPath);
  const locked = owner === null;
  if (locked) acquireLock(paths.lockPath);
  try {
    const db = openChecked(paths, false);
    try {
      return await fn(db);
    } finally {
      closeDatabase(db);
    }
  } finally {
    if (locked) releaseLock(paths.lockPath);
  }
}

async function withReadDb<T>(paths: DataPaths, fn: (db: DB) => Promise<T> | T): Promise<T> {
  const db = openChecked(paths, true);
  try {
    return await fn(db);
  } finally {
    closeDatabase(db);
  }
}

export async function evalCommand(argv: string[], paths: DataPaths, io: CliIO, deps: EvalCliDeps = {}): Promise<number> {
  const first = argv[0];
  const cmd: Command = first && !first.startsWith('-') ? (first as Command) : 'report';
  const rest = first && !first.startsWith('-') ? argv.slice(1) : argv;
  if (first === 'help' || first === '--help' || first === '-h') {
    io.out(EVAL_USAGE);
    return 0;
  }
  if (!COMMANDS.includes(cmd)) {
    io.err(`unknown eval command "${cmd}"`);
    io.out(EVAL_USAGE);
    return 2;
  }
  let values: Record<string, string | boolean | undefined>;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: rest,
      options: {
        set: { type: 'string' },
        size: { type: 'string' },
        seed: { type: 'string' },
        json: { type: 'boolean', default: false },
        days: { type: 'string' },
        limit: { type: 'string' },
        'max-usd': { type: 'string' },
        effort: { type: 'string' },
        'system-file': { type: 'string' },
        'spot-check': { type: 'string' },
        'no-golden': { type: 'boolean', default: false },
        plan: { type: 'boolean', default: false },
        yes: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
      allowPositionals: cmd === 'shadow-report',
    }));
  } catch (e) {
    io.err((e as Error).message);
    io.out(EVAL_USAGE);
    return 2;
  }
  if (values.help) {
    io.out(EVAL_USAGE);
    return 0;
  }
  const json = values.json === true;
  const num = (k: string, min: number, max: number): number | undefined | 'bad' => {
    const v = values[k];
    if (v === undefined) return undefined;
    const n = Number(v);
    return Number.isFinite(n) && n >= min && n <= max ? n : 'bad';
  };
  const sets = parseSet(values.set as string | undefined);
  if (sets === 'bad') {
    io.err(`--set must be one of ${SET_NAMES.join(', ')} or golden`);
    return 2;
  }
  if (!fs.existsSync(paths.dbPath)) {
    io.err(`no database at ${paths.dbPath} yet (start the server once).`);
    return 2;
  }
  const now = deps.now ?? (() => Date.now());
  const llmFor = deps.llm ?? ((db: DB) => servicesFor(db, { anthropicApiKey: process.env.ANTHROPIC_API_KEY?.trim() || null }).llm);

  switch (cmd) {
    case 'report':
      return withReadDb(paths, (db) => {
        const r = buildReport(db, { now: now(), sets });
        if (json) io.out(JSON.stringify(r));
        else printReport(io, r, setCounts(db));
        return 0;
      });
    case 'status':
      return withReadDb(paths, (db) => {
        const counts = setCounts(db);
        if (json) io.out(JSON.stringify(counts));
        else for (const c of counts) io.out(`${c.set.padEnd(11)} ${String(c.labeled).padStart(4)} labeled / ${String(c.total).padStart(4)} items (target ${c.target})`);
        return 0;
      });
    case 'sample': {
      const size = num('size', 1, 1000);
      const seed = num('seed', 0, 2 ** 32 - 1);
      if (size === 'bad' || seed === 'bad') {
        io.err('--size must be 1–1000 and --seed a non-negative integer');
        return 2;
      }
      return withWriteDb(paths, async (db) => {
        const outs = [];
        for (const set of sets) outs.push(await sampleSet(db, set, { now: now(), ...(size !== undefined ? { size } : {}), ...(seed !== undefined ? { seed } : {}) }));
        if (json) io.out(JSON.stringify(outs));
        else for (const o of outs) io.out(`${o.set.padEnd(11)} +${o.added} (pool ${o.pool}) → ${o.total} items (target ${o.target})`);
        return 0;
      });
    }
    case 'reset': {
      if (!values.set || values.set === 'golden' || values.set === 'all' || sets.length !== 1) {
        io.err('reset needs exactly one --set');
        return 2;
      }
      if (!values.yes) {
        io.err(`this deletes the ${sets[0]} golden set and its labels; add --yes to confirm`);
        return 2;
      }
      return withWriteDb(paths, async (db) => {
        io.out(`${sets[0]}: removed ${resetSet(db, sets[0]!)} items`);
        return 0;
      });
    }
    case 'shadow-report':
      return withReadDb(paths, (db) => {
        const run = positionals[0] ? getShadowRun(db, positionals[0]) : latestShadowRun(db);
        if (!run) {
          io.err(positionals[0] ? 'no such shadow run' : 'no shadow runs yet (yb eval shadow)');
          return 1;
        }
        const s = shadowSummary(db, run);
        if (json) io.out(JSON.stringify(s));
        else printShadow(io, s);
        return 0;
      });
    case 'shadow': {
      const days = num('days', 1, 30);
      const limit = num('limit', 1, 5000);
      const maxUsd = num('max-usd', 0.01, 200);
      const spot = num('spot-check', 0, 100);
      const effort = values.effort as string | undefined;
      if (days === 'bad' || limit === 'bad' || maxUsd === 'bad' || spot === 'bad' || (effort && !['low', 'medium', 'high'].includes(effort))) {
        io.err('bad option: --days 1–30, --limit 1–5000, --max-usd 0.01–200, --spot-check 0–100, --effort low|medium|high');
        return 2;
      }
      let system: { text: string; source: 'file' } | undefined;
      if (values['system-file']) {
        const file = path.resolve(String(values['system-file']));
        if (!fs.existsSync(file)) {
          io.err('the --system-file does not exist');
          return 2;
        }
        const text = fs.readFileSync(file, 'utf8');
        if (!text.trim()) {
          io.err('the --system-file is empty');
          return 2;
        }
        system = { text, source: 'file' };
      }
      const opts = {
        ...(days !== undefined ? { days } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(maxUsd !== undefined ? { maxUsd } : {}),
        ...(spot !== undefined ? { spotCheck: spot } : {}),
        ...(effort ? { effort: effort as LlmEffort } : {}),
        ...(system ? { system } : {}),
        includeGolden: !values['no-golden'],
      };
      if (values.plan) {
        return withReadDb(paths, (db) => {
          const p = planShadow({ db, now: now(), ...opts });
          if (json) io.out(JSON.stringify(p));
          else printPlan(io, p);
          return 0;
        });
      }
      return withWriteDb(paths, async (db) => {
        const llm = llmFor(db);
        const out = await runShadow({ db, llm, now: now(), ...opts });
        if (json) {
          io.out(JSON.stringify(out));
          return out.status === 'unavailable' ? 1 : 0;
        }
        printPlan(io, out.plan);
        if (out.status === 'unavailable') {
          io.err(
            out.reason === 'no_key'
              ? 'no ANTHROPIC_API_KEY: nothing was sent (--plan shows what a run would cost).'
              : out.reason === 'no_windows'
                ? 'nothing to replay: no applied windows with a stored input in range.'
                : `nothing was sent (${out.reason}).`,
          );
          return 1;
        }
        printShadow(io, out.summary);
        if (out.stopReason) io.err(`stopped early: ${out.stopReason} (the run is ${out.status}).`);
        return 0;
      });
    }
  }
  return 2;
}

