// PR3-A — 통합 공개통제 게이트. 계획서 § "통합 공개통제 게이트" + v7 핵심수정
// ("개수 정보도 소수셀 검사를 통과해야 노출 가능하다") 참고.
//
// 레이어1(쌍 전체): 이 쌍 자체를 다뤄도 되는가 — includedPersonCount·
// excludedPersonCount 중 하나라도 소수셀이면 전체 억제(기존
// statsEstimability.ts:34-41의 완전/불완전사례 대칭억제 원칙을 그대로 확장).
//
// A-2 게이트(브레이크다운 청결도): 그룹 개수·표 크기·기대도수 같은 "데이터 의존
// 개수 정보"도 그 자체로 희소 레벨의 존재를 드러낼 수 있어(예: 99/1 vs 98/1/1이
// 관측 그룹 수로 구분되면 그 자체가 정보 유출), 관련된 모든 그룹/셀이 0 또는
// ≥MINIMUM_COHORT일 때만 계산·노출한다.
import { isSmallCell } from './statsSmallCell';
import { MINIMUM_COHORT } from './statsPolicy';

export interface BivariateDisclosureResult {
  disclose: boolean;
  reasonCode: 'MIN_COHORT_NOT_MET' | null;
}

// PairedDatasetResult 전체가 아니라 이 두 카운트만 구조적으로 요구한다 — 상관행렬
// (statsCorrelationMatrixDataset.ts)은 매 쌍마다 원시 행 배열(pairs)까지 담은
// PairedDatasetResult 전체를 만들 여유가 없어(C(k,2)개 전부 메모리에 유지) 카운트만
// 담은 경량 요약을 쓴다 — PairedDatasetResult도 이 필드들을 가지므로 기존 이변량
// 호출부는 그대로 통과한다(구조적 타이핑, 하위호환).
export interface BivariateDisclosureCounts {
  includedPersonCount: number;
  excludedPersonCount: number;
}

export function evaluateBivariateDisclosure(paired: BivariateDisclosureCounts): BivariateDisclosureResult {
  const suppressed = isSmallCell(paired.includedPersonCount) || isSmallCell(paired.excludedPersonCount);
  return { disclose: !suppressed, reasonCode: suppressed ? 'MIN_COHORT_NOT_MET' : null };
}

/** 그룹비교(welch_t/mann_whitney/anova/kruskal_wallis) — 관측된 "전부"(그 방법이
 * 최종적으로 쓰는 2개뿐 아니라 그 변수의 관측 레벨 전부)의 personCount가 0 또는
 * ≥MINIMUM_COHORT일 때만 REQUIRES_EXACTLY_TWO_GROUPS 등 구조적 사유를 노출한다. */
export function isGroupBreakdownDisclosable(groups: ReadonlyArray<{ personCount: number }>): boolean {
  return groups.every((g) => g.personCount === 0 || g.personCount >= MINIMUM_COHORT);
}

/** 분할표(chi_square/fisher_exact) — 모든 양수 셀이 ≥MINIMUM_COHORT일 때만
 * TABLE_NOT_2X2/LOW_EXPECTED_COUNT 등을 노출한다. 주변합이 아니라 개별 셀
 * 기준이다(8차 리뷰 정정 — [[1,19],[19,61]]처럼 주변합은 충분해도 셀 하나가
 * 작으면 false여야 한다). */
export function isTableDisclosable(table: ReadonlyArray<ReadonlyArray<number>>): boolean {
  return table.every((row) => row.every((cell) => cell === 0 || cell >= MINIMUM_COHORT));
}
