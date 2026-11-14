// excelSerialToYmd ≡ XLSX.SSF.parse_date_code의 날짜 부분(REFACTORING_ROADMAP Phase 2 P2-22).
// 일괄입력 파서가 xlsx를 끌어오지 않도록 옮긴 함수가 원본과 한 값이라도 다르면 실패한다(xlsx는 이 테스트에서만 import).
import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { excelSerialToYmd } from '../excelDate';

const original = (v) => {
  const p = XLSX.SSF.parse_date_code(v);
  return p ? { y: p.y, m: p.m, d: p.d } : null;
};

describe('excelSerialToYmd parity with XLSX.SSF.parse_date_code', () => {
  it('정수 일련번호 0 ~ 80000 전부(1900-01-00 · 1900-02-29 윤년 버그 · 현재까지)', () => {
    for (let v = 0; v <= 80000; v += 1) {
      const got = excelSerialToYmd(v);
      const want = original(v);
      if (got?.y !== want?.y || got?.m !== want?.m || got?.d !== want?.d) {
        expect({ v, got }).toEqual({ v, got: want });
      }
    }
  });

  it('소수(시각)·자정 직전 반올림·경계·범위 밖', () => {
    const values = [
      0.5, 1.25, 59.999999, 60.5, 61.0000001, 45000.99999, 45000.999999, 45000.9999999, 45291.5,
      2958465, 2958465.5, 2958466, -1, -0.5, 1e-7, 0.99999999, 44927 + 86399.6 / 86400, 1234567.89,
    ];
    for (const v of values) expect([v, excelSerialToYmd(v)]).toEqual([v, original(v)]);
  });

  it('무작위 소수 2만 개(고정 시드)', () => {
    let seed = 7;
    const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < 20000; i += 1) {
      const v = rand() * 80000;
      const got = excelSerialToYmd(v);
      const want = original(v);
      if (got?.y !== want?.y || got?.m !== want?.m || got?.d !== want?.d) {
        expect({ v, got }).toEqual({ v, got: want });
      }
    }
  });
});
