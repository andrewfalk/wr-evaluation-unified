// Raw extractor — PR0-B4 Slice 5 신규 patient pseudo-module. shared.* 인적사항 8종을
// case grain에 그대로 노출한다(파생 계산 없음). activeModules 게이트가 없다 — 인적사항은
// 어느 임상 모듈이 활성이든 항상 shared에 존재하는 개념이라 knee.relatedness.max 등
// 기존 extractor의 "모듈 비활성 → structural_missing" 1단계가 적용되지 않는다.

import type { ExtractedValue, MigrationResult } from '../../types';
import { parseStrictIsoDate } from '../../dates';
import type { AnalysisPatient } from '../../migration/deterministicMigrate';

// null/undefined/공백 문자열만 "미입력"이다 — String(x)로 뭉뚱그리면 []나 [null]이
// 빈 문자열로 변환돼(String([])===''), 손상된 배열이 정상 미입력으로 둔갑한다(리뷰 지적).
// 배열·객체 등은 여기서 걸러내지 않고 각 필드의 typeof 검사로 넘겨 invalid로 잡는다.
function isBlank(x: unknown): boolean {
  if (x === null || x === undefined) return true;
  if (typeof x === 'string') return x.trim() === '';
  return false;
}

function getShared(migrationResult: MigrationResult<AnalysisPatient>): Record<string, unknown> {
  return (migrationResult.payload.data.shared as Record<string, unknown>) ?? {};
}

function extractPatientStringField(
  migrationResult: MigrationResult<AnalysisPatient>,
  field: string,
): ExtractedValue<string> {
  const raw = getShared(migrationResult)[field];
  if (isBlank(raw)) return { value: null, missing: 'not_entered', qualityFlags: [] };
  if (typeof raw !== 'string') return { value: null, missing: 'not_entered', qualityFlags: ['invalid'] };
  return { value: raw, missing: null, qualityFlags: [] };
}

export function extractPatientIdentityGender(migrationResult: MigrationResult<AnalysisPatient>): ExtractedValue<string> {
  return extractPatientStringField(migrationResult, 'gender');
}

function extractPatientNumericField(
  migrationResult: MigrationResult<AnalysisPatient>,
  field: string,
): ExtractedValue<number> {
  const raw = getShared(migrationResult)[field];
  if (isBlank(raw)) return { value: null, missing: 'not_entered', qualityFlags: [] };
  // typeof 먼저(강제형변환 우회 방지) — 배열 등이 Number()로 우연히 유효값이 되는 걸 막는다.
  if (typeof raw !== 'number' && typeof raw !== 'string') {
    return { value: null, missing: 'not_entered', qualityFlags: ['invalid'] };
  }
  const n = Number(raw);
  // 키/체중은 물리량이라 0 이하는 존재할 수 없다.
  if (!Number.isFinite(n) || n <= 0) {
    return { value: null, missing: 'not_entered', qualityFlags: ['invalid'] };
  }
  return { value: n, missing: null, qualityFlags: [] };
}

export function extractPatientIdentityHeightCm(migrationResult: MigrationResult<AnalysisPatient>): ExtractedValue<number> {
  return extractPatientNumericField(migrationResult, 'height');
}

export function extractPatientIdentityWeightKg(migrationResult: MigrationResult<AnalysisPatient>): ExtractedValue<number> {
  return extractPatientNumericField(migrationResult, 'weight');
}

function extractPatientDateField(
  migrationResult: MigrationResult<AnalysisPatient>,
  field: string,
): ExtractedValue<string> {
  const raw = getShared(migrationResult)[field];
  if (isBlank(raw)) return { value: null, missing: 'not_entered', qualityFlags: [] };
  if (typeof raw !== 'string' || !parseStrictIsoDate(raw)) {
    return { value: null, missing: 'not_entered', qualityFlags: ['invalid'] };
  }
  return { value: raw, missing: null, qualityFlags: [] };
}

export function extractPatientIdentityBirthDate(migrationResult: MigrationResult<AnalysisPatient>): ExtractedValue<string> {
  return extractPatientDateField(migrationResult, 'birthDate');
}

export function extractPatientIdentityInjuryDate(migrationResult: MigrationResult<AnalysisPatient>): ExtractedValue<string> {
  return extractPatientDateField(migrationResult, 'injuryDate');
}

export function extractPatientIdentityEvaluationDate(migrationResult: MigrationResult<AnalysisPatient>): ExtractedValue<string> {
  return extractPatientDateField(migrationResult, 'evaluationDate');
}

// highBloodPressure/diabetes — 원본은 select('유'/'무', BasicInfoForm.jsx). knee의
// confirmedStatus(confirmed/unconfirmed → boolean) 선례와 동일한 2상태 모델링.
function extractPatientYesNoField(
  migrationResult: MigrationResult<AnalysisPatient>,
  field: string,
): ExtractedValue<boolean> {
  const raw = getShared(migrationResult)[field];
  if (isBlank(raw)) return { value: null, missing: 'not_entered', qualityFlags: [] };
  if (raw === '유') return { value: true, missing: null, qualityFlags: [] };
  if (raw === '무') return { value: false, missing: null, qualityFlags: [] };
  return { value: null, missing: 'not_entered', qualityFlags: ['invalid'] };
}

export function extractPatientIdentityHighBloodPressure(
  migrationResult: MigrationResult<AnalysisPatient>,
): ExtractedValue<boolean> {
  return extractPatientYesNoField(migrationResult, 'highBloodPressure');
}

export function extractPatientIdentityDiabetes(migrationResult: MigrationResult<AnalysisPatient>): ExtractedValue<boolean> {
  return extractPatientYesNoField(migrationResult, 'diabetes');
}

// BMI — grain 단순화 개정 신규 추가. common.ts의 calculateBMI와 공식은 같지만(W/(H/100)²),
// 그 함수의 "결측 시 0 반환" UI 폴백은 쓰지 않는다 — height/weight가 이미 쓰는
// extractPatientNumericField(공백=not_entered, 손상값=invalid, 0 이하=invalid)를
// 그대로 재사용해 두 입력의 결측/손상 판정을 각각 받은 뒤 조합한다(계산 로직 재구현 금지 —
// 검증 규칙만 정확히 두 배 적용).
export function extractPatientIdentityBmi(migrationResult: MigrationResult<AnalysisPatient>): ExtractedValue<number> {
  const height = extractPatientNumericField(migrationResult, 'height');
  const weight = extractPatientNumericField(migrationResult, 'weight');

  // 손상값(공백이 아니라 진짜 잘못된 값)이 하나라도 있으면 그 정보를 보존한다 — 공백만
  // 있는 것처럼 조용히 넘기지 않는다.
  const anyInvalid = height.qualityFlags.includes('invalid') || weight.qualityFlags.includes('invalid');
  if (anyInvalid) {
    return { value: null, missing: 'not_entered', qualityFlags: ['invalid'] };
  }
  // 하나라도 공백(정상 미입력)이면 결측 — 나머지 하나가 정상이어도 계산 불가.
  if (height.missing !== null || weight.missing !== null) {
    return { value: null, missing: 'not_entered', qualityFlags: [] };
  }

  const heightM = (height.value as number) / 100;
  const bmi = (weight.value as number) / (heightM * heightM);
  if (!Number.isFinite(bmi) || bmi <= 0) {
    return { value: null, missing: 'not_entered', qualityFlags: ['invalid'] };
  }
  return { value: bmi, missing: null, qualityFlags: [] };
}
