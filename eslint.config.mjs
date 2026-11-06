import js from '@eslint/js';
import globals from 'globals';
import reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';

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
      ...reactPlugin.configs.recommended.rules,
      ...reactHooksPlugin.configs.recommended.rules,
      'react/no-danger': 'error',
      'react/react-in-jsx-scope': 'off',
      // The codebase does not use PropTypes (0 imports); props are typed via
      // checkJs/TypeScript instead (REFACTORING_ROADMAP D3). Leaving this on
      // would report ~2,100 false positives once .jsx files are linted.
      'react/prop-types': 'off',
      'react-hooks/set-state-in-effect': 'warn',
      'no-unused-vars': ['error', {
        ignoreRestSiblings: true,
        varsIgnorePattern: '^_',
        argsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
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
