#!/usr/bin/env node
// The eval harness CLI (intelligence §8): `node scripts/eval.mjs <command>` — report (default), status, sample,
// shadow, shadow-report, reset. See packages/server/src/eval/cli.ts for the commands; it prints counts and rates
// only. Runs the TypeScript entry through tsx from this repo's node_modules (dev checkouts).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsx = path.join(root, 'node_modules', '.bin', 'tsx');
if (!fs.existsSync(tsx)) {
  process.stderr.write('eval: tsx is not installed (run npm install in the repo).\n');
  process.exit(1);
}
const r = spawnSync(tsx, [path.join(root, 'packages/server/src/eval/main.ts'), ...process.argv.slice(2)], { stdio: 'inherit', cwd: root });
process.exit(r.status ?? 1);
