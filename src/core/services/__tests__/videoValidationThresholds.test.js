import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  VALIDATION_NORMALIZATION_TABLE,
  CANDIDATE_RISK_DECISION_THRESHOLDS,
  normalizeForComparison,
  riskBinarize,
} from '../videoValidationThresholds.js';
import { DEFAULT_CONFIDENCE_THRESHOLDS } from '../videoConfidenceConfig.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('videoValidationThresholds — normalizeForComparison', () => {
  it('non-candidate(numeric/bool/categorical)는 그대로 통과', () => {
    const num = { kind: 'numeric', value: 12, unit: 'minutes_per_day' };
    expect(normalizeForComparison('squatDuration', num)).toBe(num);
    const bool = { kind: 'boolean', value: true };
    expect(normalizeForComparison('suspectedKneeTwist', bool)).toBe(bool);
  });

  it('시간단위 candidate: 비율×활동분 → minutes_per_day numeric', () => {
    const fv = { kind: 'candidate', value: 0.25 };
    const ev = { intrinsicValue: 0.25, activeMinutesPerDay: 360 };
    expect(normalizeForComparison('trunkFlexionOver45Duration', fv, ev))
      .toEqual({ kind: 'numeric', value: 90, unit: 'minutes_per_day' });
  });

  it('시간단위 candidate: 활동분 없으면 no_active_time', () => {
    const fv = { kind: 'candidate', value: 0.25 };
    expect(normalizeForComparison('trunkFlexionOver45Duration', fv, { intrinsicValue: 0.25, activeMinutesPerDay: null }))
      .toEqual({ status: 'no_active_time' });
  });

  it('각도 candidate: intrinsicUnit=degrees면 numeric degrees', () => {
    const fv = { kind: 'candidate', value: 52 };
    expect(normalizeForComparison('trunkPostureG', fv, { intrinsicValue: 52, intrinsicUnit: 'degrees' }))
      .toEqual({ kind: 'numeric', value: 52, unit: 'degrees' });
  });

  it('각도 candidate: 단위가 degrees가 아니면 not_comparable(단위 추정 금지)', () => {
    const fv = { kind: 'candidate', value: 52 };
    expect(normalizeForComparison('trunkPostureG', fv, { intrinsicValue: 52, intrinsicUnit: 'ratio' }))
      .toEqual({ status: 'not_comparable_candidate' });
  });

  it('표에 없는 candidate는 not_comparable_candidate', () => {
    const fv = { kind: 'candidate', value: true };
    expect(normalizeForComparison('neckCombinedFlexRot', fv, {}))
      .toEqual({ status: 'not_comparable_candidate' });
  });
});

describe('videoValidationThresholds — riskBinarize', () => {
  const norm = { kind: 'numeric', value: 90, unit: 'minutes_per_day' };

  it('컷오프 미선언이면 null(sensitivity 생략)', () => {
    expect(riskBinarize('trunkFlexionOver45Duration', norm)).toBeNull();
  });

  it('gte 컷오프: value>=cutoff → true', () => {
    const th = { trunkFlexionOver45Duration: { cutoff: 60, unit: 'minutes_per_day', direction: 'gte' } };
    expect(riskBinarize('trunkFlexionOver45Duration', norm, th)).toBe(true);
    expect(riskBinarize('trunkFlexionOver45Duration', { ...norm, value: 30 }, th)).toBe(false);
  });

  it('lte 방향 + 단위 불일치 처리', () => {
    const lte = { x: { cutoff: 100, unit: 'minutes_per_day', direction: 'lte' } };
    expect(riskBinarize('x', norm, lte)).toBe(true);
    const wrongUnit = { x: { cutoff: 60, unit: 'degrees', direction: 'gte' } };
    expect(riskBinarize('x', norm, wrongUnit)).toBeNull();
  });
});

describe('videoValidationThresholds — 비활성/분리 불변식', () => {
  it('위험 컷오프 표는 기본 비어 있음(추측 금지)', () => {
    expect(Object.keys(CANDIDATE_RISK_DECISION_THRESHOLDS)).toHaveLength(0);
  });

  it('정규화 표는 검증 가능 candidate만 선언', () => {
    expect(Object.keys(VALIDATION_NORMALIZATION_TABLE).sort())
      .toEqual(['trunkFlexionOver45Duration', 'trunkPostureG']);
  });

  it('게이팅 기본 표(DEFAULT_CONFIDENCE_THRESHOLDS)는 비어 있고 검증 config와 별개', () => {
    expect(Object.keys(DEFAULT_CONFIDENCE_THRESHOLDS)).toHaveLength(0);
  });

  it('앱 변환 경로(videoPerDayConversion)는 검증 전용 config를 import하지 않음', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../videoPerDayConversion.js'), 'utf-8');
    expect(src).not.toContain('videoValidationThresholds');
  });
});
