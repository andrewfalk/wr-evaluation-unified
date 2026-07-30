import { describe, expect, it } from 'vitest';
import { supportsKlGrade, supportsEllmanClass } from '../diagnosisMapping.js';

describe('supportsKlGrade: K-L Grade 입력 조건 (M170/M179 또는 무릎 관절증·골관절염)', () => {
  it('코드 M17.0 / M170 / m179(소문자) 는 true', () => {
    expect(supportsKlGrade({ code: 'M17.0', name: '' })).toBe(true);
    expect(supportsKlGrade({ code: 'M170', name: '' })).toBe(true);
    expect(supportsKlGrade({ code: 'm179', name: '' })).toBe(true);
  });

  it('코드 M17.5(원판형 반월판) 등 M170/M179 외 M17 하위코드는 false(코드만으로는)', () => {
    expect(supportsKlGrade({ code: 'M17.5', name: '' })).toBe(false);
  });

  it('상병명 "무릎 관절증" / "무릎골관절염"(붙여쓰기)은 코드 무관 true', () => {
    expect(supportsKlGrade({ code: '', name: '무릎 관절증' })).toBe(true);
    expect(supportsKlGrade({ code: '', name: '무릎골관절염' })).toBe(true);
    expect(supportsKlGrade({ code: 'M17.5', name: '무릎 골관절염, 편측' })).toBe(true);
  });

  it('무관한 코드·이름은 false', () => {
    expect(supportsKlGrade({ code: 'M22.4', name: '슬개골 연골연화증' })).toBe(false);
    expect(supportsKlGrade({ code: '', name: '' })).toBe(false);
  });
});

describe('supportsEllmanClass: Ellman Class 입력 조건 (M751 또는 회전근개 증후군·파열)', () => {
  it('코드 M75.1 / M751 은 true', () => {
    expect(supportsEllmanClass({ code: 'M75.1', name: '' })).toBe(true);
    expect(supportsEllmanClass({ code: 'M751', name: '' })).toBe(true);
  });

  it('코드 M75.0(유착성 관절낭염) 등 M751 외 M75 하위코드는 false(코드만으로는)', () => {
    expect(supportsEllmanClass({ code: 'M75.0', name: '' })).toBe(false);
  });

  it('상병명 "회전근개 증후군" / "회전근개 파열"은 코드 무관 true', () => {
    expect(supportsEllmanClass({ code: '', name: '회전근개 증후군' })).toBe(true);
    expect(supportsEllmanClass({ code: '', name: '회전근개 파열' })).toBe(true);
    expect(supportsEllmanClass({ code: 'M75.0', name: '회전근개파열' })).toBe(true);
  });

  it('무관한 코드·이름은 false', () => {
    expect(supportsEllmanClass({ code: 'M75.4', name: '어깨 충돌증후군' })).toBe(false);
    expect(supportsEllmanClass({ code: '', name: '' })).toBe(false);
  });
});
