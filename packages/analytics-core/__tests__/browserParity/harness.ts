// Browser parity harness(§9). 클라이언트가 실제로 쓰는 것과 같은 두 entry를 import한다 —
// 계산은 modules/knee/index, 마이그레이션은 migration/deterministicMigrate(독립 tsup entry,
// §7 — 클라이언트 shim엔 불필요하지만 이 harness가 마이그레이션 parity도 검증하려고 별도로
// import한다). '@analytics-core' alias는 이 파일 전용 vite.harness.config.ts가
// 빌드된 dist를 가리키게 설정한다(소스가 아니라 실제 산출물을 테스트해야 "번들 parity"가
// 증명된다).
import { computeKneeCalc, classifyKneeJob } from '@analytics-core/modules/knee/index';
import { deterministicMigrate } from '@analytics-core/migration/deterministicMigrate';

declare global {
  interface Window {
    __parity_computeKneeCalc: (fixtureJson: string) => string;
    __parity_migrate: (fixtureJson: string, optsJson: string) => string;
    __parity_classifyKneeJob: (jobJson: string) => string;
    __parity_timezone: () => string;
  }
}

window.__parity_computeKneeCalc = (fixtureJson: string) => {
  const fixture = JSON.parse(fixtureJson);
  return JSON.stringify(computeKneeCalc(fixture));
};

window.__parity_migrate = (fixtureJson: string, optsJson: string) => {
  const fixture = JSON.parse(fixtureJson);
  const opts = JSON.parse(optsJson);
  return JSON.stringify(deterministicMigrate(fixture, opts));
};

window.__parity_timezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

window.__parity_classifyKneeJob = (jobJson: string) => JSON.stringify(classifyKneeJob(JSON.parse(jobJson)));
