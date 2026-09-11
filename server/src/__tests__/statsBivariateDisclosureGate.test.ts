// PR3-A — 통합 공개통제 게이트 단위테스트. 8차 리뷰가 지목한 정확한 반례
// ([[1,19],[19,61]] — 주변합은 충분해도 내부 셀 하나가 작으면 false여야 함)를
// 그대로 회귀 테스트로 고정한다.
import { describe, it, expect } from 'vitest';
import {
  evaluateBivariateDisclosure,
  isGroupBreakdownDisclosable,
  isTableDisclosable,
} from '../statsBivariateDisclosureGate';
import type { PairedDatasetResult } from '../statsBivariateDataset';

function paired(includedPersonCount: number, excludedPersonCount: number): PairedDatasetResult {
  return {
    pairs: [],
    includedCaseCount: includedPersonCount,
    includedPersonCount,
    excludedCaseCount: excludedPersonCount,
    excludedPersonCount,
    exclusions: [],
  };
}

describe('evaluateBivariateDisclosure — 레이어1(쌍 전체)', () => {
  it('포함·제외 둘 다 0 또는 ≥10이면 공개 가능', () => {
    expect(evaluateBivariateDisclosure(paired(100, 0))).toEqual({ disclose: true, reasonCode: null });
    expect(evaluateBivariateDisclosure(paired(80, 20))).toEqual({ disclose: true, reasonCode: null });
  });

  it('포함이 소수(1~9)면 억제(기존 completeCaseN 대칭억제 원칙 확장)', () => {
    expect(evaluateBivariateDisclosure(paired(5, 95))).toEqual({ disclose: false, reasonCode: 'MIN_COHORT_NOT_MET' });
  });

  it('제외가 소수(1~9)면 억제 — "제외 1명"이 역산되는 걸 막는다', () => {
    expect(evaluateBivariateDisclosure(paired(99, 1))).toEqual({ disclose: false, reasonCode: 'MIN_COHORT_NOT_MET' });
  });

  it('포함 0명은 통과(isSmallCell(0)===false, "0은 안전"이라는 기존 관례)', () => {
    expect(evaluateBivariateDisclosure(paired(0, 100))).toEqual({ disclose: true, reasonCode: null });
  });
});

describe('isGroupBreakdownDisclosable — A-2 그룹 게이트', () => {
  it('모든 그룹이 0 또는 ≥10이면 true', () => {
    expect(isGroupBreakdownDisclosable([{ personCount: 99 }, { personCount: 10 }])).toBe(true);
  });

  // 7차 리뷰의 핵심 반례 — 99/1과 98/1/1이 관측 그룹 수만 다르고 둘 다 "소수 레벨 1개"를
  // 갖는데, 그 소수 레벨의 존재 자체가 REQUIRES_EXACTLY_TWO_GROUPS 노출로 새면 안 된다.
  it('99/1 — 소수 그룹 하나라도 있으면 false(브레이크다운 전체를 숨김)', () => {
    expect(isGroupBreakdownDisclosable([{ personCount: 99 }, { personCount: 1 }])).toBe(false);
  });

  it('98/1/1 — 마찬가지로 false, 99/1과 같은 결과라 구분 불가능해야 한다', () => {
    expect(isGroupBreakdownDisclosable([{ personCount: 98 }, { personCount: 1 }, { personCount: 1 }])).toBe(false);
  });
});

describe('isTableDisclosable — A-2 표 게이트(8차 리뷰 정정: 주변합 아니라 개별 셀 기준)', () => {
  it('모든 셀이 0 또는 ≥10이면 true', () => {
    expect(isTableDisclosable([[50, 30], [20, 60]])).toBe(true);
  });

  // 8차 리뷰가 지목한 정확한 반례 — 행 합계 20/80, 열 합계 20/80으로 주변합은 전부
  // 충분해 보이지만 좌상단 셀이 1이라 false여야 한다.
  it('[[1,19],[19,61]] — 주변합은 충분해도 내부 셀 하나가 소수면 false', () => {
    const table = [[1, 19], [19, 61]];
    const rowTotals = table.map((r) => r.reduce((a, b) => a + b, 0));
    const colTotals = [table[0][0] + table[1][0], table[0][1] + table[1][1]];
    expect(rowTotals).toEqual([20, 80]); // 주변합 자체는 전부 ≥10
    expect(colTotals).toEqual([20, 80]);
    expect(isTableDisclosable(table)).toBe(false); // 그런데도 내부 셀 때문에 false
  });

  it('셀이 정확히 0이면 그 셀 자체는 안전(개수 없음)하지만 다른 소수 셀이 있으면 여전히 false', () => {
    expect(isTableDisclosable([[0, 50], [3, 47]])).toBe(false); // 3이 소수셀
    expect(isTableDisclosable([[0, 50], [10, 40]])).toBe(true); // 0은 안전, 나머지 전부 ≥10
  });
});
