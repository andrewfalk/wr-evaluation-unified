// PR0-B1: packages/analytics-core/workPeriod.ts로 이동(클라이언트·서버 공유). 이 파일은
// 옛 import 경로(전 모듈에서 상대경로로 직접 사용)를 유지하기 위한 shim이다.
export {
  calculateWorkPeriod,
  formatWorkPeriod,
  parseWorkPeriodOverride,
  getEffectiveWorkPeriod,
  getWorkPeriodYearMonth,
  getEffectiveWorkPeriodText,
} from '@analytics-core/workPeriod';
