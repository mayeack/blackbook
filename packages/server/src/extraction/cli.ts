/**
 * `yb backfill-extract` — the one-time historical extraction backfill (PLAN "LLM extraction": conversation-month
 * windows, ADD-only, then the per-person consolidation pass), paid from its own allowance
 * (settings llm.backfill_budget_usd), separate from the steady-state caps. Prints counts only, never content.
 *
 *   yb backfill-extract          start it (or advance it) and report progress. Through the running server
 *                                (run-job extract-backfill); offline it opens the database itself (data-dir lock)
 *                                with ANTHROPIC_API_KEY from the environment / .env.
 *   yb backfill-extract --estimate   dry run (alias --plan): counts and the estimated $ on the historical route's
 *                                    model at batch prices, against the backfill allowance. Read-only; nothing is sent.
 *   --json                           machine-readable output.
 */
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { adminRequest, AdminUnavailableError } from '../admin/socket';
import type { DataPaths } from '../config';
import { closeDatabase, openDatabase } from '../db/connection';
import { acquireLock, lockOwner, releaseLock } from '../db/lock';
import { currentVersion, LATEST_VERSION } from '../db/migrate';
import { formatUsd as fmtUsd, modelLabel } from '../llm/models';
import { servicesFor } from '../services';
import { backfillStatus, planBackfill, startBackfill, type BackfillReport, type BackfillStatus } from './run';

export const BACKFILL_EXTRACT_USAGE = `usage: yb backfill-extract [--estimate] [--json]
  (no flag)   start the one-time historical extraction backfill, or advance it, and report progress (counts only).
              Spends only from the backfill allowance (Settings → LLM → Backfill allowance); what doesn't fit waits.
  --estimate  dry run: conversations, messages, windows, tokens and the estimated cost ($, batch prices) against
              the allowance. Read-only; nothing is sent. (--plan is the same.)
  --json      machine-readable output`;

export interface CliIO {
  out: (s: string) => void;
  err: (s: string) => void;
}

const fmtCounts = (c: Record<string, number>) =>
  Object.keys(c).length
    ? Object.entries(c)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k} ${v}`)
        .join(' · ')
    : 'none';

function printStatus(io: CliIO, s: BackfillStatus, json: boolean): void {
  if (json) return io.out(JSON.stringify(s));
  io.out(`backfill: ${s.state ?? 'not started'}`);
  io.out(`  windows: ${fmtCounts(s.windows)}`);
  io.out(`  consolidations: ${fmtCounts(s.consolidations)}`);
  io.out(`  spent: ${fmtUsd(s.spentUsd)}`);
}

function printReport(io: CliIO, r: BackfillReport, json: boolean): void {
  if (json) return io.out(JSON.stringify(r));
  io.out(`backfill: ${r.status}${r.reason ? ` (${r.reason})` : ''}`);
  io.out(`  windows: ${fmtCounts(r.windows)}`);
  io.out(`  consolidations: ${fmtCounts(r.consolidations)}`);
  io.out(`  this step: ${fmtCounts(r.counts)}`);
  io.out(`  spent: ${fmtUsd(r.spendUsd)} of ${fmtUsd(r.budgetUsd)}`);
}

export async function backfillExtractCommand(args: string[], paths: DataPaths, io: CliIO): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: {
        estimate: { type: 'boolean', default: false },
        plan: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (e) {
    io.err((e as Error).message);
    io.out(BACKFILL_EXTRACT_USAGE);
    return 2;
  }
  if (values.help) {
    io.out(BACKFILL_EXTRACT_USAGE);
    return 0;
  }
  if (!fs.existsSync(paths.dbPath)) {
    io.err(`no database at ${paths.dbPath} yet (start the server once).`);
    return 2;
  }

  if (values.estimate || values.plan) {
    // Read-only, safe while the server runs (WAL readers never block it).
    const db = openDatabase(paths.dbPath, { readonly: true });
    try {
      if (currentVersion(db) !== LATEST_VERSION) {
        io.err(`database is schema v${currentVersion(db)}, this build expects v${LATEST_VERSION}; start the server to migrate.`);
        return 1;
      }
      const plan = planBackfill(db, Date.now());
      if (values.json) io.out(JSON.stringify(plan));
      else {
        const left = Math.max(0, plan.budgetUsd - plan.spentUsd);
        io.out(`backfill estimate${plan.alreadyStarted ? ' (a backfill was already started)' : ''} — dry run, nothing sent:`);
        io.out(`  conversations ${plan.conversations} (skipped ${plan.conversationsSkipped}) · messages ${plan.messages}`);
        io.out(`  windows ${plan.windows} (dropped by triage ${plan.windowsTriaged}) · ~${plan.tokens} input tokens`);
        io.out(`  estimated cost ≈ ${fmtUsd(plan.estimateUsd)} (${modelLabel(plan.model)}, batch prices, cached system prompt; before consolidation)`);
        io.out(`  allowance ${fmtUsd(plan.budgetUsd)} (spent ${fmtUsd(plan.spentUsd)}, left ${fmtUsd(left)}) · covers ${plan.windowsWithinBudget} of ${plan.windows} windows`);
      }
      return 0;
    } finally {
      closeDatabase(db);
    }
  }

  // Through the running server.
  try {
    const res = await adminRequest(paths.adminSocketPath, { cmd: 'run-job', name: 'extract-backfill' }, 60 * 60 * 1000);
    if (!res.ok) {
      io.err(
        res.error.message.includes('unknown job')
          ? 'the server has no extract-backfill job: it runs only when ANTHROPIC_API_KEY is configured.'
          : res.error.message,
      );
      return 1;
    }
    const db = openDatabase(paths.dbPath, { readonly: true });
    try {
      printStatus(io, backfillStatus(db), values.json);
    } finally {
      closeDatabase(db);
    }
    return (res.data as { status?: string }).status === 'error' ? 1 : 0;
  } catch (e) {
    if (!(e instanceof AdminUnavailableError)) throw e;
  }

  // Offline: take the data-dir lock so a server can't start underneath.
  const owner = lockOwner(paths.lockPath);
  if (owner !== null) {
    io.err(`a server (pid ${owner}) holds the data dir but its admin socket is not answering.`);
    return 1;
  }
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim() || null;
  acquireLock(paths.lockPath);
  const db = openDatabase(paths.dbPath);
  try {
    if (currentVersion(db) !== LATEST_VERSION) {
      io.err(`database is schema v${currentVersion(db)}, this build expects v${LATEST_VERSION}; start the server to migrate.`);
      return 1;
    }
    const { llm, egress } = servicesFor(db, { anthropicApiKey: apiKey });
    const report = await startBackfill({ db, llm, egress, now: () => Date.now() });
    printReport(io, report, values.json);
    if (report.status === 'unavailable') {
      io.err(report.reason === 'no_key' ? 'no ANTHROPIC_API_KEY: nothing was sent (see --estimate for a dry run).' : `nothing was sent (${report.reason}).`);
      return 1;
    }
    if (!values.json) io.out('results are collected by the server (extract-collect, every 5 minutes) once it is running.');
    return 0;
  } finally {
    closeDatabase(db);
    releaseLock(paths.lockPath);
  }
}
