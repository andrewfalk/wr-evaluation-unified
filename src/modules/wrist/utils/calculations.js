// PR0-B2: 계산 함수는 packages/analytics-core/modules/wrist로 이관됐다(elbow 전례 그대로).
// 이 파일은 옛 import 경로(계산식 호출부)를 그대로 유지하기 위한 re-export shim이다.
// calculateAge/calculateBMI는 원본 파일도 재export했지만 이 경로로 가져다 쓰는 소비자가
// 없었다(grep 확인) — elbow/shoulder와 동일한 이유로 뺐다.
//
// syncWristModuleData(data.js)는 그대로 잔류한다 — analytics-core의 계산 함수는 그 함수를
// 재사용하지 않고 독립적으로 새로 작성한 정규화 로직(legacyNormalize.ts)을 쓴다. 원본
// syncWristModuleData는 `_pendingPreset` 적용이 BK 대표값 자동복사 로직과 같은 루프에
// 인터리브되어 있어 리팩터링(공용 함수 추출) 자체가 회귀 위험이라 손대지 않았다 — 두 구현의
// 실제 출력 일치는 이관 시 golden characterization 테스트로 확인 후(전부 통과) 이 shim을
// 적용했다(elbow와 동일 절차).
export {
  FLAG_META,
  getBk2101RepetitionPerHour,
  computeTemporalFlags,
  computeDiagnosisFlags,
  getWristBurdenGrade,
  formatCommonExposureTypeText,
  generateNarrative,
  computeWristCalc,
  isWristAssessmentComplete,
  groupDiagnosesByBkType,
  groupSummariesByBkType,
  pickRepresentativeEntry,
  mergeBkGroupSummaries,
} from '@wr/analytics-core/modules/wrist/index';

// UI 라벨 매핑 함수 — analytics-core로 이동하지 않음(UI 전용, 계산에 관여 안 함).
