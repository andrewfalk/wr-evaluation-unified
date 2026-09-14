import { describe, it, expect } from 'vitest';
import {
  extractPatientIdentityGender,
  extractPatientIdentityHeightCm,
  extractPatientIdentityWeightKg,
  extractPatientIdentityBirthDate,
  extractPatientIdentityInjuryDate,
  extractPatientIdentityEvaluationDate,
  extractPatientIdentityHighBloodPressure,
  extractPatientIdentityDiabetes,
} from '../../../modules/patient/extractors';
import { deterministicMigrate } from '../../../migration/deterministicMigrate';

const FALLBACK = '2024-01-01T00:00:00.000Z';

function migrate(payload: unknown, caseId = 'case-1') {
  return deterministicMigrate(payload, { caseId, createdAtFallbackIso: FALLBACK });
}

function patientCase(shared: Record<string, unknown>) {
  // patient pseudo-module에는 activeModules 게이트가 없다 — 빈 배열이어도 값이 나와야 한다.
  return migrate({ data: { shared, modules: {}, activeModules: [] } });
}

describe('extractPatientIdentityGender — case grain(activeModules 게이트 없음)', () => {
  it('activeModules가 비어 있어도 structural_missing이 아니라 정상 추출된다', () => {
    const result = extractPatientIdentityGender(patientCase({ gender: 'male' }));
    expect(result).toEqual({ value: 'male', missing: null, qualityFlags: [] });
  });

  it('미입력은 not_entered(무플래그)', () => {
    expect(extractPatientIdentityGender(patientCase({}))).toEqual({ value: null, missing: 'not_entered', qualityFlags: [] });
  });

  it('문자열이 아니면 not_entered + invalid', () => {
    expect(extractPatientIdentityGender(patientCase({ gender: 123 }))).toEqual({
      value: null,
      missing: 'not_entered',
      qualityFlags: ['invalid'],
    });
  });
});

describe('extractPatientIdentityHeightCm/WeightKg — case grain(물리량, 0 이하 거부)', () => {
  it('정상 숫자는 그대로 통과', () => {
    expect(extractPatientIdentityHeightCm(patientCase({ height: 170 }))).toEqual({ value: 170, missing: null, qualityFlags: [] });
    expect(extractPatientIdentityWeightKg(patientCase({ weight: 65.5 }))).toEqual({ value: 65.5, missing: null, qualityFlags: [] });
  });

  it('숫자로 파싱 가능한 문자열도 통과한다', () => {
    expect(extractPatientIdentityHeightCm(patientCase({ height: '170' }))).toEqual({ value: 170, missing: null, qualityFlags: [] });
  });

  it('미입력은 not_entered', () => {
    expect(extractPatientIdentityHeightCm(patientCase({}))).toEqual({ value: null, missing: 'not_entered', qualityFlags: [] });
  });

  it('0 이하는 물리적으로 불가능하므로 invalid', () => {
    expect(extractPatientIdentityHeightCm(patientCase({ height: 0 }))).toEqual({
      value: null,
      missing: 'not_entered',
      qualityFlags: ['invalid'],
    });
    expect(extractPatientIdentityWeightKg(patientCase({ weight: -5 }))).toEqual({
      value: null,
      missing: 'not_entered',
      qualityFlags: ['invalid'],
    });
  });

  it('배열 등 강제변환으로 우연히 통과시키지 않는다', () => {
    expect(extractPatientIdentityHeightCm(patientCase({ height: [170] }))).toEqual({
      value: null,
      missing: 'not_entered',
      qualityFlags: ['invalid'],
    });
  });
});

describe('extractPatientIdentityBirthDate/InjuryDate/EvaluationDate — case grain(filter_only, date 타입)', () => {
  it('정상 ISO 날짜는 그대로 통과', () => {
    expect(extractPatientIdentityBirthDate(patientCase({ birthDate: '1990-01-01' }))).toEqual({
      value: '1990-01-01',
      missing: null,
      qualityFlags: [],
    });
    expect(extractPatientIdentityInjuryDate(patientCase({ injuryDate: '2023-05-01' }))).toEqual({
      value: '2023-05-01',
      missing: null,
      qualityFlags: [],
    });
    expect(extractPatientIdentityEvaluationDate(patientCase({ evaluationDate: '2024-01-01' }))).toEqual({
      value: '2024-01-01',
      missing: null,
      qualityFlags: [],
    });
  });

  it('미입력은 not_entered', () => {
    expect(extractPatientIdentityBirthDate(patientCase({}))).toEqual({ value: null, missing: 'not_entered', qualityFlags: [] });
  });

  it('형식이 비정형이면(예: "2020/01/01") not_entered + invalid', () => {
    expect(extractPatientIdentityBirthDate(patientCase({ birthDate: '2020/01/01' }))).toEqual({
      value: null,
      missing: 'not_entered',
      qualityFlags: ['invalid'],
    });
  });

  it('배열로 감싼 유효 날짜여도 강제변환으로 통과시키지 않는다', () => {
    expect(extractPatientIdentityBirthDate(patientCase({ birthDate: ['1990-01-01'] }))).toEqual({
      value: null,
      missing: 'not_entered',
      qualityFlags: ['invalid'],
    });
  });
});

describe('extractPatientIdentityHighBloodPressure/Diabetes — case grain(원본 "유"/"무" → boolean)', () => {
  it('"유"는 true, "무"는 false', () => {
    expect(extractPatientIdentityHighBloodPressure(patientCase({ highBloodPressure: '유' }))).toEqual({
      value: true,
      missing: null,
      qualityFlags: [],
    });
    expect(extractPatientIdentityDiabetes(patientCase({ diabetes: '무' }))).toEqual({
      value: false,
      missing: null,
      qualityFlags: [],
    });
  });

  it('미입력은 not_entered', () => {
    expect(extractPatientIdentityHighBloodPressure(patientCase({}))).toEqual({ value: null, missing: 'not_entered', qualityFlags: [] });
  });

  it('"유"/"무" 도메인 밖 값(예: boolean true, "yes")은 not_entered + invalid — 강제변환 금지', () => {
    expect(extractPatientIdentityHighBloodPressure(patientCase({ highBloodPressure: true }))).toEqual({
      value: null,
      missing: 'not_entered',
      qualityFlags: ['invalid'],
    });
    expect(extractPatientIdentityDiabetes(patientCase({ diabetes: 'yes' }))).toEqual({
      value: null,
      missing: 'not_entered',
      qualityFlags: ['invalid'],
    });
  });
});
