// §9.2: Node 프로세스의 타임존을 다른 어떤 import보다 먼저 설정한다. Windows(이 저장소의
// 기본 개발 환경)에서 `TZ=... playwright test`는 POSIX 셸 문법이라 그대로 안 돈다 —
// cross-env 같은 신규 의존성을 추가하지 않고, 순수 Node 코드로 설정해 OS 불문 동일하게
// 동작하게 한다. 브라우저 쪽 타임존은 knee.spec.ts의 test.use({ timezoneId: ... })로 별도
// 지정한다(Node·브라우저가 서로 다른 극단적 타임존이어야 §4.6의 타임존 버그를 실제로 검출할
// 수 있다 — 계획서 §9.2 참고).
process.env.TZ = 'Pacific/Kiritimati';

import { defineConfig } from 'playwright/test';

export default defineConfig({
  testDir: 'packages/analytics-core/__tests__/browserParity',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  webServer: {
    // npx는 cwd에서 상위 디렉터리로 올라가며 node_modules/.bin을 찾으므로 이 깊은
    // 경로에서도 루트에 설치된 vite를 정상적으로 찾는다.
    command: 'npx vite --config vite.harness.config.ts',
    cwd: 'packages/analytics-core/__tests__/browserParity',
    url: 'http://localhost:5183/harness.html',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  use: {
    baseURL: 'http://localhost:5183',
  },
});
