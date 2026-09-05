// PR0-B2: 기준값은 packages/analytics-core/modules/spine로 이관됐다(계산 단일 소스 원칙,
// §리뷰 지적 — 계산·상수가 src/analytics-core 두 곳에 남아 있으면 하나만 고쳤을 때 조용히
// 어긋난다). 이 파일은 옛 import 경로를 그대로 유지하기 위한 re-export shim이다.
export { thresholds, vibrationThresholds } from '@analytics-core/modules/spine/index';
