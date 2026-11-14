import js from '@eslint/js';
import globals from 'globals';
import reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

// Lint targets: see package.json "lint" (src/ electron/ api/ shared/ packages/).
//
// Baseline (REFACTORING_ROADMAP P0-4): violations that existed when .jsx linting
// was turned on are frozen in eslint-suppressions.json (ESLint bulk suppressions),
// so only NEW violations fail `npm run lint`.
//   - Never re-run `eslint --suppress-all` — it would silently freeze new violations.
//   - After fixing frozen violations, shrink the baseline with
//     `npx eslint --prune-suppressions src/ electron/ api/ shared/ packages/`.
//   - Fix frozen violations when you touch the file anyway; no mass-fix PRs.
const LINTED_FILES = ['**/*.{js,jsx,mjs,cjs}'];

// Client TypeScript (REFACTORING_ROADMAP Phase 2 P2-00): new client code is written in .ts/.tsx, and
// files moved from .js/.jsx must not drop out of the react-hooks rules or the no-restricted-* rules that
// later Phase 2 PRs add. Scope is src/ only — shared/ and packages/ TS are type-checked by tsc but not
// linted yet (turning typescript-eslint on there would surface unrelated findings). Declaration files
// (src/types/*.d.ts) are skipped: they describe external shapes (the preload bridge) with `any`.
const CLIENT_TS_FILES = ['src/**/*.{ts,tsx}'];
const CLIENT_TS_IGNORES = ['src/**/*.d.ts'];

const reactRules = {
  ...reactPlugin.configs.recommended.rules,
  ...reactHooksPlugin.configs.recommended.rules,
  'react/no-danger': 'error',
  'react/react-in-jsx-scope': 'off',
  // The codebase does not use PropTypes (0 imports); props are typed via
  // checkJs/TypeScript instead (REFACTORING_ROADMAP D3). Leaving this on
  // would report ~2,100 false positives once .jsx files are linted.
  'react/prop-types': 'off',
  'react-hooks/set-state-in-effect': 'warn',
};

const unusedVarsOptions = {
  ignoreRestSiblings: true,
  varsIgnorePattern: '^_',
  argsIgnorePattern: '^_',
  caughtErrorsIgnorePattern: '^_',
};

export default [
  { ...js.configs.recommended, files: LINTED_FILES },
  {
    files: LINTED_FILES,
    plugins: {
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
    },
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: {
        ...globals.browser,
        ...globals.node,
        // vite.config.js가 define으로 빌드 시점에 주입하는 상수(PR0-A, appVersion.js).
        __APP_GIT_COMMIT__: 'readonly',
      },
    },
    settings: {
      react: { version: 'detect' },
    },
    rules: {
      ...reactRules,
      'no-unused-vars': ['error', unusedVarsOptions],
    },
  },
  ...[js.configs.recommended, ...tseslint.configs.recommended].map((config) => ({
    ...config,
    files: CLIENT_TS_FILES,
    ignores: CLIENT_TS_IGNORES,
  })),
  {
    files: CLIENT_TS_FILES,
    ignores: CLIENT_TS_IGNORES,
    plugins: {
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
    },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: {
        ...globals.browser,
        __APP_GIT_COMMIT__: 'readonly',
      },
    },
    settings: {
      react: { version: 'detect' },
    },
    rules: {
      ...reactRules,
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', unusedVarsOptions],
    },
  },
  {
    // REFACTORING_ROADMAP Phase 2 C1(P2-15): window.electron(Electron preload 브리지)은 src/platform/bridge.ts만 읽는다.
    // 다른 코드는 그 파일의 접근자(getFsBridge·getEmrBridge·getMenuBridge·getLifecycleBridge·getAiBridge…)나
    // src/platform/runtime.ts의 detectRuntime()을 쓴다. 테스트·테스트 헬퍼는 셸을 흉내 내려고 직접 꽂으므로 예외.
    files: ['src/**/*.{js,jsx,ts,tsx}'],
    ignores: ['src/platform/bridge.ts', 'src/testing/**', 'src/**/__tests__/**', 'src/**/*.test.{js,jsx,ts,tsx}', 'src/**/*.d.ts'],
    rules: {
      'no-restricted-properties': ['error',
        { object: 'window', property: 'electron', message: 'window.electron은 src/platform/bridge.ts의 접근자로 읽는다(P2-15).' },
        { object: 'globalThis', property: 'electron', message: 'window.electron은 src/platform/bridge.ts의 접근자로 읽는다(P2-15).' },
        { object: 'self', property: 'electron', message: 'window.electron은 src/platform/bridge.ts의 접근자로 읽는다(P2-15).' },
      ],
    },
  },
  {
    // REFACTORING_ROADMAP Phase 2 C2(P2-17): 요청은 src/core/api(apiClient·client·authApi)를 거친다 — 401 refresh·CSRF 재시도·
    // 오류 모양이 한 곳에서 정해진다. 인증 부트스트랩·정적 파일·외부 엔드포인트처럼 인터셉터를 타면 안 되는 요청은
    // requestEnvelope를 쓴다. 테스트·테스트 헬퍼는 fetch를 흉내 내므로 예외.
    files: ['src/**/*.{js,jsx,ts,tsx}'],
    ignores: ['src/core/api/**', 'src/testing/**', 'src/**/__tests__/**', 'src/**/*.test.{js,jsx,ts,tsx}', 'src/**/*.d.ts'],
    rules: {
      'no-restricted-globals': ['error',
        { name: 'fetch', message: '요청은 src/core/api(requestJson·requestEnvelope 등)로 보낸다(P2-17).' },
      ],
    },
  },
  {
    // REFACTORING_ROADMAP Phase 2 C4(P2-39): 환자 레코드 touch(편집 시각·dirty 전환)는 환자 상태 전이(src/core/state/**)에서만 —
    // 훅·컴포넌트는 setPatients(patientTx.…)로 쓴다. 일괄 가져오기 모달(BatchImportModal)의 호출은 게이트 B의 쓰기 단일화 때 정리한다.
    files: ['src/**/*.{js,jsx,ts,tsx}'],
    ignores: [
      'src/core/state/**', 'src/core/services/patientRecords.js', 'src/core/components/BatchImportModal.jsx',
      'src/testing/**', 'src/**/__tests__/**', 'src/**/*.test.{js,jsx,ts,tsx}', 'src/**/*.d.ts',
    ],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['**/services/patientRecords', '**/services/patientRecords.js'],
          importNames: ['touchPatientRecord'],
          message: '환자 레코드 touch는 환자 상태 전이에서만 — setPatients(patientTx.…)를 쓴다(P2-39).',
        }],
      }],
    },
  },
  {
    ignores: [
      'dist/**',
      '**/dist/**',
      'release/**',
      'server/**', // linted by server/eslint.config.mjs (TypeScript)
      'services/**',
      'shared/dist/**',
      'server/dist/**',
      'node_modules/**',
      'electron/emr-helper/**',
      'scripts/**',
      'public/**',
    ],
  },
];
