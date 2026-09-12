// PR0-B3 Part C — 통합 카탈로그 버전 규칙(계획 pr0-b3-shimmying-magpie.md "통합 카탈로그"
// 절, "확인 필요" 3번). analytics-core의 CATALOG_VERSION은 payload 기반 변수(대다수)만
// 커버한다 — server 전용 SNAPSHOT_COLUMN_VARIABLES(담당의·등록일, statsSnapshotColumnVariables.ts)
// 는 analytics-core 밖에서 관리되는 별도 로직이라 자체 버전이 필요하다. 두 값을 합성한
// 문자열을 GET /catalog·statsRunManifest.ts·statsExecutionDigest.ts 세 곳 모두에 함께
// 쓴다 — 하나만 바꾸면 provenance 표시는 바뀌어도 execution digest(idempotency 캐시 키)는
// 그대로라, 서버 전용 로직만 고쳤을 때 옛 카탈로그 기준 캐시 결과가 재사용되는 버그가 생긴다
// (statsExecutionDigest.test.ts의 "서버 확장 버전만 바꿔도 digest가 달라진다" 테스트가
// 이 계약을 실측한다).
import { CATALOG_VERSION } from '@wr/analytics-core/catalog';

// SNAPSHOT_COLUMN_VARIABLES 자체나 extractSnapshotColumnValue의 값 추출 로직이 바뀌면
// 이 값을 올린다(analytics-core 카탈로그와 독립적인 변경 이력).
export const SERVER_CATALOG_EXTENSION_VERSION = 'v1-snapshot-columns';

export const INTEGRATED_CATALOG_VERSION = `${CATALOG_VERSION}+${SERVER_CATALOG_EXTENSION_VERSION}`;
