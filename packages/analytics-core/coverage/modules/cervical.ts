// §5.3 coverage inventory — modules.cervical 전체 필드. 출처: src/modules/cervical/utils/data.js
// (createCervicalModuleData/createCervicalTask) + metadata.ts의 dependsOn.
import type { CoverageInventory } from '../types';

const FREE_TEXT = '자유 서술 텍스트 — 계산에 관여하지 않음';
const TECHNICAL = '기술 ID — 계산값이 아니라 참조용';

export const CERVICAL_INVENTORY: CoverageInventory = {
  'modules.cervical.returnConsiderations': { included: false, reason: FREE_TEXT },
  'modules.cervical.tasks[].id': { included: false, reason: TECHNICAL },
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
