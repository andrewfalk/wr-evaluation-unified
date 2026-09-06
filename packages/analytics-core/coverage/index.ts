// §5.3 coverage inventory — 전체 필드 인벤토리(6개 모듈 + shared)를 하나로 합친다.
// 실제 검증(모든 dependsOn이 여기 included로 반영됐는지 등)은 __tests__/coverage.test.ts.
import { mergeInventories, type CoverageInventory } from './types';
import { SHARED_INVENTORY } from './shared';
import { KNEE_INVENTORY } from './modules/knee';
import { SHOULDER_INVENTORY } from './modules/shoulder';
import { ELBOW_INVENTORY } from './modules/elbow';
import { WRIST_INVENTORY } from './modules/wrist';
import { CERVICAL_INVENTORY } from './modules/cervical';
import { SPINE_INVENTORY } from './modules/spine';

export type { CoverageEntry, CoverageInventory } from './types';

export const FULL_COVERAGE_INVENTORY: CoverageInventory = mergeInventories(
  SHARED_INVENTORY,
  KNEE_INVENTORY,
  SHOULDER_INVENTORY,
  ELBOW_INVENTORY,
  WRIST_INVENTORY,
  CERVICAL_INVENTORY,
  SPINE_INVENTORY,
);
