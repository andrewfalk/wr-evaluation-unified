// §5.3 coverage inventory — modules.cervical 전체 필드. 출처: src/modules/cervical/utils/data.js
// (createCervicalModuleData/createCervicalTask) + metadata.ts의 dependsOn.
import type { CoverageInventory } from '../types';

const FREE_TEXT = '자유 서술 텍스트 — 계산에 관여하지 않음';
// grain 단순화 개정(PR0-B4) — 이 필드로 행을 식별하던 cervical_task grain 자체가
// 소스코드까지 완전 삭제됐다. maxJobCumulativeKgHours(case grain, 살아남음) 계산은
// task의 내용(exposure_types/load_weight_kg 등)만 읽고 id는 읽지 않는다.
const GRAIN_DELETED = 'cervical_task grain 삭제(PR0-B4 grain 단순화)로 이 필드를 읽던 유일한 소비처가 사라짐';

export const CERVICAL_INVENTORY: CoverageInventory = {
  'modules.cervical.returnConsiderations': { included: false, reason: FREE_TEXT },
  'modules.cervical.tasks[].id': { included: false, reason: GRAIN_DELETED },
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
