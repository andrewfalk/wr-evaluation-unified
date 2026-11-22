// 측 텍스트(P2-51, Phase 2 C6) — 옛 복제 8벌을 모은 getSideText가 옛 parity 표(첫 커밋의 sideText.parity.test.js)와 같은 값을 내고,
// 모듈 쪽에 같은 식의 복제가 다시 생기지 않았는지 본다.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getSideText } from '../sideLabels';

const TABLE: Array<[unknown, string]> = [
  ['right', '우측'],
  ['left', '좌측'],
  ['both', '양측'],
  ['', '-'],
  [undefined, '-'],
  [null, '-'],
  ['Right', '-'],
  ['bilateral', '-'],
  [0, '-'],
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

describe('getSideText', () => {
  it('옛 8벌과 같은 표', () => {
    expect(TABLE.map(([side]) => getSideText(side))).toEqual(TABLE.map(([, text]) => text));
  });

  it('src/modules에 같은 식의 복제가 없다', () => {
    const copies = walk(path.resolve('src/modules'))
      .filter(file => /\.(jsx?|tsx?)$/.test(file))
      .filter(file => readFileSync(file, 'utf8').includes("side === 'both' ? '양측' : '-'"));
    expect(copies).toEqual([]);
  });
});
