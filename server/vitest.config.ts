import { defineConfig } from 'vitest/config';

// Unit tests. Real-Postgres integration tests (*.integration.test.ts) run separately through
// vitest.integration.config.ts — `npm run test:integration`, or `npm run check:full` from the
// repo root, which starts a throwaway database (REFACTORING_ROADMAP P0-10).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/__tests__/**/*.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'src/**/*.integration.test.ts'],
    // Minimum env so config.ts module-level singleton doesn't throw on import.
    // Individual tests override via createConfig({ ... }) for isolation.
    env: {
      DATABASE_URL:         'postgresql://localhost/wr_test',
      ACCESS_TOKEN_SECRET:  'test-access-secret',
      REFRESH_TOKEN_SECRET: 'test-refresh-secret',
    },
  },
});
