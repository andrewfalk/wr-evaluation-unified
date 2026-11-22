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

// UI 라벨 매핑 — analytics-core로 이동하지 않음(통계 분석에 쓰이지 않는 순수 표시용).
export const getKlgText = (klg) =>
  klg === 'N/A' ? '해당없음' : klg ? `${klg}등급` : '-';

