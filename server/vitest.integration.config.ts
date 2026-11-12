import { defineConfig } from 'vitest/config';

// Real-Postgres integration tests (REFACTORING_ROADMAP P0-10 / P0-2).
//   npm run test:integration          (needs TEST_DATABASE_URL → a database named wr_test*)
//   npm run check:full  (repo root)   (starts a throwaway Postgres container and sets it)
// globalSetup refuses any database whose name does not start with `wr_test`, then applies
// migrations. Files run one at a time: they share one database, and the stats queue tests
// start real workers that claim any queued job.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.integration.test.ts'],
    fileParallelism: false,
    // Some files spawn the real Python stats engine.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    globalSetup: ['./src/testing/integrationGlobalSetup.ts'],
    env: {
      DATABASE_URL:         'postgresql://localhost/wr_test',
      ACCESS_TOKEN_SECRET:  'test-access-secret-0123456789abcd',
      // S8: the integration tests' own queue namespace — rows they create and the workers they start stay
      // apart from a development server that might use the same test database.
      QUEUE_NAMESPACE:      'itest',
    },
  },
});
