// 서술 문구 차이 표(Phase 2 C7-a P2-65b). 등록된 모듈의 narrative.phrases를 레지스트리에서 읽어(모듈 파일을 import하지
// 않는다) "모듈 × 항목 × 변형" 표를 만들고, 변형 사이에 값이 다른 행을 고른다. vitest가 결과를
// src/core/narrative/__tests__/__goldens__/narrative-diff.json으로 얼린다 — 새 차이가 생기면 테스트가 실패한다.
// 사람이 읽는 표는 scripts/narrative-diff.mjs가 그 JSON에서 만든다(docs/adr/0001-narrative-canonical-wording.md).
import { NARRATIVE_VARIANTS, type ModuleManifest, type NarrativeVariant } from '../modules/manifest';
import { getAllModules } from '../modules/registry';
import { sortByEmrOrder } from './emrOrder';

export interface NarrativePhraseRow {
  moduleId: string;
  moduleName: string;
  item: string;
  /** 변형별 문구 — 그 변형이 이 항목을 쓰지 않으면 키가 없다. */
  values: Partial<Record<NarrativeVariant, string>>;
  /** 값이 있는 변형 사이에 서로 다른 값이 있으면 true */
  differs: boolean;
}

export interface NarrativeDiffTable {
  variants: readonly NarrativeVariant[];
  /** phrases가 있는 모듈(EMR 순서) */
  modules: Array<{ id: string; name: string; emrOrder: number; items: number }>;
  /** phrases가 없는 서술 모듈 */
  modulesWithoutPhrases: string[];
  rows: NarrativePhraseRow[];
}

/** 모듈 목록 → 차이 표. 모듈은 EMR 순서, 항목은 각 모듈 phrases의 키 순서. */
export function buildNarrativeDiffTable(manifests: readonly ModuleManifest[]): NarrativeDiffTable {
  const narrated = sortByEmrOrder(manifests);
  const rows: NarrativePhraseRow[] = [];
  const modules: NarrativeDiffTable['modules'] = [];
  const modulesWithoutPhrases: string[] = [];
  for (const manifest of narrated) {
    const phrases = manifest.narrative.phrases;
    if (!phrases || Object.keys(phrases).length === 0) {
      modulesWithoutPhrases.push(manifest.id);
      continue;
    }
    modules.push({ id: manifest.id, name: manifest.name, emrOrder: manifest.narrative.emrOrder, items: Object.keys(phrases).length });
    for (const [item, byVariant] of Object.entries(phrases)) {
      const values: Partial<Record<NarrativeVariant, string>> = {};
      for (const variant of NARRATIVE_VARIANTS) {
        const value = byVariant[variant];
        if (value !== undefined) values[variant] = value;
      }
      rows.push({
        moduleId: manifest.id,
        moduleName: manifest.name,
        item,
        values,
        differs: new Set(Object.values(values)).size > 1,
      });
    }
  }
  return { variants: NARRATIVE_VARIANTS, modules, modulesWithoutPhrases, rows };
}

/** 지금 등록된 모듈의 차이 표. */
export function getNarrativeDiffTable(): NarrativeDiffTable {
  return buildNarrativeDiffTable(getAllModules());
}
