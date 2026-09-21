// PR4-A1 — statsRegressionDisclosureGate.ts(③) 단위테스트.
import { describe, it, expect } from 'vitest';
import { evaluateRegressionDisclosure } from '../statsRegressionDisclosureGate';

describe('evaluateRegressionDisclosure', () => {
  it('포함/제외 person 모두 충분하고 레벨·event도 깨끗하면 공개', () => {
    const r = evaluateRegressionDisclosure({
      includedPersonCount: 100,
      excludedPersonCount: 0,
      levelSummaries: [{ variableKey: 'group', level: 'A', personCount: 50 }, { variableKey: 'group', level: 'B', personCount: 50 }],
      eventSummary: null,
    });
    expect(r).toEqual({ disclose: true, reasonCode: null });
  });

  it('포함 100명/제외 1명이면 억제(리뷰 #3 — 비대칭 소수셀)', () => {
    const r = evaluateRegressionDisclosure({
      includedPersonCount: 100,
      excludedPersonCount: 1,
      levelSummaries: [],
      eventSummary: null,
    });
    expect(r).toEqual({ disclose: false, reasonCode: 'MIN_COHORT_NOT_MET' });
  });

  it('제외 0명(결측 없음)은 소수셀이 아니다', () => {
    const r = evaluateRegressionDisclosure({
      includedPersonCount: 50,
      excludedPersonCount: 0,
      levelSummaries: [],
      eventSummary: null,
    });
    expect(r.disclose).toBe(true);
  });

  it('레벨별 person이 소수셀이면 억제', () => {
    const r = evaluateRegressionDisclosure({
      includedPersonCount: 100,
      excludedPersonCount: 0,
      levelSummaries: [{ variableKey: 'group', level: 'A', personCount: 95 }, { variableKey: 'group', level: 'B', personCount: 5 }],
      eventSummary: null,
    });
    expect(r).toEqual({ disclose: false, reasonCode: 'MIN_COHORT_NOT_MET' });
  });

  it('event/non-event 중 하나가 소수셀이면 억제', () => {
    const r = evaluateRegressionDisclosure({
      includedPersonCount: 100,
      excludedPersonCount: 0,
      levelSummaries: [],
      eventSummary: { eventPersonCount: 95, nonEventPersonCount: 5 },
    });
    expect(r).toEqual({ disclose: false, reasonCode: 'MIN_COHORT_NOT_MET' });
  });

  it('event/non-event 둘 다 충분하면 공개', () => {
    const r = evaluateRegressionDisclosure({
      includedPersonCount: 100,
      excludedPersonCount: 0,
      levelSummaries: [],
      eventSummary: { eventPersonCount: 50, nonEventPersonCount: 50 },
    });
    expect(r.disclose).toBe(true);
  });
});
