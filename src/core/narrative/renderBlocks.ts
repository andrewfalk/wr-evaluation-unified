// 서술 모듈 블록 조립(Phase 2 게이트 C P2-66a). 소견서(reportGenerator)와 EMR b6·b8(emrReport)이 같은 함수로 모듈 블록을
// 만든다 — 순서와 건너뛰는 규칙이 다시 갈라지지 않게(ADR 0001 표 B의 B1: 블록 순서 = 환자의 평가 부위 선택 순서
// activeModules). 등록되지 않았거나 computeCalc·narrative가 없는 모듈은 건너뛴다(B12). 계산은 computeCalc({ shared, module })로
// 부른다 — activeModules를 넘기지 않는다(넘기면 팔꿈치·손목·경추가 상병을 걸러 문구가 바뀔 수 있다).
// 레지스트리는 옛 shim(core/moduleRegistry.js)이 아니라 core/modules/registry에서 직접 읽는다 — shim을 mock하는 테스트에
// getModule이 없는 곳이 있다.
import type { ModuleManifest, ModuleNarrative, NarrativeContext, NarrativeVariant } from '../modules/manifest';
import { getModule } from '../modules/registry';

export type NarratedModule = ModuleManifest & { narrative: ModuleNarrative };

/** 서술이 있는 모듈인지. */
export function isNarratedModule(manifest: ModuleManifest | undefined): manifest is NarratedModule {
  return Boolean(manifest?.narrative);
}

/**
 * activeModules 순서로 각 모듈의 서술 블록을 이어 붙인다. 같은 id가 두 번 있으면 블록도 두 번 나온다(소견서의 기존 동작).
 */
export function renderNarrativeBlocks(
  variant: NarrativeVariant,
  shared: unknown,
  modules: Readonly<Record<string, unknown>>,
  activeModules: readonly string[],
  context: NarrativeContext,
): string {
  let text = '';
  for (const moduleId of activeModules) {
    const manifest = getModule(moduleId);
    if (!isNarratedModule(manifest) || typeof manifest.computeCalc !== 'function') continue;
    const calc = manifest.computeCalc({ shared, module: modules[moduleId] || {} });
    text += manifest.narrative.render(variant, calc, context);
  }
  return text;
}
