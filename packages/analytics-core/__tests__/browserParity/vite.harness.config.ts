import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// harness 전용 최소 Vite 설정. root를 이 디렉터리로 잡아 harness.html이 여기 기준으로
// 열리게 하고, '@analytics-core'는 (vitest처럼 소스가 아니라) 빌드된 dist를 가리키게 해
// 실제 배포 산출물을 테스트한다(§9.1). 프로덕션 압축·해시 없이 dev 모드로만 쓴다 —
// window.__parity_* 전역으로 결과를 꺼내므로 압축 여부는 결과에 영향 없고, dev 모드를
// 쓰는 이유는 순전히 Playwright webServer 기동 속도 때문이다.
export default defineConfig({
  root: __dirname,
  resolve: {
    alias: {
      '@analytics-core': path.resolve(__dirname, '../../dist'),
    },
  },
  server: {
    port: 5183,
    strictPort: true,
  },
});
