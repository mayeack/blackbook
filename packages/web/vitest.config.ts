import { defineConfig } from 'vitest/config';

// Web unit tests (pure logic: API client, service-worker navigation, formatting). Root `npm test` runs them
// as the 'web' project; `npm test -w @yb/web` runs them alone.
export default defineConfig({
  test: {
    name: 'web',
    root: import.meta.dirname,
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
