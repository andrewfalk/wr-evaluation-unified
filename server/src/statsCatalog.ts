// PR0-B3 Part A — 통합 카탈로그 접근자. `getFullVariableCatalog()`(analytics-core 전용)를
// `statsRecipeValidation.ts`/`routes/stats.ts`가 직접 호출하던 것을 이 함수 하나로 정리한다.
// Part C — SNAPSHOT_COLUMN_VARIABLES(담당의·등록일, payload가 아니라 SnapshotRow에서 오는
// 변수)를 여기서 병합한다(계획 "통합 카탈로그" 절이 예고한 유일한 합류 지점).
// `statsDatasetBuilder.ts`는 이 함수를 호출하지 않는다 — 검증 단계(statsRecipeValidation.ts)가
// 만든 catalogByKey를 그대로 전달받는 기존 구조를 유지한다.
import { getFullVariableCatalog } from '@wr/analytics-core/catalog';
import type { AnalyticsVariableMetadata } from '@wr/analytics-core';
import { SNAPSHOT_COLUMN_VARIABLES } from './statsSnapshotColumnVariables';

export function getIntegratedCatalog(): AnalyticsVariableMetadata[] {
  const analyticsCoreCatalog = getFullVariableCatalog();
  const analyticsCoreKeys = new Set(analyticsCoreCatalog.map((v) => v.key));
  for (const v of SNAPSHOT_COLUMN_VARIABLES) {
    if (analyticsCoreKeys.has(v.key)) {
      throw new Error(`getIntegratedCatalog: 카탈로그 key 충돌 — "${v.key}"가 analytics-core와 SNAPSHOT_COLUMN_VARIABLES 양쪽에 있다`);
    }
  }
  return [...analyticsCoreCatalog, ...SNAPSHOT_COLUMN_VARIABLES];
}
