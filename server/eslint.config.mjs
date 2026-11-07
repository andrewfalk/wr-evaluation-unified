import tseslint from 'typescript-eslint';

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true, argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // S2 / P1-10 — settings come from config (src/config.ts, parsed by src/config/schema.ts), not
    // from process.env. Exceptions: the config module itself, process entry points that run without
    // the server's config (cli/*, the migrate CLI), and test code.
    files: ['src/**/*.ts'],
    ignores: [
      'src/config.ts', 'src/config/**', 'src/cli/**', 'src/testing/**', 'src/db/migrate.ts',
      'src/**/__tests__/**', 'src/**/*.test.ts',
    ],
    rules: {
      'no-restricted-syntax': ['error', {
        selector: "MemberExpression[object.name='process'][property.name='env']",
        message: 'Read settings from config (src/config.ts) — add the variable to src/config/schema.ts.',
      }],
    },
  },
  { ignores: ['dist/**', 'node_modules/**'] }
);
