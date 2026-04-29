import { defineConfig } from 'vitest/config';

// Root vitest config covers client (src/) and shared contract (shared/) tests only.
// Server tests live in server/ and are run separately via:
//   npm --prefix server test
// (Server has its own vitest.config.ts with the required DATABASE_URL env stub.)
export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'src/**/*.test.{js,ts}',
      'src/**/__tests__/**/*.{js,ts}',
      'shared/**/*.test.{js,ts}',
      'shared/**/__tests__/**/*.{js,ts}',
    ],
    exclude: [
      'server/**',
      'node_modules/**',
      'shared/node_modules/**',
    ],
  },
});
