// PR0-B2: 계산 함수는 packages/analytics-core/modules/cervical로 이관됐다(elbow/wrist
// 전례 그대로). 이 파일은 옛 import 경로(계산식 호출부)를 그대로 유지하기 위한 re-export
// shim이다. calculateAge/calculateBMI는 원본 파일도 재export했지만 이 경로로 가져다 쓰는
// 소비자가 없었다(grep 확인) — elbow/wrist/shoulder와 동일한 이유로 뺐다.
//
// syncCervicalModuleData(data.js)는 그대로 잔류한다 — analytics-core의 계산 함수는 그 함수를
// 재사용하지 않고 독립적으로 새로 작성한 정규화 로직(legacyNormalize.ts)을 쓴다. 두 구현의
// 실제 출력 일치는 이관 시 golden characterization 테스트로 확인 후(전부 통과) 이 shim을
// 적용했다(elbow/wrist와 동일 절차). cervical엔 UI 라벨 매핑 함수가 원래 없다(getSideText
// 등은 knee 모듈 것을 재사용 — src/core/utils/emrReport.js:6 참고) — 잔류시킬 함수 없음.
export {
  FLAG_META,
  computeCervicalCalc,
  isCervicalAssessmentComplete,
} from '@analytics-core/modules/cervical/index';
