import { describe, it, expect } from 'vitest';
import { collectImportDateErrors, checkImportDate, isPlausibleBirthDate } from '../batchImportHelpers';

const NOW = new Date('2026-08-03T00:30:00Z'); // KST 2026-08-03 09:30

const HEADER = ['이름', '등록번호', '생년월일', '재해일자'];

function sheet(...dataRows) {
  return [HEADER, ...dataRows];
}

describe('checkImportDate', () => {
  it('엑셀 텍스트 서식으로 들어온 4110-02-12를 거부한다', () => {
    const r = checkImportDate('4110-02-12', { now: NOW });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('future');
    expect(r.message).toContain('오늘 이후');
  });

  it('정상 값은 canonical 형식으로 정규화한다', () => {
    expect(checkImportDate('1957/12/13', { now: NOW })).toMatchObject({
      valid: true,
      normalized: '1957-12-13',
    });
  });

  it('엑셀 serial 숫자도 동일하게 검증한다', () => {
    // 21167 ≈ 1957-12-13 (1900 date system)
    const ok = checkImportDate(21167, { now: NOW });
    expect(ok.valid).toBe(true);

    // 터무니없이 큰 serial → 먼 미래 연도 → 거부
    const bad = checkImportDate(999999, { now: NOW });
    expect(bad.valid).toBe(false);
    expect(bad.reason).toBe('future');
  });

  it('빈 값은 통과시킨다 (생년월일 미상 환자 허용)', () => {
    expect(checkImportDate('', { now: NOW }).valid).toBe(true);
    expect(checkImportDate(undefined, { now: NOW }).valid).toBe(true);
  });

  // parseDate의 정규식은 anchor가 없어 부분 문자열에서도 날짜를 뽑아낸다.
  // checkImportDate가 그걸 거치면 anchor된 검증이 무력화되므로 문자열은 원본을 그대로 넘긴다.
  it('부분 문자열에 날짜가 섞인 셀을 형식 오류로 잡는다', () => {
    const r = checkImportDate('abc2020-01-02xyz', { now: NOW });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('format');
  });

  it('날짜 뒤에 주석이 붙은 셀도 거부한다', () => {
    expect(checkImportDate('1980-01-01 (추정)', { now: NOW }).valid).toBe(false);
  });
});

describe('isPlausibleBirthDate', () => {
  it('boolean 래퍼로 동작한다', () => {
    expect(isPlausibleBirthDate('1980-05-05', NOW)).toBe(true);
    expect(isPlausibleBirthDate('4110-02-12', NOW)).toBe(false);
  });
});

describe('collectImportDateErrors', () => {
  it('오류 없는 시트는 빈 배열', () => {
    const rows = sheet(['홍길동', '123', '1980-05-05', '2024-01-02']);
    expect(collectImportDateErrors(rows, { now: NOW })).toEqual([]);
  });

  it('잘못된 생년월일 행을 행 번호·원본 값과 함께 보고한다', () => {
    const rows = sheet(
      ['홍길동', '123', '1980-05-05', '2024-01-02'],
      ['김철수', '124', '4110-02-12', '2024-03-04'],
    );
    const errors = collectImportDateErrors(rows, { now: NOW });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      rowIndex: 2,
      rowLabel: 3, // 엑셀 3행 (헤더 1행 + 데이터 2행)
      name: '김철수',
      field: '생년월일',
      rawValue: '4110-02-12',
    });
  });

  it('재해일자 오류도 검출한다', () => {
    const rows = sheet(['홍길동', '123', '1980-05-05', '2099-01-01']);
    const errors = collectImportDateErrors(rows, { now: NOW });
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe('재해일자');
  });

  it('한 행에 두 컬럼 모두 오류면 2건을 보고한다', () => {
    const rows = sheet(['홍길동', '123', '4110-02-12', '2099-01-01']);
    expect(collectImportDateErrors(rows, { now: NOW })).toHaveLength(2);
  });

  it('이름 없는 행은 검증 대상이 아니다 (handleImport가 건너뛰는 행)', () => {
    const rows = sheet(['', '123', '4110-02-12', '']);
    expect(collectImportDateErrors(rows, { now: NOW })).toEqual([]);
  });

  it('빈 날짜 셀은 오류가 아니다', () => {
    const rows = sheet(['홍길동', '123', '', '']);
    expect(collectImportDateErrors(rows, { now: NOW })).toEqual([]);
  });

  it('헤더만 있거나 빈 시트는 빈 배열', () => {
    expect(collectImportDateErrors([HEADER], { now: NOW })).toEqual([]);
    expect(collectImportDateErrors([], { now: NOW })).toEqual([]);
    expect(collectImportDateErrors(null, { now: NOW })).toEqual([]);
  });

  it('실재하지 않는 날짜(2월 30일)를 구분해 보고한다', () => {
    const rows = sheet(['홍길동', '123', '1980-02-30', '']);
    const errors = collectImportDateErrors(rows, { now: NOW });
    expect(errors[0].message).toContain('존재하지 않는');
  });
});
