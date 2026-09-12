// PR0-B1: packages/analytics-core/diagnosisMapping.ts로 이동(클라이언트·서버 공유). 이
// 파일은 옛 import 경로를 유지하기 위한 shim이다.
//
// PR0-B3 Part C(2026-09-12): NAME_MODULE_MAP 요추 패턴 끝의 빈 대안(|) 버그를 원본 위치
// (packages/analytics-core/diagnosisMapping.ts)에서 수정했다 — 미매칭 상병명이 더 이상
// 요추로 잘못 분류되지 않는다. 이 화면(모듈 자동 제안)의 동작도 함께 바뀐다.
export {
  getDiagnosisModuleHint,
  supportsKlGrade,
  supportsEllmanClass,
  MODULE_LABELS,
  isValidDiagnosisModuleId,
  resolveDiagnosisModule,
  suggestModules,
} from '@analytics-core/diagnosisMapping';
