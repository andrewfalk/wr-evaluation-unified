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
  extractPatientIdentityBmi,
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

  // 리뷰 지적 회귀 — String([])===''이라 isBlank가 손상된 빈 배열을 정상 미입력으로
  // 오판했었다. [170]처럼 내용이 있는 배열은 이미 위에서 잡혔지만, 빈 배열·[null]처럼
  // String() 변환 결과가 빈 문자열이 되는 경우는 별도로 확인해야 한다.
  it('빈 배열·[null]처럼 String() 변환 시 빈 문자열이 되는 손상값도 invalid로 잡는다(공백과 구분)', () => {
    expect(extractPatientIdentityHeightCm(patientCase({ height: [] }))).toEqual({
      value: null,
      missing: 'not_entered',
      qualityFlags: ['invalid'],
    });
    expect(extractPatientIdentityWeightKg(patientCase({ weight: [null] }))).toEqual({
      value: null,
      missing: 'not_entered',
      qualityFlags: ['invalid'],
    });
  });
});

describe('extractPatientIdentityBmi — case grain(파생, height×weight 조합)', () => {
  it('둘 다 정상이면 체질량지수를 계산한다(W / (H/100)²)', () => {
    const result = extractPatientIdentityBmi(patientCase({ height: 170, weight: 63.665 }));
    expect(result.missing).toBeNull();
    expect(result.qualityFlags).toEqual([]);
    expect(result.value).toBeCloseTo(22.03, 1);
  });

  it('둘 다 미입력이면 not_entered(무플래그)', () => {
    expect(extractPatientIdentityBmi(patientCase({}))).toEqual({ value: null, missing: 'not_entered', qualityFlags: [] });
  });

  it('하나만 미입력이면(나머지는 정상) 계산 불가로 not_entered(무플래그) — invalid 아님', () => {
    expect(extractPatientIdentityBmi(patientCase({ height: 170 }))).toEqual({ value: null, missing: 'not_entered', qualityFlags: [] });
    expect(extractPatientIdentityBmi(patientCase({ weight: 65 }))).toEqual({ value: null, missing: 'not_entered', qualityFlags: [] });
  });

  it('하나 이상 손상값(공백 아님)이면 invalid를 보존한다 — 공백처럼 조용히 넘기지 않는다', () => {
    expect(extractPatientIdentityBmi(patientCase({ height: [170], weight: 65 }))).toEqual({
      value: null,
      missing: 'not_entered',
      qualityFlags: ['invalid'],
    });
    expect(extractPatientIdentityBmi(patientCase({ height: 0, weight: 65 }))).toEqual({
      value: null,
      missing: 'not_entered',
      qualityFlags: ['invalid'],
    });
  });

  it('공백 하나 + 손상값 하나 — invalid를 보존한다(공백만 있는 것처럼 뭉개지 않는다)', () => {
    // 리뷰 지적 — height:[]는 isBlank([])가 아니라 numeric field의 typeof 검사에서
    // 곧바로 invalid로 잡히므로 "손상값+정상값" 조합이지 "공백+손상"이 아니었다.
    // 진짜 공백(height:'')과 진짜 손상값(weight:[])을 각각 하나씩 넣어야 한다.
    expect(extractPatientIdentityBmi(patientCase({ height: '', weight: [] }))).toEqual({
      value: null,
      missing: 'not_entered',
      qualityFlags: ['invalid'],
    });
  });

  it('계산 결과가 비유한이거나 0 이하면 invalid(경계값 — 실제로 도달 가능함, 극단값으로 재현)', () => {
    // 리뷰 지적 — "이 분기는 도달 불가능하다"는 이전 주석이 틀렸다. height가 물리적으로는
    // 0 이하가 걸러지지만, 극단적으로 작은/큰 양수는 여전히 통과하고 나눗셈 과정에서
    // 부동소수점 언더플로/오버플로로 Infinity·0을 만들 수 있다.
    // height=1e-200(극소): heightM²=1e-404가 배정밀도 최솟값 밑으로 언더플로해 0이
    // 되고, weight/0=Infinity → !Number.isFinite(bmi) 분기.
    expect(extractPatientIdentityBmi(patientCase({ height: 1e-200, weight: 70 }))).toEqual({
      value: null,
      missing: 'not_entered',
      qualityFlags: ['invalid'],
    });
    // height=1e200(극대): heightM²=1e396이 배정밀도 최댓값을 넘어 오버플로해
    // Infinity가 되고, weight/Infinity=0 → bmi<=0 분기.
    expect(extractPatientIdentityBmi(patientCase({ height: 1e200, weight: 70 }))).toEqual({
      value: null,
      missing: 'not_entered',
      qualityFlags: ['invalid'],
    });
  });

  it('통상 범위를 벗어난 큰 값이어도 유한 양수 결과면 정상 계산된다(경계값과 구분)', () => {
    const result = extractPatientIdentityBmi(patientCase({ height: 300, weight: 500 }));
    expect(result.missing).toBeNull();
    expect(result.qualityFlags).toEqual([]);
    expect(Number.isFinite(result.value)).toBe(true);
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
