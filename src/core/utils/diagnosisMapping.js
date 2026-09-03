// PR0-B1: packages/analytics-core/diagnosisMapping.ts로 이동(클라이언트·서버 공유). 이
// 파일은 옛 import 경로를 유지하기 위한 shim이다.
//
// KNOWN BUG(별도 이슈로 분리, 이 PR에서 수정 금지): NAME_MODULE_MAP의 요추 패턴 끝에
// 빈 대안(|)이 있어 미매칭 상병이 요추로 잘못 분류될 수 있다 — 원본 위치
// (packages/analytics-core/diagnosisMapping.ts)에 상세 설명이 있다. 이 shim은 이동이
// 동작을 바꾸지 않았음을 characterization test로 고정한다
// (packages/analytics-core/__tests__/diagnosisMapping.test.ts).
export {
  getDiagnosisModuleHint,
  supportsKlGrade,
  supportsEllmanClass,
  MODULE_LABELS,
  isValidDiagnosisModuleId,
  resolveDiagnosisModule,
  suggestModules,
} from '@analytics-core/diagnosisMapping';
