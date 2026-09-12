#!/usr/bin/env node
/**
 * scripts/verify-chart-compat.mjs
 *
 * PR3-B 계획서 §6.8.6/§5.4 — 인트라넷 배포는 윈도7 + Chrome 109 상한을 지원해야
 * 한다. 지금까지는 파일 상단 주석 관례(예: statistics-workbench.css:3)로만
 * 지켜지고 있었는데, 차트 프리미티브(신규 코드 표면)가 커져서 정적 검사로
 * 자동화한다 — verify-csp.mjs(실행 중인 서버 대상 런타임 검사)와 달리 이건
 * 소스 파일을 정적으로 grep하는 빌드 전 검사다.
 *
 * 검사 대상: src/core/components/charts/**\/*.{js,jsx,css}
 * 금지 토큰: color-mix(), :has(), new ResizeObserver, Intl.NumberFormat(<옵션객체>),
 *            structuredClone(), Object.hasOwn(), Array.prototype.at(
 *
 * Usage: node scripts/verify-chart-compat.mjs
 * Exit codes: 0 = 통과, 1 = 위반 발견.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TARGET_DIR = path.join(__dirname, '..', 'src', 'core', 'components', 'charts');
const TARGET_EXTENSIONS = new Set(['.js', '.jsx', '.css']);

// [정규식, 설명] — Intl.NumberFormat 자체는 허용(옵션 없이 호출은 구형 크롬도
// 지원)하되 옵션 객체가 붙는 호출만 금지한다(계획서 §6.8.6 "옵션 객체" 명시).
const FORBIDDEN_PATTERNS = [
  [/color-mix\(/, 'color-mix() — Chrome 111+(윈도7 상한 Chrome 109 초과)'],
  [/:has\(/, ':has() — Chrome 105+는 되지만 여유 없음, 클래스 토글로 대체 권장'],
  [/new\s+ResizeObserver/, 'ResizeObserver — useViewportWidth.js처럼 resize 이벤트로 대체'],
  [/Intl\.NumberFormat\s*\([^)]*,/, 'Intl.NumberFormat(옵션 객체) — toFixed()/toLocaleString()(옵션 없이)만 사용'],
  [/structuredClone\(/, 'structuredClone() — 구형 크롬 미지원'],
  [/Object\.hasOwn\(/, 'Object.hasOwn() — 구형 크롬 미지원'],
  [/\.at\(-?\d+\)/, 'Array.prototype.at() — 구형 크롬 미지원(인덱스 계산으로 대체)'],
];

// 주석 안에서 "color-mix() 금지"처럼 금지 대상을 설명하는 문장까지 위반으로
// 오탐하지 않도록, 검사 전에 블록/라인 주석을 공백으로 치환한다(코드만 검사).
function stripComments(content) {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')) // /* ... */(여러 줄 보존)
    .replace(/\/\/.*$/gm, ''); // // ...
}

function collectFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      out.push(...collectFiles(full));
    } else if (TARGET_EXTENSIONS.has(path.extname(entry))) {
      out.push(full);
    }
  }
  return out;
}

function main() {
  const files = collectFiles(TARGET_DIR);
  const violations = [];

  for (const file of files) {
    const content = stripComments(readFileSync(file, 'utf8'));
    const lines = content.split('\n');
    for (const [pattern, reason] of FORBIDDEN_PATTERNS) {
      lines.forEach((line, i) => {
        if (pattern.test(line)) {
          violations.push({ file: path.relative(process.cwd(), file), line: i + 1, reason, text: line.trim() });
        }
      });
    }
  }

  if (violations.length > 0) {
    console.error(`\n윈도7/Chrome 109 호환성 위반 ${violations.length}건 발견:\n`);
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line} — ${v.reason}`);
      console.error(`    ${v.text}`);
    }
    console.error('\n계획서 §6.8.6 구현 제약을 확인하세요.');
    process.exit(1);
  }

  console.log(`verify-chart-compat: ${files.length}개 파일 검사 완료, 위반 없음.`);
  process.exit(0);
}

main();
