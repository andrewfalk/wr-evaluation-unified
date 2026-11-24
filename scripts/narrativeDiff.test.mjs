// scripts/narrative-diff.mjs — 서술 문구 차이 표 JSON → Markdown(P2-65b).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { NARRATIVE_DIFF_JSON, renderNarrativeDiffMarkdown } from './narrative-diff.mjs';

const table = {
  variants: ['report', 'emrSection', 'emrSummary'],
  rows: [
    { moduleId: 'knee', moduleName: '무릎', item: 'heading', values: { report: '\n  < 무릎 >\n', emrSection: '\n<무릎>\n' }, differs: true },
    { moduleId: 'knee', moduleName: '무릎', item: 'same', values: { report: 'a|b', emrSection: 'a|b' }, differs: false },
  ],
};

describe('renderNarrativeDiffMarkdown', () => {
  it('차이 있는 행만, 값은 JSON 문자열 표기(줄바꿈·공백이 보이게), 없는 변형은 —, 정본 칸은 빈칸', () => {
    const md = renderNarrativeDiffMarkdown(table);
    const lines = md.trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('| 1 | 무릎 (`knee`) | `heading` | `"\\n  < 무릎 >\\n"` | `"\\n<무릎>\\n"` | — |  |');
  });

  it('--all은 같은 행도 넣고 차이 칸을 더한다(| 는 이스케이프)', () => {
    const lines = renderNarrativeDiffMarkdown(table, { all: true }).trim().split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe('| 2 | 무릎 (`knee`) | `same` | `"a\\|b"` | `"a\\|b"` | — | 같음 |  |');
  });

  it('저장소의 표(JSON)를 읽어 변환할 수 있다', () => {
    const real = JSON.parse(fs.readFileSync(NARRATIVE_DIFF_JSON, 'utf8'));
    const md = renderNarrativeDiffMarkdown(real);
    expect(md.trim().split('\n').length).toBe(2 + real.rows.filter(r => r.differs).length);
  });
});
