/**
 * `yb` — admin CLI (npm run yb -- <command>). Talks to the running server over $DATA/admin.sock. When no server
 * is running, commands that need the database open it directly, but only after taking the data-dir lock (so a
 * server can't start underneath them).
 *
 *   yb status            server, schema and job status
 *   yb run-job <name>    run a scheduled job now and wait for it
 *   yb migrate-legacy    import the legacy SwiftData store (offline; --dry-run, --phase core|reconcile)
 *   yb setup-self        your own iMessage handles → settings + the collector's compiled send allowlist
 *   yb backfill-extract  the one-time historical LLM extraction backfill (its own budget; --estimate = dry run)
 *   yb eval              the evaluation harness (report / status / sample / shadow; also npm run eval)
 *   yb llm-usage         the API-efficiency report over the LLM ledger (read-only; llm/efficiency.ts)
 */
import fs from 'node:fs';
import { adminRequest, AdminUnavailableError, serverStatus, type AdminRequest, type AdminResponse } from './admin/socket';
import path from 'node:path';
import { dataPaths, loadDotEnv, PROJECT_ROOT, type DataPaths } from './config';
import { closeDatabase, openDatabase } from './db/connection';
import { acquireLock, lockOwner, releaseLock } from './db/lock';
import { currentVersion, LATEST_VERSION } from './db/migrate';
import { evalCommand } from './eval/cli';
import { backfillExtractCommand } from './extraction/cli';
import { llmUsageCommand } from './llm/usageCli';
import { migrateLegacyCommand } from './migration/cli';
import { buildJobs } from './scheduler/jobs/index';
import { Scheduler, type JobStatus } from './scheduler/scheduler';
import { parseSelfHandles, SELF_HANDLES_FILE, writeSelfHandlesSetting, writeSelfHandlesSwift } from './setup/selfHandles';
import { VERSION } from './version';

const out = (s: string) => process.stdout.write(`${s}\n`);
const err = (s: string) => process.stderr.write(`yb: ${s}\n`);
const fail = (s: string, code = 1) => {
  err(s);
  return code;
};

const USAGE = `usage: yb <command>
  status            server, schema and job status
  run-job <name>    run a scheduled job now and wait for it
  migrate-legacy    import the legacy SwiftData store (offline; see yb migrate-legacy --help)
  backfill-extract [--estimate] [--json]
                    one-time historical LLM extraction (backfill allowance only; --estimate prints counts and $, sends nothing)
  eval [report|status|sample|shadow|shadow-report|reset]
                    the evaluation harness: golden-set metrics, shadow runs of a new prompt (counts and rates only)
  llm-usage [--days 7] [--json]
                    API efficiency: tokens, cost, cache-read share and findings per kind (read-only; nothing is sent)
  setup-self [--file <path>]
                    read your own phone/email handles (one per line; default ./${SELF_HANDLES_FILE}, git-ignored),
                    write settings.self_handles and collector/Generated/SelfHandles.generated.swift`;

/** Local wall-clock "YYYY-MM-DD HH:MM:SS". */
const fmtTime = (ms: number | null) => (ms ? new Date(ms).toLocaleString('sv-SE') : '-');

function printStatus(s: ReturnType<typeof serverStatus>, offline: boolean): void {
  out(offline ? `server: not running (read directly from the database)` : `server: running · pid ${s.pid} · v${s.version} · up ${s.uptimeS}s`);
  out(`schema: v${s.schemaVersion}`);
  out('jobs:');
  const rows = s.jobs.map((j: JobStatus) => [
    j.name,
    j.schedule.kind === 'interval' ? `every ${Math.round(j.schedule.everyMs / 1000)}s` : j.schedule.kind === 'daily' ? `daily ${j.schedule.at}` : `weekly ${j.schedule.dow} ${j.schedule.at}`,
    j.running ? 'running' : j.consecutiveFailures ? `failing×${j.consecutiveFailures}` : 'idle',
    `last ok ${fmtTime(j.lastSuccessAt)}`,
    j.nextDueAt ? `next ${fmtTime(j.nextDueAt)}` : '',
  ]);
  const widths = rows.reduce<number[]>((w, r) => r.map((c, i) => Math.max(w[i] ?? 0, c.length)), []);
  for (const r of rows) out(`  ${r.map((c, i) => c.padEnd(widths[i]!)).join('  ')}`.trimEnd());
}

/** Opens the database directly when no server holds the lock; refuses otherwise. */
async function offline<T>(paths: DataPaths, fn: (s: Scheduler, db: ReturnType<typeof openDatabase>) => Promise<T>): Promise<T> {
  const owner = lockOwner(paths.lockPath);
  if (owner !== null) throw new Error(`a server (pid ${owner}) holds the data dir but its admin socket is not answering.`);
  if (!fs.existsSync(paths.dbPath)) throw new Error(`no database at ${paths.dbPath} yet (start the server once).`);
  acquireLock(paths.lockPath);
  const db = openDatabase(paths.dbPath);
  try {
    const v = currentVersion(db);
    if (v !== LATEST_VERSION) throw new Error(`database is schema v${v}, this build expects v${LATEST_VERSION}; start the server to migrate.`);
    return await fn(new Scheduler({ db, jobs: buildJobs({ config: paths }) }), db);
  } finally {
    closeDatabase(db);
    releaseLock(paths.lockPath);
  }
}

async function send(paths: DataPaths, req: AdminRequest): Promise<AdminResponse | null> {
  try {
    return await adminRequest(paths.adminSocketPath, req);
  } catch (e) {
    if (e instanceof AdminUnavailableError) return null;
    throw e;
  }
}

/** Values are never printed: counts only. */
async function setupSelf(paths: DataPaths, args: string[]): Promise<number> {
  const i = args.indexOf('--file');
  const file = path.resolve(i >= 0 && args[i + 1] ? args[i + 1]! : path.join(PROJECT_ROOT, SELF_HANDLES_FILE));
  if (!fs.existsSync(file)) {
    return fail(`no ${path.basename(file)}: put your own phone numbers and emails in it, one per line (it is git-ignored).`, 2);
  }
  const parsed = parseSelfHandles(fs.readFileSync(file, 'utf8'));
  if (parsed.rejected) return fail(`${parsed.rejected} line(s) are not a valid phone (E.164-able) or email; nothing written.`, 2);
  if (!parsed.handles.length) return fail('no handles found; nothing written.', 2);
  out(`self handles: ${parsed.handles.length} (${parsed.phones} phone, ${parsed.emails} email)`);
  writeSelfHandlesSwift(PROJECT_ROOT, parsed.handles);
  out('wrote collector/Generated/SelfHandles.generated.swift (rebuild and reinstall the collector for sends to use it)');

  const res = await send(paths, { cmd: 'set-self-handles', handles: parsed.handles });
  if (res) {
    if (!res.ok) return fail(res.error.message);
    out(`settings.self_handles ${(res.data as { changed: boolean }).changed ? 'updated' : 'unchanged'} (via the running server)`);
    return 0;
  }
  if (!fs.existsSync(paths.dbPath)) {
    out('settings.self_handles not written: no database yet. Run this again after the server has started once.');
    return 0;
  }
  const changed = await offline(paths, async (_s, db) => writeSelfHandlesSetting(db, parsed.handles));
  out(`settings.self_handles ${changed ? 'updated' : 'unchanged'}`);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  loadDotEnv();
  const paths = dataPaths();
  const [cmd, ...args] = argv;
  switch (cmd) {
    case 'status': {
      const res = await send(paths, { cmd: 'status' });
      if (res) {
        if (!res.ok) return fail(res.error.message);
        printStatus(res.data as ReturnType<typeof serverStatus>, false);
        return 0;
      }
      await offline(paths, async (scheduler, db) => printStatus(serverStatus({ db, scheduler, version: VERSION, startedAt: Date.now() }), true));
      return 0;
    }
    case 'run-job': {
      const name = args[0];
      if (!name) return fail('run-job needs a job name', 2);
      const res = await send(paths, { cmd: 'run-job', name });
      if (res) {
        if (!res.ok) return fail(res.error.message);
        out(JSON.stringify(res.data));
        return (res.data as { status: string }).status === 'error' ? 1 : 0;
      }
      const result = await offline(paths, async (scheduler) => {
        if (!scheduler.jobNames().includes(name)) throw new Error(`no job named ${name}`);
        return scheduler.runNow(name);
      });
      out(JSON.stringify(result));
      return result.status === 'error' ? 1 : 0;
    }
    case 'migrate-legacy':
      return migrateLegacyCommand(args, paths, { out, err });
    case 'backfill-extract':
      return backfillExtractCommand(args, paths, { out, err });
    case 'eval':
      return evalCommand(args, paths, { out, err });
    case 'llm-usage':
      return llmUsageCommand(args, paths, { out, err });
    case 'setup-self':
      return setupSelf(paths, args);
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      out(USAGE);
      return cmd ? 0 : 2;
    default:
      err(`unknown command "${cmd}"`);
      out(USAGE);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: Error) => {
    err(e.message);
    process.exit(1);
  },
);
