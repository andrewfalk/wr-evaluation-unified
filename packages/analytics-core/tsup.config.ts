import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'index.ts',
    common: 'common.ts',
    workPeriod: 'workPeriod.ts',
    diagnosisMapping: 'diagnosisMapping.ts',
    'modules/knee/index': 'modules/knee/index.ts',
    'migration/deterministicMigrate': 'migration/deterministicMigrate.ts',
  },
  format: ['esm', 'cjs'],
  outDir: 'dist',
  outExtension({ format }) {
    return { js: format === 'cjs' ? '.cjs' : '.js' };
  },
  dts: true,
  clean: true,
  splitting: false,
  treeshake: true,
  external: [],
});
