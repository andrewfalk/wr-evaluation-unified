import { describe, expect, it, vi } from 'vitest';

// exportService.js는 html2pdf.js(UMD, 브라우저 전역 `self` 참조)를 import하므로 모킹.
vi.mock('html2pdf.js', () => ({ default: () => ({}) }));

import { BATCH_HEADERS, generateBatchRows } from '../exportService';

describe('BATCH_HEADERS: 첫 7개 열 순서 잠금', () => {
  it('등록번호/이름/성별/생년월일/재해일자/키/체중 순이다', () => {
    expect(BATCH_HEADERS.slice(0, 7)).toEqual([
      '등록번호', '이름', '성별', '생년월일', '재해일자', '키', '체중',
    ]);
  });
});

describe('generateBatchRows: 첫 7개 열 값 매핑', () => {
  const patient = {
    data: {
      shared: {
        patientNo: 'P-001',
        name: '홍길동',
        gender: 'male',
        birthDate: '1980-05-10',
        injuryDate: '2024-03-15',
        height: 175,
        weight: 70,
        diagnoses: [{ code: 'M17.1', name: '무릎관절증', side: 'right' }],
        jobs: [],
      },
      modules: {},
      activeModules: ['knee'],
    },
  };

  const row = generateBatchRows([patient])[0];

  it('A=등록번호, B=이름, C=성별(한글), D=생년월일, E=재해일자, F=키, G=체중', () => {
    expect(row[0]).toBe('P-001');     // A 등록번호
    expect(row[1]).toBe('홍길동');     // B 이름
    expect(row[2]).toBe('남');         // C 성별
    expect(row[3]).toBe('1980-05-10'); // D 생년월일
    expect(row[4]).toBe('2024-03-15'); // E 재해일자
    expect(row[5]).toBe(175);          // F 키
    expect(row[6]).toBe(70);           // G 체중
  });
});
