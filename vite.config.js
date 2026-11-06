import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { execSync } from 'child_process';

// PR0-A: 완료 보고(completionClientBuildVersion)에 쓰는 빌드 식별자. package.json 버전만으로는
// 같은 버전으로 여러 코드가 배포될 수 있어 부족 — server/src/workers/videoAnalysisWorker.ts의
// WR_GIT_COMMIT(Docker ARG→ENV) 선례와 동일한 env var를 먼저 본다. Docker web-builder 스테이지는
// .git이 복사되지 않으므로(.dockerignore) `git rev-parse`가 실패한다 — WR_GIT_COMMIT이 실제
// 소스다(export-offline-package.ps1이 --build-arg로 주입, Dockerfile web-builder 스테이지가
// ARG/ENV로 받는다). 로컬 `vite build`/`vite dev`처럼 그 env var가 없을 때만 git 명령으로 폴백한다.
function getGitCommit() {
  if (process.env.WR_GIT_COMMIT) return process.env.WR_GIT_COMMIT;
  try {
    return execSync('git rev-parse --short HEAD').toString().trim();
  } catch {
    return 'unknown';
  }
}

export default defineConfig({
  plugins: [react()],
  base: './',
  define: {
    __APP_GIT_COMMIT__: JSON.stringify(getGitCommit()),
  },
  resolve: {
    alias: {
      '@contracts': path.resolve('./shared/dist'),
      '@analytics-core': path.resolve('./packages/analytics-core/dist'),
    },
  },
  build: {
    outDir: 'dist/web',
    assetsDir: 'assets',
    sourcemap: false,
    minify: 'esbuild',
    // 브라우저 하한 = Chrome 108 (package.json browserslist와 같은 값, REFACTORING_ROADMAP D2/P0-5).
    // 현장 Win7 PC는 Chrome 109, 인트라넷 설치본(Electron 22 = Chromium 108)도 이 웹 빌드를
    // 그대로 로드한다 → 108. 하한을 올리려면 Electron 업그레이드가 먼저다.
    // target은 문법만 변환한다. 108에 없는 API·메서드는 eslint-plugin-compat(compat/compat)과
    // scripts/verify-browser-compat.mjs가 `npm run check`에서 막는다.
    target: ['chrome108'],
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom'],
          xlsx: ['xlsx'],
        },
      },
    },
  },
  server: {
    port: 3000,
    open: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      }
    }
  },
});
