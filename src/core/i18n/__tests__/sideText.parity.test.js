// 측 텍스트 8벌 parity(P2-51 첫 커밋, Phase 2 C6) — 옮기기 전에 8벌이 같은 표를 내는지 고정한다.
// export된 4벌은 입력 표로 직접 부르고, 컴포넌트 안 지역 함수 4벌(export되지 않음)은 소스의 식이 export된 것과
// 글자까지 같은지 본다(같은 식 = 같은 출력).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getSideText as knee } from '../../../modules/knee/utils/calculations';
import { getSideText as shoulder } from '../../../modules/shoulder/utils/calculations';
import { getSideText as elbow } from '../../../modules/elbow/utils/calculations';
import { getSideText as wrist } from '../../../modules/wrist/utils/calculations';

const TABLE = [
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

const EXPRESSION = "side === 'right' ? '우측' : side === 'left' ? '좌측' : side === 'both' ? '양측' : '-'";
const LOCAL_COPIES = [
  'src/modules/elbow/components/ExposureForm.jsx',
  'src/modules/elbow/components/ElbowResultPanel.jsx',
  'src/modules/wrist/components/ExposureForm.jsx',
  'src/modules/wrist/components/WristResultPanel.jsx',
];

describe('측 텍스트 8벌 parity', () => {
  it.each([['knee', knee], ['shoulder', shoulder], ['elbow', elbow], ['wrist', wrist]])('%s getSideText', (_name, fn) => {
    expect(TABLE.map(([side]) => fn(side))).toEqual(TABLE.map(([, text]) => text));
  });

  it.each(LOCAL_COPIES)('%s의 지역 getSideLabel은 같은 식이다', (file) => {
    const source = readFileSync(path.resolve(file), 'utf8');
    const body = source.match(/function getSideLabel\(side\) \{\s*return ([^;]+);\s*\}/);
    expect(body?.[1]).toBe(EXPRESSION);
  });

  it('export된 4벌도 같은 식이다', () => {
    for (const mod of ['knee', 'shoulder', 'elbow', 'wrist']) {
      const source = readFileSync(path.resolve(`src/modules/${mod}/utils/calculations.js`), 'utf8');
      const body = source.match(/export const getSideText = \(side\) =>\s*([^;]+);/);
      expect(body?.[1], mod).toBe(EXPRESSION);
    }
  });
});
