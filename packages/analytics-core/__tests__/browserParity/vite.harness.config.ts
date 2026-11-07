import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// harness 전용 최소 Vite 설정. root를 이 디렉터리로 잡아 harness.html이 여기 기준으로
// 열리게 한다. '@wr/analytics-core'는 별칭 없이 npm workspaces 심링크 → 패키지 exports → 빌드된
// dist로 해석돼 실제 배포 산출물을 테스트한다(§9.1, P0-7 W4). 프로덕션 압축·해시 없이 dev 모드로만 쓴다 —
// window.__parity_* 전역으로 결과를 꺼내므로 압축 여부는 결과에 영향 없고, dev 모드를
// 쓰는 이유는 순전히 Playwright webServer 기동 속도 때문이다.
export default defineConfig({
  root: __dirname,
  server: {
    port: 5183,
    strictPort: true,
  },
});
