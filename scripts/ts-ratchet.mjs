// 클라이언트 타입검사 ratchet (REFACTORING_ROADMAP P0-6).
//
// src/ 안에서 맨 위 주석에 `// @ts-nocheck`가 있는 파일 목록이 scripts/ts-nocheck-baseline.json과 같아야 한다.
//   - 목록에 없는 파일에 @ts-nocheck가 생기면 실패 — 새 코드·수정한 파일은 타입 오류를 고친다(D3·C11).
//   - 목록에 있는데 이제 @ts-nocheck가 없는 파일이 있으면 실패 — 목록에서 지운다(`--prune`).
// ESLint suppressions prune과 같은 원칙: 목록은 줄기만 한다. `--prune`은 항목을 지우기만 하고 더하지 않는다.
//
//   node scripts/ts-ratchet.mjs           # 검사 (npm run check의 한 단계)
//   node scripts/ts-ratchet.mjs --prune   # 더는 nocheck가 아닌 파일을 목록에서 지움
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = path.join(ROOT, 'scripts', 'ts-nocheck-baseline.json');
const SOURCE_EXT = /\.(?:js|jsx|ts|tsx|mjs|cjs)$/;

/**
 * 파일 맨 앞의 주석 영역(빈 줄·`//`·블록 주석)에 `@ts-nocheck`가 있는가. TypeScript도 코드보다 앞의 주석에
 * 있을 때만 이 지시문을 따른다 — 코드 뒤에 쓴 @ts-nocheck는 효과가 없으므로 세지 않는다.
 */
export function hasLeadingNocheck(text) {
  let rest = text.replace(/^﻿/, '');
  for (;;) {
    rest = rest.replace(/^\s+/, '');
    if (rest.startsWith('//')) {
      const end = rest.indexOf('\n');
      const line = end === -1 ? rest : rest.slice(0, end);
      // `/// @ts-nocheck`(세 슬래시)도 TypeScript가 지시문으로 따른다.
      if (/^\/\/\/?\s*@ts-nocheck\b/.test(line)) return true;
      if (end === -1) return false;
      rest = rest.slice(end + 1);
    } else if (rest.startsWith('/*')) {
      const end = rest.indexOf('*/');
      if (end === -1) return false;
      if (/@ts-nocheck\b/.test(rest.slice(0, end))) return true;
      rest = rest.slice(end + 2);
    } else {
      return false;
    }
  }
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (SOURCE_EXT.test(entry.name)) out.push(full);
  }
  return out;
}

/** src/ 아래 @ts-nocheck 파일(저장소 기준 상대 경로, `/` 구분, 정렬). */
export function findNocheckFiles(root = ROOT) {
  return walk(path.join(root, 'src'))
    .filter(file => hasLeadingNocheck(fs.readFileSync(file, 'utf8')))
    .map(file => path.relative(root, file).split(path.sep).join('/'))
    .sort();
}

export function compareToBaseline(found, baseline) {
  const b = new Set(baseline);
  const f = new Set(found);
  return {
    added: found.filter(x => !b.has(x)),
    removed: baseline.filter(x => !f.has(x)),
  };
}

function main() {
  const prune = process.argv.includes('--prune');
  const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  const found = findNocheckFiles();
  const { added, removed } = compareToBaseline(found, baseline);

  if (prune) {
    if (removed.length === 0) { console.log('ts-ratchet: 지울 항목 없음'); }
    else {
      const next = baseline.filter(x => !removed.includes(x));
      fs.writeFileSync(BASELINE, `${JSON.stringify(next, null, 2)}\n`);
      console.log(`ts-ratchet: 목록에서 ${removed.length}개 삭제 → ${next.length}개`);
    }
    if (added.length > 0) {
      console.error(`ts-ratchet: 목록에 없는 @ts-nocheck ${added.length}개는 --prune으로 추가되지 않습니다:\n${added.map(x => `  - ${x}`).join('\n')}`);
      process.exit(1);
    }
    return;
  }

  let ok = true;
  if (added.length > 0) {
    ok = false;
    console.error(`ts-ratchet: 새 @ts-nocheck ${added.length}개 — 타입 오류를 고치고 지시문을 지우세요(목록은 늘리지 않습니다):\n${added.map(x => `  - ${x}`).join('\n')}`);
  }
  if (removed.length > 0) {
    ok = false;
    console.error(`ts-ratchet: 이제 @ts-nocheck가 없는 파일 ${removed.length}개 — node scripts/ts-ratchet.mjs --prune 으로 목록에서 지우세요:\n${removed.map(x => `  - ${x}`).join('\n')}`);
  }
  if (!ok) process.exit(1);
  console.log(`ts-ratchet: OK (@ts-nocheck ${found.length}개 = 기준 목록)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
