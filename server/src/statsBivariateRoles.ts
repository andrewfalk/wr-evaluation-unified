// PR3-A — statsMethodCatalog.ts(A-2 판정)와 statsBivariateSuppression.ts(B-처리+
// 실제 엔진 요청 조립) 둘 다 "어느 변수가 그룹/축인가"를 정확히 같은 규칙으로
// 판정해야 한다(계획서 § "A-2와 B가 동일 조건으로 수렴" — 여기서 갈리면 preview가
// 말한 것과 analyze가 실제로 하는 것이 달라진다). 그래서 이 판정 로직을 공유
// 파일로 뽑았다.
import type { AnalyticsVariableMetadata } from '@wr/analytics-core';
import { getOrdinalOrder } from './statsOrdinalOrder';

export function isContinuousType(type: AnalyticsVariableMetadata['type'] | undefined): boolean {
  return type === 'continuous';
}
export function isGroupingType(type: AnalyticsVariableMetadata['type'] | undefined): boolean {
  return type === 'boolean' || type === 'ordinal' || type === 'categorical';
}

/** boolean은 고정 [false, true], ordinal은 카탈로그 순서 상수 재사용. categorical은
 * 현재 카탈로그에 0건이라 순서 미정의 — null(호출자가 METHOD_TYPE_MISMATCH로 방어). */
export function resolveLevelOrder(
  type: AnalyticsVariableMetadata['type'] | undefined,
  key: string,
): ReadonlyArray<string | boolean> | null {
  if (type === 'boolean') return [false, true];
  if (type === 'ordinal') return getOrdinalOrder(key);
  return null;
}

export interface GroupComparisonRoles {
  groupRoleKey: 'x' | 'y';
  groupType: AnalyticsVariableMetadata['type'];
  groupKey: string;
}

/** welch_t/mann_whitney/anova/kruskal_wallis — 역할은 타입으로 결정한다(x/y 선택
 * 순서가 아니라 타입이 그룹을 정한다, 계획서 §방향규칙). 연속형이 아닌 쪽이 그룹,
 * 그 반대가 결과값. 타입 조합이 안 맞으면 null(METHOD_TYPE_MISMATCH). */
export function resolveGroupComparisonRoles(
  typeX: AnalyticsVariableMetadata['type'] | undefined,
  typeY: AnalyticsVariableMetadata['type'] | undefined,
  keyX: string,
  keyY: string,
): GroupComparisonRoles | null {
  if (isGroupingType(typeX) && isContinuousType(typeY)) {
    return { groupRoleKey: 'x', groupType: typeX!, groupKey: keyX };
  }
  if (isGroupingType(typeY) && isContinuousType(typeX)) {
    return { groupRoleKey: 'y', groupType: typeY!, groupKey: keyY };
  }
  return null;
}
