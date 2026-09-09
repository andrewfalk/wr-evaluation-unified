// PR0-C §C 원칙을 공유 유틸로 추출(PR1 계획 §참고할 기존 코드) — 소수 셀 억제는 사례 수가
// 아니라 그 셀에 기여한 고유 person 수로 판정한다. statsEstimability.ts와
// statsDescriptiveSuppression.ts(PR1) 양쪽이 이 함수 하나를 공유한다.
import { MINIMUM_COHORT } from './statsPolicy';

export function isSmallCell(personCount: number): boolean {
  return personCount > 0 && personCount < MINIMUM_COHORT;
}
