// PR0-B1: 계산 함수 7개는 packages/analytics-core/modules/knee로 이동했다(클라이언트·서버
// 공유). 이 파일은 옛 import 경로를 유지하기 위한 shim이다 — registerModule() 호출부와
// JobTab.jsx 등 기존 소비자는 무변경.
export {
  calculatePhysicalBurden,
  calculateWorkRelatedness,
  evaluateCumulativeBurden,
  mergeJobsWithExtras,
  resolveKneeCalculationJobs,
  computeKneeCalc,
  isKneeAssessmentComplete,
} from '@wr/analytics-core/modules/knee/index';

