// Raw extractor — wrist.assessment.burdenGradeMax 1개(§1-1). §1-1a 공통 0단계 + wrist 전용
// 우선순위(모듈 비활성 → 진단/직력 없음 → missing 필드 존재 → 정상 계산)를 구현한다.
// elbow와 동일한 이유로 burdenGradeMax(ordinal)를 처음부터 대표 변수로 채택한다(metadata.ts
// 주석 참고) — diagnosisSummaries[].burdenGrade 중 가장 심각한 등급을 case 값으로 롤업.

import type { ExtractedValue, MissingReason, MigrationResult, QualityFlag } from '../../types';
import { isPlainObject } from '../../migration/deterministicMigrate';
import { computeWristCalc, type WristDiagnosis, type WristDiagnosisEntry, type WristJobLike, type WristModuleShape } from './derived';
import { normalizeWristModuleData } from './legacyNormalize';
import { WRIST_BURDEN_GRADE_ORDER } from './metadata';
import type { AnalysisPatient } from '../../migration/deterministicMigrate';

function isBlank(x: unknown): boolean {
  return x === null || x === undefined || String(x).trim() === '';
}

// §1-1a 공통 0단계 숫자 파싱 규칙이 적용되는 원본 필드 4종(toNumber()로 읽는 값,
// computeDiagnosisFlags/getBk2101RepetitionPerHour가 사용).
const NUMERIC_ENTRY_FIELDS: Array<keyof WristDiagnosisEntry> = [
  'daily_exposure_hours',
  'shift_share_percent',
  'bk2101_cycle_seconds',
  'bk2101_repetition_per_hour',
];

export function extractWristBurdenGradeMax(
  migrationResult: MigrationResult<AnalysisPatient>,
): ExtractedValue<string> {
  const { payload } = migrationResult;

  // 순서 1(공통 0단계): 모듈 비활성 또는 data.modules.wrist가 plain object가 아님.
  const activeModules = payload.data.activeModules ?? [];
  const wristModule = (payload.data.modules as Record<string, unknown> | undefined)?.wrist;
  if (!activeModules.includes('wrist') || !isPlainObject(wristModule)) {
    const missing: MissingReason = 'structural_missing';
    return { value: null, missing, qualityFlags: [] };
  }

  const shared = (payload.data.shared as Record<string, unknown>) ?? {};
  const rawJobs = Array.isArray(shared.jobs) ? shared.jobs : [];
  const jobs = rawJobs.filter(isPlainObject) as unknown as WristJobLike[];
  const rawDiagnoses = Array.isArray(shared.diagnoses) ? shared.diagnoses : [];
  const diagnoses = rawDiagnoses.filter(isPlainObject) as unknown as WristDiagnosis[];

  const synced = normalizeWristModuleData(wristModule as WristModuleShape, jobs, diagnoses, activeModules);

  // 순서 2: 손목/손가락 진단이 없거나 직력 정보 자체가 없음.
  if (synced.wristDiagnoses.length === 0 || jobs.length === 0) {
    return { value: null, missing: 'not_entered', qualityFlags: [] };
  }

  const sanitizedShared = { ...shared, jobs, diagnoses };
  const result = computeWristCalc({ shared: sanitizedShared, module: synced.moduleData, activeModules });

  // 순서 3: 시간적 선후관계 공통 필드 미입력, 또는 어느 진단 entry든 필수 필드 미입력.
  const hasMissingDiagnosisFields = result.diagnosisSummaries.some((summary) => summary.missingFields.length > 0);
  if (result.missingCommonFields.length > 0 || hasMissingDiagnosisFields) {
    return { value: null, missing: 'not_entered', qualityFlags: [] };
  }

  // 순서 3b(공통 0단계 숫자 파싱, 정상 계산 경로에서만 부가): coercion 이전 원본 문자열을
  // 먼저 본다 — 비어있지 않은데 parseFloat가 NaN이면 invalid qualityFlag. 값 자체는 기존
  // 계산기(toNumber, ||0)와 동일하게 그대로 0으로 계산되도록 둔다(계산 로직 재구현 금지).
  const qualityFlagSet = new Set<QualityFlag>();
  for (const jobEvaluation of synced.moduleData.jobEvaluations) {
    for (const entry of jobEvaluation.diagnosisEntries || []) {
      for (const field of NUMERIC_ENTRY_FIELDS) {
        const raw = entry[field];
        if (isBlank(raw)) continue;
        if (!Number.isFinite(parseFloat(String(raw)))) {
          qualityFlagSet.add('invalid');
        }
      }
    }
  }

  // 순서 4: 정상 계산 — 이 case의 모든 job×진단 조합 중 가장 심각한 등급을 대표값으로 낸다.
  // diagnosisSummaries는 이 시점에 반드시 1개 이상 있다(순서 2에서 진단·직력 없음을 걸렀고,
  // 각 진단은 모든 job에 대해 요약을 만들므로).
  const worstGrade = result.diagnosisSummaries.reduce((worst, summary) => {
    const worstIndex = WRIST_BURDEN_GRADE_ORDER.indexOf(worst as (typeof WRIST_BURDEN_GRADE_ORDER)[number]);
    const currentIndex = WRIST_BURDEN_GRADE_ORDER.indexOf(summary.burdenGrade as (typeof WRIST_BURDEN_GRADE_ORDER)[number]);
    return currentIndex > worstIndex ? summary.burdenGrade : worst;
  }, result.diagnosisSummaries[0].burdenGrade);

  return { value: worstGrade, missing: null, qualityFlags: Array.from(qualityFlagSet) };
}
