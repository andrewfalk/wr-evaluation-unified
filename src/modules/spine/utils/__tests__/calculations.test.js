import { describe, expect, it } from 'vitest';
import {
  calculateDailyDose,
  getSpineTaskDoses,
  classifySpineSeverity,
} from '../calculations';
import { SPINE_FORMULA_V513 } from '../formulaVersion';

// 임계치 1900N 통과를 보장하는 공통 입력 빌더
function task(force, timeValue, timeUnit = 'hr', frequency = 1) {
  return { force, timeValue, timeUnit, frequency };
}

describe('calculateDailyDose - formula dispatch', () => {
  // F=3000N, t=2h, freq=1
  //   legacy: sqrt(3000² × 7200) / 1000 / 60
  //         = sqrt(64,800,000,000) / 60000 ≈ 254,558 / 60000 ≈ 4.2426
  //   v5.1.3: sqrt((3000² × 2) / 8) × 8 / 1000
  //         = sqrt(2,250,000) × 8 / 1000 = 1500 × 8 / 1000 = 12.0
  it('legacy formula (formulaVersion 부재) 반환값을 보존한다', () => {
    const result = calculateDailyDose([task(3000, 2, 'hr', 1)], undefined);
    expect(result.dailyDoseKNh).toBeCloseTo(4.2426, 3);
    // 옛 반환 키도 유지되어야 한다 (이전 출력 보존 목적)
    expect(result).toHaveProperty('sumFSquaredT');
    expect(result).toHaveProperty('dailyDoseNs');
  });

  it('v5.1.3 formula는 정정된 MDDM 공식 결과를 반환한다', () => {
    const result = calculateDailyDose([task(3000, 2, 'hr', 1)], SPINE_FORMULA_V513);
    expect(result.dailyDoseKNh).toBeCloseTo(12.0, 6);
    expect(result).toHaveProperty('sumF2T_hour');
    expect(result).toHaveProperty('dailyDoseNh');
  });

  it('두 공식은 동일 입력에서 √8 비율로 차이가 난다', () => {
    const tasks = [task(2500, 1, 'hr', 2), task(3500, 30, 'min', 1)];
    const legacy = calculateDailyDose(tasks, undefined).dailyDoseKNh;
    const v513 = calculateDailyDose(tasks, SPINE_FORMULA_V513).dailyDoseKNh;
    expect(v513 / legacy).toBeCloseTo(Math.sqrt(8), 6);
  });

  it('임계치 미달(1900N 미만) task는 양쪽 공식 모두 0 반환', () => {
    const tasks = [task(1500, 2, 'hr', 1)];
    expect(calculateDailyDose(tasks, undefined).dailyDoseKNh).toBe(0);
    expect(calculateDailyDose(tasks, SPINE_FORMULA_V513).dailyDoseKNh).toBe(0);
  });

  it('4000N 이상 task가 있으면 hasHighForceTask=true (양쪽 분기 공통)', () => {
    const tasks = [task(4500, 5, 'min', 4)];
    expect(calculateDailyDose(tasks, undefined).hasHighForceTask).toBe(true);
    expect(calculateDailyDose(tasks, SPINE_FORMULA_V513).hasHighForceTask).toBe(true);
  });
});

describe('getSpineTaskDoses - 작업별 기여 정책', () => {
  it('v5.1.3 분기: 작업별 기여의 합이 총 dailyDoseKNh와 정확히 일치 (합산 무결성)', () => {
    const tasks = [task(3000, 2, 'hr', 1), task(2500, 1, 'hr', 2)];
    const contribs = getSpineTaskDoses(tasks, SPINE_FORMULA_V513);
    const total = calculateDailyDose(tasks, SPINE_FORMULA_V513).dailyDoseKNh;
    const sum = contribs.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(total, 9);
  });

  it('legacy 분기: 각 task의 기여가 기존 단일 작업 공식 (F × √t_초) / 60000과 정확히 일치', () => {
    const tasks = [task(3000, 2, 'hr', 1), task(2500, 1, 'hr', 2)];
    const contribs = getSpineTaskDoses(tasks, undefined);
    const expected0 = (3000 * Math.sqrt(7200)) / 1000 / 60;
    const expected1 = (2500 * Math.sqrt(7200)) / 1000 / 60;
    expect(contribs[0]).toBeCloseTo(expected0, 9);
    expect(contribs[1]).toBeCloseTo(expected1, 9);
  });

  it('totalWeight===0 가드: 모든 task가 임계치 미달이면 NaN 없이 0 배열 반환', () => {
    const tasks = [task(1500, 1, 'hr', 1), task(1800, 30, 'min', 1)];
    const contribs = getSpineTaskDoses(tasks, SPINE_FORMULA_V513);
    expect(contribs).toEqual([0, 0]);
    // 어떤 값도 NaN/Infinity가 아니어야 한다
    contribs.forEach((c) => expect(Number.isFinite(c)).toBe(true));
  });

  it('임계치 미달 task는 0 기여, 통과 task가 1개뿐이면 그 task가 총량 100%를 가져간다 (v5.1.3)', () => {
    const tasks = [task(1500, 1, 'hr', 1), task(3000, 2, 'hr', 1)];
    const contribs = getSpineTaskDoses(tasks, SPINE_FORMULA_V513);
    const total = calculateDailyDose(tasks, SPINE_FORMULA_V513).dailyDoseKNh;
    expect(contribs[0]).toBe(0);
    expect(contribs[1]).toBeCloseTo(total, 9);
  });

  it('빈 입력은 빈 배열 반환', () => {
    expect(getSpineTaskDoses([], SPINE_FORMULA_V513)).toEqual([]);
    expect(getSpineTaskDoses([], undefined)).toEqual([]);
  });
});

describe('classifySpineSeverity - 남녀 분리 기준', () => {
  // 남성 (기존 유지)
  it('남성: 일일 >4 또는 최대 ≥6000 → 고도', () => {
    expect(classifySpineSeverity(4.1, 0, 'male')).toBe('고도');
    expect(classifySpineSeverity(0, 6000, 'male')).toBe('고도');
  });
  it('남성: 일일 >3 또는 최대 ≥5000 → 중등도상', () => {
    expect(classifySpineSeverity(3.5, 0, 'male')).toBe('중등도상');
    expect(classifySpineSeverity(0, 5500, 'male')).toBe('중등도상');
  });
  it('남성: 일일 ≥2 또는 최대 ≥4000 → 중등도하', () => {
    expect(classifySpineSeverity(2.5, 4500, 'male')).toBe('중등도하');
    expect(classifySpineSeverity(2.0, 0, 'male')).toBe('중등도하');
  });
  it('남성: 그 외 → 경도', () => {
    expect(classifySpineSeverity(1.5, 3500, 'male')).toBe('경도');
    expect(classifySpineSeverity(0.6, 3200, 'male')).toBe('경도');
  });

  // 여성 (신설 — 더 민감한 기준)
  it('여성: 일일 >3 또는 최대 ≥5000 → 고도', () => {
    expect(classifySpineSeverity(3.5, 0, 'female')).toBe('고도');
    expect(classifySpineSeverity(0, 5000, 'female')).toBe('고도');
  });
  it('여성: 일일 >2 또는 최대 ≥4000 → 중등도상', () => {
    expect(classifySpineSeverity(2.5, 4500, 'female')).toBe('중등도상');
    expect(classifySpineSeverity(2.1, 0, 'female')).toBe('중등도상');
  });
  it('여성: 일일 ≥0.5 또는 최대 ≥3000 → 중등도하', () => {
    expect(classifySpineSeverity(0.6, 3200, 'female')).toBe('중등도하');
    expect(classifySpineSeverity(0.5, 0, 'female')).toBe('중등도하');
  });
  it('여성: 그 외 → 경도', () => {
    expect(classifySpineSeverity(0.3, 2500, 'female')).toBe('경도');
    expect(classifySpineSeverity(0, 0, 'female')).toBe('경도');
  });

  // 동일 입력에서 남녀 판정이 다르게 나뉘는 핵심 케이스
  it('동일 입력 (2.5 kN·h, 4500 N): 남성=중등도하, 여성=중등도상', () => {
    expect(classifySpineSeverity(2.5, 4500, 'male')).toBe('중등도하');
    expect(classifySpineSeverity(2.5, 4500, 'female')).toBe('중등도상');
  });
  it('동일 입력 (0.6 kN·h, 3200 N): 남성=경도, 여성=중등도하', () => {
    expect(classifySpineSeverity(0.6, 3200, 'male')).toBe('경도');
    expect(classifySpineSeverity(0.6, 3200, 'female')).toBe('중등도하');
  });
});
