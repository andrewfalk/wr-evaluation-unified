// PR0-B2: 계산 함수는 packages/analytics-core/modules/elbow로 이관됐다(shoulder/knee 전례
// 그대로). 이 파일은 옛 import 경로(계산식 호출부)를 그대로 유지하기 위한 re-export shim이다.
// calculateAge/calculateBMI는 원본 파일도 재export했지만 이 경로로 가져다 쓰는 소비자가
// 없었다(grep 확인) — shoulder 모듈과 동일한 이유로 뺐다.
//
// syncElbowModuleData(data.js)는 그대로 잔류한다 — analytics-core의 계산 함수는 그 함수를
// 재사용하지 않고 독립적으로 새로 작성한 정규화 로직(legacyNormalize.ts)을 쓴다. 원본
// syncElbowModuleData는 `_pendingPreset` 적용이 BK 대표값 자동복사 로직과 같은 루프에
// 인터리브되어 있어 리팩터링(공용 함수 추출) 자체가 회귀 위험이라 손대지 않았다 — 두 구현의
// 실제 출력 일치는 golden characterization 테스트(utils/__tests__/legacyParity.characterization
// .test.js)가 고정한다.
export {
  FLAG_META,
  getBk2101RepetitionPerHour,
  computeTemporalFlags,
  computeDiagnosisFlags,
  getElbowBurdenGrade,
  generateNarrative,
  formatCommonExposureTypeText,
  computeElbowCalc,
  isElbowAssessmentComplete,
  groupDiagnosesByBkType,
  groupSummariesByBkType,
  pickRepresentativeEntry,
  mergeBkGroupSummaries,
} from '@analytics-core/modules/elbow/index';

// UI 라벨 매핑 함수 — analytics-core로 이동하지 않음(UI 전용, 계산에 관여 안 함).
export const getSideText = (side) =>
  side === 'right' ? '우측' : side === 'left' ? '좌측' : side === 'both' ? '양측' : '-';

export const getStatusText = (status) =>
  status === 'confirmed' ? '확인' : status === 'unconfirmed' ? '미확인' : '-';

export const getReasonText = (reasons, other) => {
  if (typeof reasons === 'string') reasons = reasons ? [reasons] : [];
  if (!reasons || reasons.length === 0) return '-';

  const reasonMap = {
    unrelated: '업무 노출과 직접 연결되기 어려운 상병',
    unconfirmed: '병변 미확인',
    ageMild: '연령 대비 경미',
    mild: '병변 정도가 경미하거나 비특이적', // 레거시(구 데이터 표시용)
    delayed: '업무 중단 후 상당 기간 경과',
    lowBurden: '누적 노출이 낮음',
    belowThreshold: '노출 정도가 최소 문턱값을 넘지 못함',
    other: `기타 (${other || ''})`,
  };

  return reasons.map((reason) => reasonMap[reason] || reason).join('\n');
};
