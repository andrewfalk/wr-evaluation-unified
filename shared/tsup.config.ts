import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'contracts/index.ts',
    workspace: 'contracts/workspace.ts',
    autosave: 'contracts/autosave.ts',
    auth: 'contracts/auth.ts',
    config: 'contracts/config.ts',
    patient: 'contracts/patient.ts',
    preset: 'contracts/preset.ts',
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
