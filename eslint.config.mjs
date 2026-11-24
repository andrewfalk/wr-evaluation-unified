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

// Phase 2 C7-a(P2-64): src/core/**에서 평가 모듈 폴더(src/modules/<id>/…)를 가리키는 import — 아래 no-restricted-imports 블록 두 곳이 쓴다.
const CORE_TO_MODULES_PATTERN = {
  group: ['**/modules/*/**', '!@wr/**'],
  message: '공용 코드(src/core)는 평가 모듈 폴더를 import하지 않는다 — 레지스트리(getModule)와 매니페스트(narrative·batchExport 등)를 쓴다(P2-64).',
};

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
    // 훅·컴포넌트는 setPatients(patientTx.…)로 쓴다. 일괄 가져오기 모달의 예외는 P2-43(patients/batchImportApplied)에서 없앴다.
    files: ['src/**/*.{js,jsx,ts,tsx}'],
    ignores: [
      'src/core/state/**', 'src/core/services/patientRecords.js',
      'src/testing/**', 'src/**/__tests__/**', 'src/**/*.test.{js,jsx,ts,tsx}', 'src/**/*.d.ts',
    ],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          // 같은 폴더 상대경로('./patientRecords')도 잡는다(#321 Codex 권고).
          group: ['**/patientRecords', '**/patientRecords.js'],
          importNames: ['touchPatientRecord'],
          message: '환자 레코드 touch는 환자 상태 전이에서만 — setPatients(patientTx.…)를 쓴다(P2-39).',
        }],
      }],
    },
  },
  // REFACTORING_ROADMAP Phase 2 C7-a(P2-64): 공용 코드(src/core/**)는 평가 모듈 폴더(src/modules/<id>/…)를 import하지 않는다 —
  // 모듈이 가진 것은 레지스트리(getModule·getAllModules)와 매니페스트(narrative·batchExport 등)로 쓴다. 편집 중 경고용이고,
  // 정확한 검사는 구조 래칫(scripts/arch-metrics.mjs coreToModulesImports — 경로를 해석해 센다)이다.
  // 같은 no-restricted-imports를 위 블록과 겹치는 파일에 두면 뒤 블록의 옵션이 앞 것을 대체하므로, src/core/**에는
  // touch 금지 패턴을 함께 넣고(아래 첫 블록), 위 블록이 예외로 둔 환자 상태 계층에는 모듈 금지만 건다(둘째 블록).
  // './modules/registry'·'../modules/manifest'(src/core/modules)와 '@wr/analytics-core/modules/…'는 걸리지 않는다.
  {
    files: ['src/core/**/*.{js,jsx,ts,tsx}'],
    ignores: [
      'src/core/state/**', 'src/core/services/patientRecords.js',
      'src/**/__tests__/**', 'src/**/*.test.{js,jsx,ts,tsx}', 'src/**/*.d.ts',
    ],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['**/patientRecords', '**/patientRecords.js'],
          importNames: ['touchPatientRecord'],
          message: '환자 레코드 touch는 환자 상태 전이에서만 — setPatients(patientTx.…)를 쓴다(P2-39).',
        }, CORE_TO_MODULES_PATTERN],
      }],
    },
  },
  {
    files: ['src/core/state/**/*.{js,jsx,ts,tsx}', 'src/core/services/patientRecords.js'],
    ignores: ['src/**/__tests__/**', 'src/**/*.test.{js,jsx,ts,tsx}', 'src/**/*.d.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [CORE_TO_MODULES_PATTERN] }],
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
