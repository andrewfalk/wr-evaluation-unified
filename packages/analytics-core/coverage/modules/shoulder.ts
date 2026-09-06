// §5.3 coverage inventory — modules.shoulder 전체 필드. 출처: src/modules/shoulder/utils/data.js
// (createShoulderModuleData/createShoulderJobExtras) + metadata.ts의 dependsOn.
import type { CoverageInventory } from '../types';

const FREE_TEXT = '자유 서술 텍스트 — 계산에 관여하지 않음';

export const SHOULDER_INVENTORY: CoverageInventory = {
  'modules.shoulder.returnConsiderations': { included: false, reason: FREE_TEXT },
  'modules.shoulder.jobExtras[].sharedJobId': { included: true },
  'modules.shoulder.jobExtras[].overheadHours': { included: true },
  'modules.shoulder.jobExtras[].repetitiveMediumHours': { included: true },
  'modules.shoulder.jobExtras[].repetitiveFastHours': { included: true },
  'modules.shoulder.jobExtras[].heavyLoadCount': { included: true },
  'modules.shoulder.jobExtras[].heavyLoadSeconds': { included: true },
  'modules.shoulder.jobExtras[].vibrationHours': { included: true },
  'modules.shoulder.jobExtras[].evidenceSources': { included: false, reason: '근거 출처 인용 태그 — 계산에 관여하지 않음' },
};
