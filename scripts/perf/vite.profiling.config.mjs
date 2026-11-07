// P0-13 성능 기준선 ④ — React 프로파일링 빌드(측정 전용, 배포하지 않음).
// 운영 설정(vite.config.js) 그대로에 react-dom만 react-dom/profiling으로 바꾼다. 프로파일링 빌드는
// DevTools 훅이 있으면 루트에 ProfileMode를 켜고 fiber마다 actualDuration을 잰다 — render-timing.mjs가
// 가짜 훅(onCommitFiberRoot)으로 commit 시간을 모은다(앱 코드에 <Profiler>를 넣지 않음).
//
//   npx vite build --config scripts/perf/vite.profiling.config.mjs
import path from 'node:path';
import { createRequire } from 'node:module';
import { mergeConfig } from 'vite';
import baseConfig from '../../vite.config.js';

const require = createRequire(import.meta.url);
const profiling = require.resolve('react-dom/profiling');

export default mergeConfig(baseConfig, {
  resolve: {
    // react-dom과 react-dom/client를 같은 모듈로 — 둘이 갈라지면 렌더러가 두 벌이 된다.
    alias: [
      { find: /^react-dom$/, replacement: profiling },
      { find: /^react-dom\/client$/, replacement: profiling },
    ],
  },
  build: {
    outDir: path.resolve('dist/perf-profiling'),
    emptyOutDir: true,
  },
});
