import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
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
  // 앱 소스(.jsx)와 동일한 JSX 자동 런타임 변환이 필요 — 렌더링 테스트(.test.jsx)가
  // `import React`(classic 런타임) 없이도 App.jsx 등과 동일하게 동작하도록.
  plugins: [react()],
  resolve: {
    alias: {
      '@contracts': path.resolve(__dirname, 'shared/contracts'),
    },
  },
  test: {
    environment: 'node',
    include: [
      // .jsx: 컴포넌트/훅을 실제 렌더링(jsdom + @testing-library/react)해 검증하는 테스트용.
      // 파일 내부의 `// @vitest-environment jsdom` 주석으로 이 파일만 jsdom 환경을 쓴다
      // (기본 environment는 'node' — 대다수 순수 함수 테스트는 그대로 빠르게 유지).
      'src/**/*.test.{js,jsx,ts}',
      'src/**/__tests__/**/*.{js,jsx,ts}',
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
      'services/**/.venv/**', // Python 추론 PoC venv는 스캔 제외(6.0-5)
    ],
  },
});
