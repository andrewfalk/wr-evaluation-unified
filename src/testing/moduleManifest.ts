// 테스트용 모듈 매니페스트(P2-50, Phase 2 C5) — 레지스트리가 매니페스트를 검사해 문제가 있으면 throw하므로,
// 가짜 모듈을 등록하는 테스트는 필수 키를 이 헬퍼로 채운다. 테스트가 관심 있는 키만 overrides로 넘긴다.
import type { PresetConfig } from '../core/modules/manifest';

export function makeTestManifest<T extends Record<string, unknown>>(overrides: T & { id: string }) {
  return {
    name: overrides.id,
    icon: '',
    description: '',
    EvaluationComponent: () => null,
    createModuleData: () => ({}),
    computeCalc: () => ({}),
    isComplete: () => false,
    tabs: [{ id: 'main', label: overrides.id }],
    ...overrides,
  };
}

/** presetConfig의 필수 하위 키를 채운다(라벨·필드·추출·적용). */
export function makeTestPresetConfig(overrides: Partial<PresetConfig> = {}): PresetConfig {
  return {
    label: '테스트 프리셋',
    fields: [],
    extractFromModule: () => null,
    applyToModule: (moduleData: unknown) => moduleData,
    ...overrides,
  };
}
