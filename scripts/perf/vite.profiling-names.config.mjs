// P2-42 — 컴포넌트 이름이 남는 React 프로파일링 빌드(측정 전용, 배포하지 않음). vite.profiling.config.mjs와 같고 minify가
// 함수 이름을 지우지 않게(keepNames)만 다르다 — render-breakdown.mjs가 fiber의 컴포넌트 이름으로 자기 시간을 묶는다.
// render-timing.mjs의 숫자는 이 빌드가 아니라 vite.profiling.config.mjs 빌드로 잰다(keepNames가 크기·시간을 조금 바꾼다).
//
//   npx vite build --config scripts/perf/vite.profiling-names.config.mjs
import path from 'node:path';
import { mergeConfig } from 'vite';
import profilingConfig from './vite.profiling.config.mjs';

export default mergeConfig(profilingConfig, {
  esbuild: { keepNames: true },
  build: {
    outDir: path.resolve('dist/perf-profiling-names'),
    emptyOutDir: true,
  },
});
