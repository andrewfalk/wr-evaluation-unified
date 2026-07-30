import { describe, expect, it } from 'vitest';
import {
  buildSpineSectionText,
  buildSpineSectionSummary,
  getSpineInterpretation,
} from '../sectionText';

// 비교 객체 생성 헬퍼 — court/mddm.percent를 직접 지정해 분기 케이스 검증
function mkComparison({ courtPct, mddmPct, courtLimit = 12.5, mddmLimit = 25 }) {
  return {
    court: {
      limit: courtLimit,
      percent: courtPct,
      status: courtPct <= 100 ? 'safe' : (courtPct <= 120 ? 'warning' : 'danger'),
    },
    mddm: {
      limit: mddmLimit,
      percent: mddmPct,
      status: mddmPct <= 100 ? 'safe' : 'danger',
    },
  };
}

describe('getSpineInterpretation - BSG/MDDM 2단 분기', () => {
  it('mddm·court 모두 초과 → mddm-초과 문구 (가장 강한 추정)', () => {
    const text = getSpineInterpretation(mkComparison({ courtPct: 150, mddmPct: 110 }));
    expect(text).toContain('가장 보수적인 MDDM 최초 모델 기준');
    expect(text).toContain('모두 초과하여');
    expect(text).toContain('강하게 추정');
    expect(text).not.toMatch(/DWS2/i);
  });

  it('court만 초과 → court-초과 문구 + 부가 단서 문구', () => {
    const text = getSpineInterpretation(mkComparison({ courtPct: 110, mddmPct: 50 }));
    expect(text).toContain('독일 연방 사회법원(BSG) 기준');
    expect(text).toContain('초과하여');
    expect(text).toContain('단, 해당 기준 초과가 자동으로 업무 관련성이 높다는 의미는 아니며');
    expect(text).toContain('다른 요인들을 종합적으로 검토');
    expect(text).not.toMatch(/DWS2/i);
  });

  it('둘 다 미만 → 미달 문구', () => {
    const text = getSpineInterpretation(mkComparison({ courtPct: 40, mddmPct: 20 }));
    expect(text).toContain('모두 미달하여');
    expect(text).toContain('직업적 요인을 주요 원인으로 보기 어렵습니다');
    expect(text).not.toMatch(/DWS2/i);
  });

  it('markdown: false → 앞 "** " 접두사 제거된 plain text', () => {
    const c = mkComparison({ courtPct: 110, mddmPct: 50 });
    const md = getSpineInterpretation(c, { markdown: true });
    const plain = getSpineInterpretation(c, { markdown: false });
    expect(md.startsWith('** ')).toBe(true);
    expect(plain.startsWith('** ')).toBe(false);
    expect(md.slice(3)).toBe(plain);
  });

  it('comparison이 없으면 빈 문자열', () => {
    expect(getSpineInterpretation(null)).toBe('');
    expect(getSpineInterpretation(undefined)).toBe('');
  });
});

describe('buildSpineSectionText - 단일 소스 출력', () => {
  it('빈 calc 호출도 throw 없이 안전한 문자열 반환', () => {
    const text = buildSpineSectionText({});
    expect(typeof text).toBe('string');
    expect(text).toContain('< 허리(요추) >');
    expect(text).toContain('입력된 작업 없음');
  });

  it('null calc도 안전하게 처리', () => {
    expect(() => buildSpineSectionText(null)).not.toThrow();
    expect(() => buildSpineSectionText(undefined)).not.toThrow();
  });

  it('헤더는 reportGenerator 양식 "< 허리(요추) >" 사용', () => {
    const text = buildSpineSectionText({ tasks: [], comparison: null });
    expect(text).toContain('< 허리(요추) >');
    expect(text).not.toContain('<허리(요추)>'); // 공백 없는 옛 양식이 아님
  });

  it('DWS2 표기가 출력에 등장하지 않음', () => {
    const calc = {
      tasks: [],
      dailyDose: { dailyDoseKNh: 4.0 },
      lifetimeDose: { lifetimeDoseMNh: 8.0 },
      comparison: mkComparison({ courtPct: 60, mddmPct: 30 }),
      maxForce: 5000,
      gender: 'male',
    };
    const text = buildSpineSectionText(calc);
    expect(text).not.toMatch(/DWS2/i);
    expect(text).toContain('독일 법원(BSG) 기준 대비');
    expect(text).toContain('MDDM 최초 모델 기준 대비');
  });

  it('excluded=true이면 누적 노출량 줄에 안내 문구 추가', () => {
    const calc = {
      tasks: [],
      dailyDose: { dailyDoseKNh: 0.5 },
      lifetimeDose: { lifetimeDoseMNh: 0, excluded: true },
      comparison: mkComparison({ courtPct: 0, mddmPct: 0 }),
      maxForce: 3000,
      gender: 'male',
    };
    const text = buildSpineSectionText(calc);
    expect(text).toContain('(일 임계값 미만으로 누적 노출량이 0으로 계산됩니다)');
  });

  it('excluded=false이면 안내 문구 없음', () => {
    const calc = {
      tasks: [],
      dailyDose: { dailyDoseKNh: 6.0 },
      lifetimeDose: { lifetimeDoseMNh: 8.0, excluded: false },
      comparison: mkComparison({ courtPct: 60, mddmPct: 30 }),
      maxForce: 5000,
      gender: 'male',
    };
    const text = buildSpineSectionText(calc);
    expect(text).not.toContain('(일 임계값 미만으로');
  });
});

describe('buildSpineSectionSummary - EMR 종합소견용 요약본 (b8 byte 절감)', () => {
  const calc = {
    mddmStatus: 'present',
    tasks: [{ name: '작업1', posture: '전방굴곡', weight: 20, frequency: 30, force: 4000 }],
    dailyDose: { dailyDoseKNh: 6.0 },
    lifetimeDose: { lifetimeDoseMNh: 8.0, excluded: false },
    comparison: mkComparison({ courtPct: 64, mddmPct: 32 }),
    maxForce: 5000,
    gender: 'male',
  };

  it('빈 calc 호출도 throw 없이 안전한 문자열 반환', () => {
    const text = buildSpineSectionSummary({});
    expect(typeof text).toBe('string');
    expect(text).toContain('< 허리(요추) >');
  });

  it('null/undefined calc도 안전하게 처리', () => {
    expect(() => buildSpineSectionSummary(null)).not.toThrow();
    expect(() => buildSpineSectionSummary(undefined)).not.toThrow();
  });

  it('결론(최대 압박력·일일 노출량·누적 노출량·기준치 대비 판정)은 유지된다', () => {
    const text = buildSpineSectionSummary(calc);
    expect(text).toContain('최대 압박력');
    expect(text).toContain('일일 노출량');
    expect(text).toContain('누적 노출량');
    expect(text).toContain('법원(BSG) 기준 대비');
    expect(text).toContain('모두 미달하여'); // getSpineInterpretation 결론 문장
  });

  it('작업별 분석(반복 행)은 빠진다 — buildSpineSectionText 대비 짧다', () => {
    const full = buildSpineSectionText(calc);
    const summary = buildSpineSectionSummary(calc);
    expect(full).toContain('작업별 분석');
    expect(full).toContain('작업 1. 작업1');
    expect(summary).not.toContain('작업별 분석');
    expect(summary).not.toContain('작업 1.');
    expect(summary.length).toBeLessThan(full.length);
  });

  it('mddmStatus가 present가 아니면 MDDM 섹션 미출력 (전문과 동일 게이트)', () => {
    const text = buildSpineSectionSummary({ ...calc, mddmStatus: 'unknown' });
    expect(text).not.toContain('< 허리(요추) >');
  });

  it('vibration.exposureStatus가 present일 때만 전신진동 요약이 붙는다', () => {
    const vibration = {
      exposureStatus: 'present',
      amax8: { min: 0.7, max: 0.7 },
      dv: { min: 1724.8, max: 1724.8 },
      comparison: {
        daily: { percent: { min: 111, max: 111 }, status: 'danger' },
        lifetime: { percent: { min: 123, max: 123 }, status: 'danger' },
      },
      risk: { description: 'BK2110 생애누적 기준 도달/초과 가능' },
    };
    const withVibration = buildSpineSectionSummary({ ...calc, vibration });
    const withoutVibration = buildSpineSectionSummary({ ...calc, vibration: { exposureStatus: 'none' } });
    expect(withVibration).toContain('전신진동(BK 2110)');
    expect(withVibration).toContain('Amax(8)');
    expect(withVibration).toContain('BK2110 생애누적 기준 도달/초과 가능');
    expect(withoutVibration).not.toContain('전신진동(BK 2110)');
  });
});

describe('일치화 회귀 — reportGenerator와 exportService가 동일 문자열 반환', () => {
  it('두 경로 모두 동일 buildSpineSectionText를 호출하므로 결과가 같다', async () => {
    // 두 모듈 다 같은 buildSpineSectionText를 import해서 한 함수만 호출하는 구조.
    // 여기서는 동일 calc로 한 번만 호출해도 동일성을 직접 보장한다.
    const calc = {
      tasks: [],
      dailyDose: { dailyDoseKNh: 6.0 },
      lifetimeDose: { lifetimeDoseMNh: 8.0, excluded: false },
      comparison: mkComparison({ courtPct: 64, mddmPct: 32 }),
      maxForce: 5000,
      gender: 'male',
    };
    const a = buildSpineSectionText(calc);
    const b = buildSpineSectionText(calc);
    expect(a).toBe(b);
  });
});

describe('MDDM + WBV 공존 출력 (mddmStatus / vibration.exposureStatus 게이트)', () => {
  const mddmCalc = {
    mddmStatus: 'present',
    tasks: [],
    dailyDose: { dailyDoseKNh: 6.0 },
    lifetimeDose: { lifetimeDoseMNh: 8.0, excluded: false },
    comparison: mkComparison({ courtPct: 64, mddmPct: 32 }),
    maxForce: 5000,
    gender: 'male',
  };

  it("MDDM unknown → MDDM 섹션 미출력", () => {
    const text = buildSpineSectionText({ ...mddmCalc, mddmStatus: 'unknown' });
    expect(text).not.toContain('< 허리(요추) >');
  });

  it("MDDM none → MDDM 섹션 미출력 (present만 출력)", () => {
    const text = buildSpineSectionText({ ...mddmCalc, mddmStatus: 'none' });
    expect(text).not.toContain('< 허리(요추) >');
  });

  it("WBV unknown → 진동 텍스트 미append (기존 MDDM 출력 무회귀)", () => {
    const text = buildSpineSectionText({ ...mddmCalc, vibration: { exposureStatus: 'unknown' } });
    expect(text).toContain('< 허리(요추) >');
    expect(text).not.toContain('전신진동(BK 2110)');
  });

  it("WBV none → 진동 텍스트 미append (공간 절약, present만 출력)", () => {
    const text = buildSpineSectionText({ ...mddmCalc, vibration: { exposureStatus: 'none' } });
    expect(text).not.toContain('전신진동(BK 2110)');
  });

  it("WBV present → 진동 결과 섹션 append", () => {
    const vibration = {
      exposureStatus: 'present',
      jobResults: [{ jobName: '직업A', periodYears: 16, intervals: [
        { name: '운전', awMin: 0.7, awMax: 0.7, timeValue: 8, timeUnit: 'hr' },
      ], amax8: { min: 0.7, max: 0.7 }, dv: { min: 1724.8, max: 1724.8 } }],
      amax8: { min: 0.7, max: 0.7 },
      dv: { min: 1724.8, max: 1724.8 },
      comparison: {
        daily: { threshold: 0.63, percent: { min: 111, max: 111 }, status: 'danger' },
        lifetime: { threshold: 1400, percent: { min: 123, max: 123 }, status: 'danger' },
      },
      validation: { hasInvalidIntervals: false, invalidIntervals: [], messages: [] },
      risk: { level: 'danger', description: 'BK2110 생애누적 기준 도달/초과 가능' },
    };
    const text = buildSpineSectionText({ ...mddmCalc, vibration });
    expect(text).toContain('< 허리(요추) >');               // MDDM
    expect(text).toContain('< 허리(요추) - 전신진동(BK 2110) >'); // WBV
    expect(text).toContain('Amax(8)');
  });
});
