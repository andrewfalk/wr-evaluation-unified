import { describe, expect, it } from 'vitest';
import { supportsKlGrade, supportsEllmanClass } from '../diagnosisMapping.js';

describe('supportsKlGrade: K-L Grade 입력 조건 (M17 전체 또는 무릎·슬관절 관절증/관절염)', () => {
  it('코드 M17.0 / M170 / m179(소문자) 는 true', () => {
    expect(supportsKlGrade({ code: 'M17.0', name: '' })).toBe(true);
    expect(supportsKlGrade({ code: 'M170', name: '' })).toBe(true);
    expect(supportsKlGrade({ code: 'm179', name: '' })).toBe(true);
  });

  it('M17 하위코드는 전부 무릎관절증이므로 M17.1~M17.5도 코드만으로 true', () => {
    // M17.1 기타 원발성 / M17.2 외상후 양쪽 / M17.3 기타 외상후 /
    // M17.4 기타 이차성 양쪽 / M17.5 기타 이차성 무릎관절증 — 모두 K-L Grade 대상
    for (const code of ['M17.1', 'M17.2', 'M17.3', 'M17.4', 'M17.5']) {
      expect(supportsKlGrade({ code, name: '' })).toBe(true);
    }
  });

  it('상병명 표기 변형(무릎/슬관절, 관절증/관절염, 조사·수식어, 영문)은 코드 무관 true', () => {
    expect(supportsKlGrade({ code: '', name: '무릎 관절증' })).toBe(true);
    expect(supportsKlGrade({ code: '', name: '무릎골관절염' })).toBe(true);
    expect(supportsKlGrade({ code: '', name: '무릎의 관절증' })).toBe(true);
    expect(supportsKlGrade({ code: '', name: '무릎 관절염' })).toBe(true);
    expect(supportsKlGrade({ code: '', name: '퇴행성 슬관절염' })).toBe(true);
    expect(supportsKlGrade({ code: '', name: '슬관절 골관절염' })).toBe(true);
    expect(supportsKlGrade({ code: '', name: 'Osteoarthritis of knee' })).toBe(true);
    expect(supportsKlGrade({ code: 'M17.5', name: '무릎 골관절염, 편측' })).toBe(true);
  });

  it('무관한 코드·이름은 false', () => {
    expect(supportsKlGrade({ code: 'M22.4', name: '슬개골 연골연화증' })).toBe(false);
    expect(supportsKlGrade({ code: 'M23.2', name: '오래된 파열로 인한 반월판장애' })).toBe(false);
    expect(supportsKlGrade({ code: 'M75.1', name: '회전근개 증후군' })).toBe(false);
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
