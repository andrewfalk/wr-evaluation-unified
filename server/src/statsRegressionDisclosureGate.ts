// PR4-A1 — 회귀 공개통제(③). 계획서(pr4-a-lexical-reddy.md) §2 "③ 공개통제" 참고.
// 하나라도 걸리면 즉시 {suppressed:true, reasonCode:'MIN_COHORT_NOT_MET'}로
// 종료하고, ④(설계행렬)·⑤(적합)로 절대 진행하지 않는다 — 레벨 수·파라미터 수·
// rank 같은 ④의 판정은 전부 데이터 특성을 드러내므로 ③을 통과하지 못한 요청엔
// 하나도 나가면 안 된다.
import { isSmallCell } from './statsSmallCell';
import { isGroupBreakdownDisclosable } from './statsBivariateDisclosureGate';
import type { RegressionEventSummary, RegressionLevelSummary } from './statsRegressionDataset';

export interface RegressionDisclosureInput {
  includedPersonCount: number;
  excludedPersonCount: number;
  levelSummaries: ReadonlyArray<RegressionLevelSummary>;
  eventSummary: RegressionEventSummary | null;
}

export interface RegressionDisclosureResult {
  disclose: boolean;
  reasonCode: 'MIN_COHORT_NOT_MET' | null;
}

/** 리뷰 #3 — 완전사례(포함)뿐 아니라 결측 제외(제외) person도 대칭 검사한다.
 * 100명 중 1명만 결측 제외인데 n=99와 제외 건수를 그대로 보이면 preview가
 * 감췄던 결측 정보가 되살아난다. `evaluateBivariateDisclosure`
 * (statsBivariateDisclosureGate.ts)와 동일한 원칙 재사용. */
export function evaluateRegressionDisclosure(input: RegressionDisclosureInput): RegressionDisclosureResult {
  const suppressed =
    isSmallCell(input.includedPersonCount) ||
    isSmallCell(input.excludedPersonCount) ||
    !isGroupBreakdownDisclosable(input.levelSummaries) ||
    (input.eventSummary !== null &&
      (isSmallCell(input.eventSummary.eventPersonCount) || isSmallCell(input.eventSummary.nonEventPersonCount)));

  return { disclose: !suppressed, reasonCode: suppressed ? 'MIN_COHORT_NOT_MET' : null };
}
