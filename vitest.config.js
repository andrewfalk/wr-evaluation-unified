import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Root vitest config covers client (src/) and shared contract (shared/) tests only.
// Server tests live in server/ and are run separately via:
//   npm --prefix server test
// (Server has its own vitest.config.ts with the required DATABASE_URL env stub.)
//
// '@contracts' resolves to the contract SOURCE (shared/contracts) in tests so they
// run without the prebuilt shared/dist bundle. The app build (vite.config.js) aliases
// '@contracts' to shared/dist instead — separate concerns, identical exports.
export default defineConfig({
  resolve: {
    alias: {
      '@contracts': path.resolve(__dirname, 'shared/contracts'),
    },
  },
  test: {
    environment: 'node',
    include: [
      'src/**/*.test.{js,ts}',
      'src/**/__tests__/**/*.{js,ts}',
      'shared/**/*.test.{js,ts}',
      'shared/**/__tests__/**/*.{js,ts}',
      'electron/**/*.test.{js,ts}',
      'electron/**/__tests__/**/*.{js,ts}',
      'services/**/*.test.{js,ts}',
      'services/**/__tests__/**/*.{js,ts}',
    ],
    exclude: [
      'server/**',
      'node_modules/**',
      'shared/node_modules/**',
    ],
  },
});
