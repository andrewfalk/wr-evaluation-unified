import pkg from '../../../package.json';

// PR0-A: 완료 보고(patients.ts의 modulesCompleteObserved=true)에 함께 보내는 빌드 식별자.
// __APP_GIT_COMMIT__은 vite.config.js의 define으로 빌드 시점에 주입된다(WR_GIT_COMMIT
// 서버 선례와 대칭) — vitest 환경처럼 define이 없는 곳에서는 undefined이므로 폴백한다.
const gitCommit = typeof __APP_GIT_COMMIT__ !== 'undefined' ? __APP_GIT_COMMIT__ : 'unknown';

export const APP_BUILD_VERSION = `${pkg.version}+${gitCommit}`;

// 모듈 isComplete() 판정 로직의 의미가 바뀔 때만 수동으로 올린다. 앱 버전(package.json)과는
// 독립된 값 — patch 릴리스가 나가도 완료 판정 로직이 그대로면 이 값은 그대로 둔다.
// 2: 직력별 "신체부담평가 미포함"(excludeFromAnalysis) 반영으로 완료 판정 의미 변경(서버 COMPLETION_ENGINE_VERSION v2와 짝).
export const COMPLETION_SCHEMA_VERSION = 2;
