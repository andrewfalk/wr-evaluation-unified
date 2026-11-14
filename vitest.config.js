import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Fixed time zone for every test (golden/characterization tests depend on local dates — e.g. job
// periods). Set here, in the main process before workers start: assigning process.env.TZ inside a
// test worker does not take effect (REFACTORING_ROADMAP P0-9). Asia/Seoul = the clinic's zone and
// this development PC's, so existing tests behave as before. src/core/fixtures/goldenEnv.js checks it.
process.env.TZ = 'Asia/Seoul';

// Root vitest config covers client (src/) and shared contract (shared/) tests only.
// Server tests live in server/ and are run separately via:
//   npm --prefix server test
// (Server has its own vitest.config.ts with the required DATABASE_URL env stub.)
//
// '@wr/contracts'·'@wr/analytics-core'는 별칭 없이 npm workspaces 심링크(node_modules/@wr/*) →
// 패키지 exports(import 조건) → dist로 해석된다 — 앱 빌드·서버·Electron과 같은 산출물을 테스트한다
// (REFACTORING_ROADMAP P0-7 W4 always-dist). 그래서 `npm test`의 pretest가 두 패키지를 먼저 빌드한다.
// 패키지 소스는 packages/**·shared/** 아래 자체 테스트가 상대 경로로 검사한다.
export default defineConfig({
  // 앱 소스(.jsx)와 동일한 JSX 자동 런타임 변환이 필요 — 렌더링 테스트(.test.jsx)가
  // `import React`(classic 런타임) 없이도 App.jsx 등과 동일하게 동작하도록.
  plugins: [react()],
  test: {
    environment: 'node',
    include: [
      // .jsx: 컴포넌트/훅을 실제 렌더링(jsdom + @testing-library/react)해 검증하는 테스트용.
      // 파일 내부의 `// @vitest-environment jsdom` 주석으로 이 파일만 jsdom 환경을 쓴다
      // (기본 environment는 'node' — 대다수 순수 함수 테스트는 그대로 빠르게 유지).
      // .ts/.tsx: Phase 2부터 새 클라이언트 코드는 TS(REFACTORING_ROADMAP P2-00) — 그 옆 테스트도 포함.
      'src/**/*.test.{js,jsx,ts,tsx}',
      'src/**/__tests__/**/*.{js,jsx,ts,tsx}',
      'shared/**/*.test.{js,ts}',
      'shared/**/__tests__/**/*.{js,ts}',
      'packages/**/*.test.{js,ts}',
      'packages/**/__tests__/**/*.{js,ts}',
      'electron/**/*.test.{js,ts}',
      'electron/**/__tests__/**/*.{js,ts}',
      'services/**/*.test.{js,ts}',
      'services/**/__tests__/**/*.{js,ts}',
      'scripts/**/*.test.mjs',
    ],
    exclude: [
      'server/**',
      'node_modules/**',
      'shared/node_modules/**',
      'packages/**/node_modules/**',
      'packages/analytics-core/dist/**',
      'packages/analytics-core/__tests__/browserParity/**', // Playwright 전용(§9) — vitest 대상 아님
      'services/**/.venv/**', // Python 추론 PoC venv는 스캔 제외(6.0-5)
    ],
  },
});
