import { describe, expect, it } from 'vitest';
import { EMR_TEXT_LIMIT_BYTES, cp949ByteLength, truncateCp949Bytes } from '../emrText.js';

describe('cp949ByteLength: CP949 근사 바이트 계산', () => {
  it('빈 문자열/undefined는 0바이트', () => {
    expect(cp949ByteLength('')).toBe(0);
    expect(cp949ByteLength(undefined)).toBe(0);
  });

  it('ASCII 문자는 1바이트씩', () => {
    expect(cp949ByteLength('abc123')).toBe(6);
  });

  it('한글은 2바이트씩', () => {
    expect(cp949ByteLength('가나다')).toBe(6);
  });

  it('한글/ASCII 혼합', () => {
    expect(cp949ByteLength('상병 M17.0 무릎')).toBe(cp949ByteLength('상병 ') + cp949ByteLength('M17.0') + cp949ByteLength(' 무릎'));
    // '상병 M17.0 무릎' = 상(2)병(2) (1)M(1)1(1)7(1).(1)0(1) (1)무(2)릎(2) = 15
    expect(cp949ByteLength('상병 M17.0 무릎')).toBe(15);
  });
});

describe('truncateCp949Bytes: 3,950byte 경계와 절단', () => {
  it('한도 이하면 그대로 반환하고 truncated=false', () => {
    const text = '가'.repeat(1975); // 1975 * 2 = 3950
    const result = truncateCp949Bytes(text, EMR_TEXT_LIMIT_BYTES);
    expect(result).toEqual({ text, truncated: false });
  });

  it('한도를 1바이트라도 넘으면 절단하고 suffix를 붙인다', () => {
    const text = '가'.repeat(1976); // 3952 bytes, 한도(3950) 초과
    const result = truncateCp949Bytes(text, EMR_TEXT_LIMIT_BYTES);
    expect(result.truncated).toBe(true);
    expect(result.text.endsWith('...(이하 생략)')).toBe(true);
    expect(cp949ByteLength(result.text)).toBeLessThanOrEqual(EMR_TEXT_LIMIT_BYTES);
  });

  it('빈 문자열은 절단하지 않는다', () => {
    expect(truncateCp949Bytes('', EMR_TEXT_LIMIT_BYTES)).toEqual({ text: '', truncated: false });
  });

  it('커스텀 suffix를 쓸 수 있다', () => {
    const text = 'a'.repeat(20);
    const result = truncateCp949Bytes(text, 10, '…');
    expect(result.truncated).toBe(true);
    // suffix '…'(U+2026)는 2바이트 취급 → 남는 8바이트만큼 'a' 8개 + suffix
    expect(result.text).toBe('a'.repeat(8) + '…');
    expect(cp949ByteLength(result.text)).toBeLessThanOrEqual(10);
  });
});
