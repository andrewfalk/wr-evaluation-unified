// Raw extractor — PR0-B4 Slice 5 신규 patient pseudo-module. shared.* 인적사항 8종을
// case grain에 그대로 노출한다(파생 계산 없음). activeModules 게이트가 없다 — 인적사항은
// 어느 임상 모듈이 활성이든 항상 shared에 존재하는 개념이라 knee.relatedness.max 등
// 기존 extractor의 "모듈 비활성 → structural_missing" 1단계가 적용되지 않는다.

import type { ExtractedValue, MigrationResult } from '../../types';
import { parseStrictIsoDate } from '../../dates';
import type { AnalysisPatient } from '../../migration/deterministicMigrate';

function isBlank(x: unknown): boolean {
  return x === null || x === undefined || String(x).trim() === '';
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
