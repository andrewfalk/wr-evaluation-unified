// §5.3 coverage inventory — modules.cervical 전체 필드. 출처: src/modules/cervical/utils/data.js
// (createCervicalModuleData/createCervicalTask) + metadata.ts의 dependsOn.
import type { CoverageInventory } from '../types';

const FREE_TEXT = '자유 서술 텍스트 — 계산에 관여하지 않음';

export const CERVICAL_INVENTORY: CoverageInventory = {
  'modules.cervical.returnConsiderations': { included: false, reason: FREE_TEXT },
  // PR0-B4 Slice 7 — cervical_task grain 엔터티 키(entityKey 구성용)로 9개 신규 변수의
  // dependsOn에 포함됐다(spine.tasks[].id와 동일 선례). 독립 카탈로그 키로는 등록하지
  // 않는다(매핑표 §5 "제외" 결정 — 기술 ID 자체는 분석 변수 가치가 없음).
  'modules.cervical.tasks[].id': { included: true },
  'modules.cervical.tasks[].sharedJobId': { included: true },
  'modules.cervical.tasks[].name': { included: true },
  'modules.cervical.tasks[].exposure_types': { included: true },
  'modules.cervical.tasks[].load_weight_kg': { included: true },
  'modules.cervical.tasks[].carry_hours_per_shift': { included: true },
  'modules.cervical.tasks[].forced_neck_posture': { included: true },
  'modules.cervical.tasks[].neck_nonneutral_hours_per_day': { included: true },
  'modules.cervical.tasks[].combined_flexion_rotation_posture': { included: true },
  'modules.cervical.tasks[].precision_work': { included: true },
  'modules.cervical.tasks[].notes': { included: false, reason: FREE_TEXT },
};
