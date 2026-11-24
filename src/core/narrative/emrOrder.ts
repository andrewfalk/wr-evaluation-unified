// EMR b6·b8의 모듈 순서(Phase 2 C7-a P2-63). 서술(narrative)이 있는 등록 모듈을 narrative.emrOrder 순으로 —
// 등록 순서(src/modules/index.ts)·activeModules 순서와 무관하다. 소견서는 이 순서가 아니라 activeModules 순서를 쓴다.
// 같은 emrOrder가 둘이면 throw한다(순서가 등록 순서에 기대지 않도록 — 선례 src/core/export/batchColumns.ts).
import type { ModuleManifest, ModuleNarrative } from '../modules/manifest';
import { getAllModules } from '../modules/registry';

export type NarratedModule = ModuleManifest & { narrative: ModuleNarrative };

export function sortByEmrOrder(manifests: readonly ModuleManifest[]): NarratedModule[] {
  const narrated = manifests.filter((manifest): manifest is NarratedModule => Boolean(manifest.narrative));
  const seenOrders = new Map<number, string>();
  for (const manifest of narrated) {
    const other = seenOrders.get(manifest.narrative.emrOrder);
    if (other !== undefined) {
      throw new Error(`[narrative] emrOrder ${manifest.narrative.emrOrder}이 '${other}'와 '${manifest.id}'에 겹칩니다`);
    }
    seenOrders.set(manifest.narrative.emrOrder, manifest.id);
  }
  return narrated.sort((left, right) => left.narrative.emrOrder - right.narrative.emrOrder);
}

/** 지금 등록된 모듈 중 서술이 있는 것을 EMR 순서로. */
export function getEmrNarrativeModules(): NarratedModule[] {
  return sortByEmrOrder(getAllModules());
}
