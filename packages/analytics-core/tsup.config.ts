import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'index.ts',
    common: 'common.ts',
    workPeriod: 'workPeriod.ts',
    diagnosisMapping: 'diagnosisMapping.ts',
    'modules/knee/index': 'modules/knee/index.ts',
    'modules/shoulder/index': 'modules/shoulder/index.ts',
    'modules/elbow/index': 'modules/elbow/index.ts',
    'modules/wrist/index': 'modules/wrist/index.ts',
    'modules/cervical/index': 'modules/cervical/index.ts',
    'modules/spine/index': 'modules/spine/index.ts',
    'migration/deterministicMigrate': 'migration/deterministicMigrate.ts',
    completion: 'completion.ts',
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
