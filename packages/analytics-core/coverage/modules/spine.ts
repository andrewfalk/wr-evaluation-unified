// §5.3 coverage inventory — modules.spine 전체 필드. 출처: src/modules/spine/utils/data.js
// (createSpineModuleData/createTask/createVibrationInterval) + metadata.ts의 두 대표 변수
// (spine.mddm.lifetimeDoseMNh, spine.vibration.dvMax) dependsOn.
import type { CoverageInventory } from '../types';

const FREE_TEXT = '자유 서술 텍스트 — 계산에 관여하지 않음';
const DERIVED_CACHE = '파생/캐시값 — 원시 입력이 아니라 계산 결과를 저장해두는 필드';

export const SPINE_INVENTORY: CoverageInventory = {
  'modules.spine.mddmStatus': { included: true },
  'modules.spine.vibrationExposureStatus': { included: true },
  // data.js 주석에 명시: "계산 분기가 아님" — 화면에서 어느 탭(MDDM/WBV)이 열려 있는지만 기록.
  'modules.spine.activeSpineTab': { included: false, reason: 'UI 전용 상태 — 화면 탭 선택만 기록, data.js 주석에 "계산 분기가 아님"으로 명시됨' },
  'modules.spine.aiAnalysisResult': { included: false, reason: DERIVED_CACHE + '(AI 분석 결과 캐시)' },
  'modules.spine.formulaVersion': { included: true },
  'modules.spine.returnConsiderations': { included: false, reason: FREE_TEXT },
  'modules.spine.evalMethod': { included: true },
  // 구형식 호환(레거시 career 필드) — hasLegacyFields 판정 자체가 이 필드들의 존재 여부로
  // 갈리므로(§리뷰 지적, mddm.ts) 값뿐 아니라 존재 여부도 결과에 영향을 준다.
  'modules.spine.careerYears': { included: true },
  'modules.spine.careerMonths': { included: true },
  'modules.spine.workDaysPerYear': { included: true },
  // knee.relatedness.max의 dependsOn에 있다 — 무릎 계산이 "무릎 job이 실은 구형식 척추
  // 직력이라 지원 안 됨"을 감지할 때 쓰는 legacy 필드(§5.2 unsupported_legacy_spine_jobs).
  // shared.jobs[].jobName과는 별개의 구형 단일 필드다.
  'modules.spine.jobName': { included: true },

  // PR0-B3 Part C-2 — spine.task.weightKg/frequencyPerDay(task grain)의 entityKey를
  // 구성하므로 더는 "계산에 안 쓰이는 기술 ID"가 아니다(vibrationIntervals[].id와 동일한
  // 사유 — task grain 자체가 이 필드로 행을 식별한다).
  'modules.spine.tasks[].id': { included: true },
  'modules.spine.tasks[].sharedJobId': { included: true },
  'modules.spine.tasks[].name': { included: false, reason: FREE_TEXT },
  'modules.spine.tasks[].posture': { included: true },
  'modules.spine.tasks[].weight': { included: true },
  'modules.spine.tasks[].frequency': { included: true },
  'modules.spine.tasks[].timeValue': { included: true },
  'modules.spine.tasks[].timeUnit': { included: true },
  'modules.spine.tasks[].correctionFactor': { included: true },
  // calculateCompressiveForce가 계산해 task 객체에 다시 써넣는 캐시값(derived.ts) — 원시
  // 입력이 아니라 계산 결과이므로 dependsOn 대상이 아니다(입력 필드들이 이미 나열돼 있음).
  'modules.spine.tasks[].force': { included: false, reason: DERIVED_CACHE },

  // PR0-B3 Part A — spine.vibration.intervalA8Max(vibration_interval grain)의 entityKey를
  // 구성하므로 더는 "계산에 안 쓰이는 기술 ID"가 아니다(vibration_interval grain 자체가
  // 이 필드로 행을 식별한다).
  'modules.spine.vibrationIntervals[].id': { included: true },
  'modules.spine.vibrationIntervals[].sharedJobId': { included: true },
  'modules.spine.vibrationIntervals[].name': { included: false, reason: FREE_TEXT },
  'modules.spine.vibrationIntervals[].awMin': { included: true },
  'modules.spine.vibrationIntervals[].awMax': { included: true },
  'modules.spine.vibrationIntervals[].timeValue': { included: true },
  'modules.spine.vibrationIntervals[].timeUnit': { included: true },
};
