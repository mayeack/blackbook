/**
 * `yb llm-usage` — the API-efficiency report (llm/efficiency.ts) from the terminal: per kind × mode tokens, cost,
 * cache-read share, estimate accuracy and the findings. Read-only (safe while the server runs; WAL readers never
 * block it). Counts and dollars only, never ids, names or content.
 */
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import type { DataPaths } from '../config';
import { closeDatabase, openDatabase } from '../db/connection';
import { currentVersion, LATEST_VERSION } from '../db/migrate';
import { settingTimeZone } from '../settings/registry';
import { efficiencyReport, formatEfficiencyReport } from './efficiency';

export const LLM_USAGE_USAGE = `usage: yb llm-usage [--days 7] [--json]
  per kind: requests, input / cache-read / cache-write / output tokens, cost, cache-read share, cost vs estimate,
  and findings (caching that costs more than it saves, >100K prompts, wasted spend, low estimates, overrides).
  --days 1–90 (default 7). Read-only; nothing is sent.`;

export interface CliIO {
  out: (s: string) => void;
  err: (s: string) => void;
}

export async function llmUsageCommand(args: string[], paths: DataPaths, io: CliIO, now: () => number = Date.now): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: { days: { type: 'string', default: '7' }, json: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h', default: false } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (e) {
    io.err((e as Error).message);
    io.out(LLM_USAGE_USAGE);
    return 2;
  }
  if (values.help) {
    io.out(LLM_USAGE_USAGE);
    return 0;
  }
  const days = Number(values.days);
  if (!Number.isInteger(days) || days < 1 || days > 90) {
    io.err('--days must be a whole number from 1 to 90.');
    return 2;
  }
  if (!fs.existsSync(paths.dbPath)) {
    io.err(`no database at ${paths.dbPath} yet (start the server once).`);
    return 2;
  }
  const db = openDatabase(paths.dbPath, { readonly: true });
  try {
    if (currentVersion(db) !== LATEST_VERSION) {
      io.err(`database is schema v${currentVersion(db)}, this build expects v${LATEST_VERSION}; start the server to migrate.`);
      return 1;
    }
    const report = efficiencyReport(db, now(), { days });
    if (values.json) io.out(JSON.stringify(report));
    else for (const line of formatEfficiencyReport(report, settingTimeZone(db))) io.out(line);
    return 0;
  } finally {
    closeDatabase(db);
  }
}
