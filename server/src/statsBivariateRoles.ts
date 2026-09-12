// PR3-A — statsMethodCatalog.ts(A-2 판정)와 statsBivariateSuppression.ts(B-처리+
// 실제 엔진 요청 조립) 둘 다 "어느 변수가 그룹/축인가"를 정확히 같은 규칙으로
// 판정해야 한다(계획서 § "A-2와 B가 동일 조건으로 수렴" — 여기서 갈리면 preview가
// 말한 것과 analyze가 실제로 하는 것이 달라진다). 그래서 이 판정 로직을 공유
// 파일로 뽑았다.
import type { AnalyticsVariableMetadata } from '@wr/analytics-core';
import { getOrdinalOrder, getCategoricalOrder } from './statsOrdinalOrder';

export function isContinuousType(type: AnalyticsVariableMetadata['type'] | undefined): boolean {
  return type === 'continuous';
}
export function isGroupingType(type: AnalyticsVariableMetadata['type'] | undefined): boolean {
  return type === 'boolean' || type === 'ordinal' || type === 'categorical';
}

// 관측값에서 결정적 순서를 만든다 — localeCompare는 로케일/ICU 버전에 따라 결과가
// 달라질 수 있어(로컬-Docker 간 digest 불일치 위험) 대신 코드유닛 기준 `<`/`>`을 쓴다
// (§3 "durableEntityKey" tie-break 등 이 코드베이스가 이미 쓰는 결정성 원칙과 동일).
function sortDeterministic(values: readonly string[]): string[] {
  return [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** boolean은 고정 [false, true], ordinal은 카탈로그 순서 상수 재사용. categorical은
 * 고정 순서가 선언돼 있으면(예: 신청상병 부위군) 그걸 쓰고, 없으면(담당의처럼 값
 * 집합이 조직 데이터마다 달라지는 변수) observedValues의 관측된 고유값을 결정적으로
 * 정렬해 순서를 동적으로 만든다 — 값 자체엔 의미 있는 순서가 없고 groupPairsByLevel()
 * 이 축 순서를 결정하는 데 필요한 "어떤 결정적 순서든" 하나면 충분하다. observedValues가
 * 없고 고정 순서도 없으면(호출자가 관측값을 못 구하는 경우) null.
 * (2026-09-12 리뷰 보완 — 이전 판은 categorical에 항상 null을 반환해 부위군·담당의의
 * 그룹비교·분할표 분석이 전부 METHOD_TYPE_MISMATCH로 막혀 있었다.) */
export function resolveLevelOrder(
  type: AnalyticsVariableMetadata['type'] | undefined,
  key: string,
  observedValues?: ReadonlyArray<string | boolean>,
): ReadonlyArray<string | boolean> | null {
  if (type === 'boolean') return [false, true];
  if (type === 'ordinal') return getOrdinalOrder(key);
  if (type === 'categorical') {
    const declared = getCategoricalOrder(key);
    if (declared) return declared;
    if (!observedValues) return null;
    const distinct = Array.from(new Set(observedValues.map((v) => String(v))));
    return sortDeterministic(distinct);
  }
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
