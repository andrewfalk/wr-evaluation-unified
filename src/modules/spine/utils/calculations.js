// PR0-B2: 계산 함수는 packages/analytics-core/modules/spine으로 이관됐다(elbow/wrist/
// cervical 전례 그대로 — MDDM/WBV 두 엔진은 analytics-core 내부에서 mddm.ts/vibration.ts로
// 분리되어 있지만, 이 shim은 옛 import 경로(계산식 호출부)를 그대로 유지하기 위한
// re-export일 뿐이다). calculateAge/calculateBMI는 spine 원본에 애초에 없었다(연령/BMI를
// 계산하지 않는 모듈).
//
// src/의 원본 vibrationCalc.js/formulaDB.js/thresholds.js/formulaVersion.js/time.js는
// 그대로 잔류한다(UI 자세 이미지·export 코드가 직접 import) — analytics-core는 계산에
// 필요한 부분만 별도로 옮겨 적었다. 두 구현의 실제 출력 일치는 이관 시 golden
// characterization 테스트로 확인 후(전부 통과) 이 shim을 적용했다.
export {
  convertTimeToSeconds,
  classifySpineSeverity,
  computeSpineCalc,
  calculateCompressiveForce,
  calculateDailyDose,
  calculateLifetimeDose,
  getSpineTaskDoses,
  assessRisk,
  assessWorkRelatedness,
  isSpineAssessmentComplete,
  resolveMddmStatus,
} from '@analytics-core/modules/spine/index';
