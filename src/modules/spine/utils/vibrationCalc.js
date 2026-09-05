// PR0-B2: 전신진동(BK2110) 계산 엔진은 packages/analytics-core/modules/spine/vibration.ts로
// 이관됐다(계산 단일 소스 원칙, §리뷰 지적 — 이 파일이 원본 그대로 남아 있으면 analytics-core
// 사본과 조용히 어긋날 수 있다). 이 파일은 옛 import 경로를 그대로 유지하기 위한 re-export
// shim이다. 두 구현의 실제 출력 일치는 기존 vibrationCalc.test.js(28개) + 신규
// derived.test.ts로 확인했다.
export {
  resolveVibrationStatus,
  isIntervalValid,
  intervalA8,
  combineA8,
  jobDV,
  computeVibrationCalc,
  assessVibrationRisk,
  isVibrationComplete,
} from '@analytics-core/modules/spine/index';
