// §5.3 coverage inventory — modules.knee 전체 필드. 출처: src/modules/knee/utils/data.js
// (createKneeModuleData/createKneeJobExtras/createJob 레거시) + metadata.ts의 dependsOn.
import type { CoverageInventory } from '../types';

const DEFERRED = 'PR0-B3 전체 카탈로그 확장 대상 — 현재 대표 변수(knee.relatedness.max)의 dependsOn에는 없음';
const FREE_TEXT = '자유 서술 텍스트 — 계산에 관여하지 않음';

export const KNEE_INVENTORY: CoverageInventory = {
  'modules.knee.returnConsiderations': { included: false, reason: FREE_TEXT },
  // 구형식 호환 배열(createJob, "BatchImportModal 마이그레이션 전까지"라고 주석에 명시된
  // 레거시 구조) — dependsOn이 'modules.knee.jobs[]'를 원소 필드 단위가 아니라 배열 전체
  // 참조로 나열하므로 여기서도 동일한 입도로 기록한다(개별 필드로 쪼개지 않음).
  'modules.knee.jobs[]': { included: true },

  'modules.knee.jobExtras[].sharedJobId': { included: true },
  'modules.knee.jobExtras[].weight': { included: true },
  'modules.knee.jobExtras[].squatting': { included: true },
  'modules.knee.jobExtras[].evidenceSources': { included: false, reason: '근거 출처 인용 태그 — 계산에 관여하지 않음' },
  'modules.knee.jobExtras[].stairs': { included: false, reason: DEFERRED },
  'modules.knee.jobExtras[].kneeTwist': { included: false, reason: DEFERRED },
  'modules.knee.jobExtras[].startStop': { included: false, reason: DEFERRED },
  'modules.knee.jobExtras[].tightSpace': { included: false, reason: DEFERRED },
  'modules.knee.jobExtras[].kneeContact': { included: false, reason: DEFERRED },
  'modules.knee.jobExtras[].jumpDown': { included: false, reason: DEFERRED },
};
