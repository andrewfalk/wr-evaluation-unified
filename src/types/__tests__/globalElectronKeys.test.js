// src/types/global.d.ts의 ElectronBridge 키가 G10 골든(두 preload 노출 키 합집합)과 같은지 — preload에 키가
// 더해지거나 빠졌는데 전역 선언을 안 고치면 타입검사가 없는 키를 허용하거나 있는 키를 오류로 낸다.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');

describe('ElectronBridge 전역 선언 ↔ preload 노출 표면(G10)', () => {
  it('키 집합이 같다', () => {
    const golden = JSON.parse(fs.readFileSync(path.join(ROOT, 'electron/__tests__/__goldens__/preload-surface.json'), 'utf8'));
    const exposed = new Set([
      ...golden.commonKeys,
      ...Object.keys(golden['preload-intranet.js']),
      ...Object.keys(golden['preload-standalone.js']),
    ]);
    const dts = fs.readFileSync(path.join(ROOT, 'src/types/global.d.ts'), 'utf8');
    const body = dts.slice(dts.indexOf('interface ElectronBridge {'), dts.indexOf('interface Window {'));
    const declared = new Set([...body.matchAll(/^\s+(\w+)\?:/gm)].map(m => m[1]));
    expect([...declared].sort()).toEqual([...exposed].sort());
  });
});
