// 서술 문구 차이 표(P2-65b). 등록된 6개 모듈의 표를 골든으로 얼린다 — 모듈 서술의 문구가 바뀌거나 새 차이가 생기면
// 실패한다. 의도한 문구 변경(게이트 C, P2-66)만 `npx vitest run -u <이 파일>`로 갱신하고 PR에 diff와 이유를 적는다.
// 사람이 읽는 표: `node scripts/narrative-diff.mjs`(이 JSON → Markdown).
import { describe, expect, it } from 'vitest';
import '../../../modules';
import type { ModuleManifest } from '../../modules/manifest';
import { buildNarrativeDiffTable, getNarrativeDiffTable } from '../diffTable';

const fake = (id: string, phrases?: Record<string, Record<string, string>>) => ({
  id,
  name: `모듈 ${id}`,
  narrative: { render: () => '', ...(phrases ? { phrases } : {}) },
}) as unknown as ModuleManifest;

describe('서술 문구 차이 표', () => {
  it('등록된 모듈의 표(골든)', async () => {
    const table = getNarrativeDiffTable();
    expect(table.modules.map(m => m.id)).toEqual(['knee', 'cervical', 'shoulder', 'elbow', 'wrist']);
    expect(table.modulesWithoutPhrases).toEqual(['spine']);
    await expect(`${JSON.stringify(table, null, 2)}\n`).toMatchFileSnapshot('./__goldens__/narrative-diff.json');
  });

  it('값이 있는 변형 사이에 다른 값이 있을 때만 differs — 한 변형에만 있는 항목은 같은 것으로 본다. 모듈은 받은 순서', () => {
    const table = buildNarrativeDiffTable([
      fake('a', { diff: { report: '< A >', emrSection: '<A>' } }),
      fake('b', { same: { report: 'x', emrSection: 'x', emrSummary: 'x' }, only: { report: 'y' } }),
      fake('c'),
      { id: 'none', name: '서술 없음' } as unknown as ModuleManifest,
    ]);
    expect(table.modules.map(m => m.id)).toEqual(['a', 'b']);
    expect(table.modulesWithoutPhrases).toEqual(['c']);
    expect(table.rows.map(r => [r.moduleId, r.item, r.differs])).toEqual([
      ['a', 'diff', true],
      ['b', 'same', false],
      ['b', 'only', false],
    ]);
    expect(table.rows[0].values).toEqual({ report: '< A >', emrSection: '<A>' });
  });
});
