import { defineConfig } from 'vitest/config';

// One `npm test` (and the service.sh deploy gate) runs every package: node-side tests plus the web package's own
// config (packages/web/vitest.config.ts).
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['packages/shared/test/**/*.test.ts', 'packages/server/test/**/*.test.ts'],
          setupFiles: ['packages/server/test/setup.ts'],
          testTimeout: 20_000,
        },
      },
      'packages/web/vitest.config.ts',
    ],
  },
});
