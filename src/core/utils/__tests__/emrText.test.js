import { describe, expect, it } from 'vitest';
import { EMR_TEXT_LIMIT_BYTES, cp949ByteLength, truncateCp949Bytes, classifyEmrByteStatus } from '../emrText.js';

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

describe('classifyEmrByteStatus: 게이지 상태 판정 (반올림이 아닌 실제 byte 비교)', () => {
  it('90% 미만이면 정상', () => {
    expect(classifyEmrByteStatus(3000, EMR_TEXT_LIMIT_BYTES)).toBe('ok'); // 75.9%
  });

  it('90% 이상 ~ 한도 이하면 주의', () => {
    expect(classifyEmrByteStatus(3555, EMR_TEXT_LIMIT_BYTES)).toBe('warn'); // 90.0%
    expect(classifyEmrByteStatus(EMR_TEXT_LIMIT_BYTES, EMR_TEXT_LIMIT_BYTES)).toBe('warn'); // 정확히 한도(100%, 아직 초과 아님)
  });

  it('한도를 1byte라도 넘으면 반올림 결과와 무관하게 초과로 판정한다', () => {
    // 3951/3950 = 100.0253...% → Math.round()면 100%라 예전 로직은 "주의"로 오판했다.
    expect(classifyEmrByteStatus(EMR_TEXT_LIMIT_BYTES + 1, EMR_TEXT_LIMIT_BYTES)).toBe('danger');
  });

  it('큰 폭으로 초과해도 초과로 판정한다', () => {
    expect(classifyEmrByteStatus(5000, EMR_TEXT_LIMIT_BYTES)).toBe('danger');
  });
});
