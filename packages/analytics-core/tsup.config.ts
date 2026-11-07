import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'index.ts',
    common: 'common.ts',
    workPeriod: 'workPeriod.ts',
    jobScope: 'jobScope.ts',
    diagnosisMapping: 'diagnosisMapping.ts',
    'modules/knee/index': 'modules/knee/index.ts',
    'modules/shoulder/index': 'modules/shoulder/index.ts',
    'modules/elbow/index': 'modules/elbow/index.ts',
    'modules/wrist/index': 'modules/wrist/index.ts',
    'modules/cervical/index': 'modules/cervical/index.ts',
    // G8 레거시 정합 골든(src/modules/{cervical,elbow,wrist}/utils/__tests__/legacyParity.characterization.test.js)이
    // dist로 해석될 때도(P0-7 W4) import할 수 있게 엔트리로 낸다.
    'modules/cervical/legacyNormalize': 'modules/cervical/legacyNormalize.ts',
    'modules/elbow/legacyNormalize': 'modules/elbow/legacyNormalize.ts',
    'modules/wrist/legacyNormalize': 'modules/wrist/legacyNormalize.ts',
    'modules/spine/index': 'modules/spine/index.ts',
    'modules/job/index': 'modules/job/index.ts',
    'modules/diagnosis/index': 'modules/diagnosis/index.ts',
    'modules/patient/index': 'modules/patient/index.ts',
    'migration/deterministicMigrate': 'migration/deterministicMigrate.ts',
    completion: 'completion.ts',
    catalog: 'catalog.ts',
    grainEntities: 'grainEntities.ts',
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
