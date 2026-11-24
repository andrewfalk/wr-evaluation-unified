#!/usr/bin/env node
/**
 * scripts/narrative-diff.mjs — 서술 문구 차이 표를 Markdown으로(REFACTORING_ROADMAP Phase 2 C7-a P2-65b).
 *
 * 원본은 vitest가 얼린 JSON(src/core/narrative/__tests__/__goldens__/narrative-diff.json — src/core/narrative/diffTable.ts가
 * 등록된 모듈의 narrative.phrases에서 만든다). 노드에서 TS를 직접 돌리지 않으려고 JSON만 읽는다. 표를 새로 뽑으려면
 * 먼저 `npx vitest run src/core/narrative`(문구가 바뀌었으면 -u — 의도한 변경일 때만)로 JSON을 맞춘다.
 *
 *   node scripts/narrative-diff.mjs            # 변형 사이에 다른 행만
 *   node scripts/narrative-diff.mjs --all      # 모든 행(같은 행 포함)
 *   node scripts/narrative-diff.mjs --out <파일>
 *
 * 값은 JSON 문자열 표기로 보여 준다(줄바꿈 \n·앞뒤 공백이 보이게). 그 변형이 쓰지 않는 항목은 "—".
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const NARRATIVE_DIFF_JSON = path.join(root, 'src/core/narrative/__tests__/__goldens__/narrative-diff.json');

const VARIANT_LABELS = {
  report: '소견서(report)',
  emrSection: 'EMR 4번 칸 b6(emrSection)',
  emrSummary: 'EMR 6번 칸 b8(emrSummary)',
};

function cell(value) {
  if (value === undefined) return '—';
  return `\`${JSON.stringify(value).replace(/\|/g, '\\|')}\``;
}

/** 차이 표(JSON) → Markdown 표. all=false면 differs인 행만. 끝 칸 "정본"은 비워 둔다. */
export function renderNarrativeDiffMarkdown(table, { all = false } = {}) {
  const rows = all ? table.rows : table.rows.filter(row => row.differs);
  const header = ['#', '모듈', '항목', ...table.variants.map(v => VARIANT_LABELS[v] || v), ...(all ? ['차이'] : []), '정본'];
  const lines = [
    `| ${header.join(' | ')} |`,
    `|${header.map(() => '---').join('|')}|`,
  ];
  rows.forEach((row, index) => {
    lines.push(`| ${[
      String(index + 1),
      `${row.moduleName} (\`${row.moduleId}\`)`,
      `\`${row.item}\``,
      ...table.variants.map(v => cell(row.values[v])),
      ...(all ? [row.differs ? '다름' : '같음'] : []),
      '',
    ].join(' | ')} |`);
  });
  return `${lines.join('\n')}\n`;
}

function main(argv) {
  const all = argv.includes('--all');
  const outIndex = argv.indexOf('--out');
  const table = JSON.parse(fs.readFileSync(NARRATIVE_DIFF_JSON, 'utf8'));
  const markdown = renderNarrativeDiffMarkdown(table, { all });
  if (outIndex >= 0 && argv[outIndex + 1]) {
    fs.writeFileSync(argv[outIndex + 1], markdown);
    console.log(`narrative-diff: ${argv[outIndex + 1]}에 ${all ? '모든' : '차이 있는'} 행을 썼습니다.`);
  } else {
    process.stdout.write(markdown);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
