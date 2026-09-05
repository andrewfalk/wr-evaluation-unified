// PR0-B2: 공식 버전 식별자는 packages/analytics-core/modules/spine로 이관됐다(계산 단일
// 소스 원칙, §리뷰 지적). 이 파일은 옛 import 경로를 그대로 유지하기 위한 re-export shim이다.
export {
  SPINE_FORMULA_V513,
  SPINE_FORMULA_LEGACY,
  WBV_FORMULA_V1,
  WBV_FORMULA_LABEL,
  WBV_FORMULA_TITLE,
} from '@analytics-core/modules/spine/index';
