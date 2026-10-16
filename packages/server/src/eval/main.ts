/**
 * Standalone entry for the eval CLI (scripts/eval.mjs → `npm run eval -- <command>`; the same command is
 * `yb eval` in cli.ts, which production runs from the bundle). Loads .env, resolves the data dir.
 */
import { dataPaths, loadDotEnv } from '../config';
import { evalCommand } from './cli';

loadDotEnv();
evalCommand(process.argv.slice(2), dataPaths(), {
  out: (s) => process.stdout.write(`${s}\n`),
  err: (s) => process.stderr.write(`yb eval: ${s}\n`),
}).then(
  (code) => process.exit(code),
  (e: Error) => {
    process.stderr.write(`yb eval: ${e.message}\n`);
    process.exit(1);
  },
);
