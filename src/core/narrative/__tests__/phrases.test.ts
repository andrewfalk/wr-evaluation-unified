// 서술 문구 틀 채우기(P2-65a).
import { describe, expect, it } from 'vitest';
import { fillPhrase } from '../phrases';

describe('fillPhrase', () => {
  it('{이름} 자리를 값으로 채운다(숫자 포함)', () => {
    expect(fillPhrase('- 직력{n}: {name}\n', { n: 2, name: '용접공' })).toBe('- 직력2: 용접공\n');
  });

  it('채운 값 안의 {…}는 다시 바꾸지 않고, 값이 없는 자리는 그대로 둔다', () => {
    expect(fillPhrase('[{name}] {n}', { name: '{n}', n: 2 })).toBe('[{n}] 2');
    expect(fillPhrase('[{name}] {n}', { name: '{n}' })).toBe('[{n}] {n}');
    expect(fillPhrase('{a}{b}', { a: '' })).toBe('{b}');
  });
});
