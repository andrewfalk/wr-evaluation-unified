// 핵심 제약: packages/analytics-core는 브라우저 번들에도 들어가므로 Node 전용 API
// (node:crypto 등)를 쓸 수 없다. "types": []는 Node 전역 타입의 자동 노출을 줄일 뿐
// import 자체를 막는 장치는 아니므로(§8.2), 소스를 정적으로 스캔해 기계적으로 막는다.
// (ESLint no-restricted-imports 대신 이 방식을 채택한 이유: 루트 eslint.config.mjs에
// TypeScript 파서가 설정돼 있지 않아 새 devDependency 도입이 필요해 B1 범위에 비해 과함.)
//
// §9의 browser parity 테스트는 이 규칙이 뚫렸을 때의 최종 런타임 안전망이다.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '..');

function listTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '__tests__') continue;
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...listTsFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      results.push(full);
    }
  }
  return results;
}

const FORBIDDEN_PATTERNS = [
  /\bfrom\s+['"]node:/,
  /\brequire\(\s*['"]node:/,
  /\bfrom\s+['"](fs|crypto|path|os|child_process|net|http|https|worker_threads)['"]/,
  /\brequire\(\s*['"](fs|crypto|path|os|child_process|net|http|https|worker_threads)['"]\s*\)/,
];

describe('packages/analytics-core 핵심 소스에 Node 전용 API import가 없다', () => {
  const files = listTsFiles(packageRoot);

  it('스캔 대상 파일이 실제로 존재한다(테스트 자체의 오탐 방지)', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  for (const file of files) {
    const relative = path.relative(packageRoot, file);
    it(`${relative}에 Node 전용 import가 없다`, () => {
      const content = readFileSync(file, 'utf-8');
      for (const pattern of FORBIDDEN_PATTERNS) {
        expect(pattern.test(content), `${relative}가 금지 패턴 ${pattern}에 매치됩니다`).toBe(false);
      }
    });
  }
});
