import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/__tests__/**/*.ts'],
    // Minimum env so config.ts module-level singleton doesn't throw on import.
    // Individual tests override via createConfig({ ... }) for isolation.
    env: {
      DATABASE_URL:         'postgresql://localhost/wr_test',
      ACCESS_TOKEN_SECRET:  'test-access-secret',
      REFRESH_TOKEN_SECRET: 'test-refresh-secret',
    },
  },
});
