// Bundles the server into packages/server/dist/index.js (and the `yb` CLI into dist/cli.js) so production runs
// on plain `node`: no tsx at runtime (it keeps a transform cache on disk) and no npm (it writes a log per run).
// The @yb/* workspace packages are TypeScript and get bundled in; everything else in node_modules stays
// external and loads from there (better-sqlite3 is a native addon).
import { build } from 'esbuild';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = resolve(root, 'packages/server');

await build({
  entryPoints: { index: resolve(server, 'src/index.ts'), cli: resolve(server, 'src/cli.ts') },
  outdir: resolve(server, 'dist'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: true,
  logLevel: 'warning',
  plugins: [
    {
      name: 'external-node-modules',
      setup(b) {
        b.onResolve({ filter: /^[^./]/ }, (args) => (args.path.startsWith('@yb/') ? undefined : { path: args.path, external: true }));
      },
    },
  ],
});
process.stdout.write(`bundled ${relative(process.cwd(), resolve(server, 'dist/index.js'))} and dist/cli.js\n`);
