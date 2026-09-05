// PR0-B2: 시간 단위 변환은 packages/analytics-core/modules/spine로 이관됐다(계산 단일
// 소스 원칙, §리뷰 지적). 이 파일은 옛 import 경로를 그대로 유지하기 위한 re-export shim이다.
export { convertTimeToSeconds } from '@analytics-core/modules/spine/index';
