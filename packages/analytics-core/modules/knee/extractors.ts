// Raw extractor — knee.relatedness.max 1개 변수(§4). 계획서 §4.2~4.3의 job 3분류와
// 결측 우선순위를 그대로 구현한다.

import type { ExtractedValue, MissingReason, MigrationResult, QualityFlag } from '../../types';
import { parseStrictIsoDate, compareDate, calculateAgeStrict } from '../../dates';
import { parseWorkPeriodOverride } from '../../workPeriod';
import { resolveKneeCalculationJobs, computeKneeCalc, type KneeCalculationJob } from './derived';
import type { AnalysisPatient } from '../../migration/deterministicMigrate';

export function isBlank(x: unknown): boolean {
  return x === null || x === undefined || String(x).trim() === '';
}

/** parseFloat가 아니라 Number — "12kg"·"30minutes"처럼 숫자 접두부만 있는 문자열을 유효로 오인하지 않는다.
 * UI input이 min="0"(JobTab.jsx)이라 음수도 거부해 UI와 일치시킨다. */
export function parseNonNegativeNumber(x: unknown): number | null {
  if (isBlank(x)) return null;
  const parsed = Number(String(x).trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function isValidPositivePeriod(job: KneeCalculationJob): boolean {
  const override = job.workPeriodOverride;
  if (!isBlank(override)) {
    return parseWorkPeriodOverride(String(override)) > 0;
  }
  const { startDate, endDate } = job;
  if (isBlank(startDate) || isBlank(endDate)) return false;
  const s = parseStrictIsoDate(String(startDate));
  const e = parseStrictIsoDate(String(endDate));
  if (!s || !e) return false;
  return compareDate(e, s) > 0;
}

export type JobClassification = 'empty' | 'complete' | 'partial';

/** §4.2 — 원본 필드 입력 여부로 판정한다(계산된 기간이 아니라). */
export function classifyKneeJob(job: KneeCalculationJob): JobClassification {
  const noPeriodInput = isBlank(job.workPeriodOverride) && isBlank(job.startDate) && isBlank(job.endDate);
  const noExposureInput = isBlank(job.weight) && isBlank(job.squatting);
  if (noPeriodInput && noExposureInput) return 'empty';

  const complete =
    isValidPositivePeriod(job) &&
    parseNonNegativeNumber(job.weight) !== null &&
    parseNonNegativeNumber(job.squatting) !== null;
  return complete ? 'complete' : 'partial';
}

/** §4.3 결측 우선순위를 그대로 구현한다. */
export function extractKneeRelatednessMax(
  migrationResult: MigrationResult<AnalysisPatient>,
): ExtractedValue<number> {
  const { payload, issues } = migrationResult;

  // 순서 1: unsupported_legacy_spine_jobs — payload는 이 시점 이후 참조하지 않는다.
  if (issues.some((issue) => issue.code === 'unsupported_legacy_spine_jobs')) {
    const qualityFlags: QualityFlag[] = ['legacy_unknown'];
    return { value: null, missing: 'not_assessed', qualityFlags };
  }

  // 순서 2: 무릎 모듈 비활성
  const activeModules = payload.data.activeModules ?? [];
  const kneeModule = payload.data.modules?.knee;
  if (!activeModules.includes('knee') || !kneeModule) {
    const missing: MissingReason = 'structural_missing';
    return { value: null, missing, qualityFlags: [] };
  }

  const shared = payload.data.shared ?? {};
  const birthDate = (shared as Record<string, unknown>).birthDate;
  const injuryDate = (shared as Record<string, unknown>).injuryDate;
  const hadBirthDate = !isBlank(birthDate);
  const hadInjuryDate = !isBlank(injuryDate);

  // 순서 3: strict 날짜 검증(형식 실패·없음·음수 나이 전부 포함)
  const age =
    hadBirthDate && hadInjuryDate ? calculateAgeStrict(String(birthDate), String(injuryDate)) : null;
  if (age === null) {
    const qualityFlags: QualityFlag[] = hadBirthDate && hadInjuryDate ? ['invalid'] : [];
    return { value: null, missing: 'not_entered', qualityFlags };
  }

  // 순서 4: 30세 이하는 업무관련성 공식이 정의되지 않는 사업 규칙(조기 반환)
  if (age <= 30) {
    return { value: null, missing: 'not_applicable', qualityFlags: [] };
  }

  // resolveKneeCalculationJobs로 computeKneeCalc와 정확히 같은 배열을 검사한다(§3.1).
  const jobs = resolveKneeCalculationJobs(shared as any, kneeModule as any);
  const classifications = jobs.map(classifyKneeJob);

  // 순서 5: partial job이 하나라도 있으면 전체 not_entered
  if (classifications.includes('partial')) {
    return { value: null, missing: 'not_entered', qualityFlags: [] };
  }

  // 순서 6: complete job이 0개(전부 empty)
  if (!classifications.includes('complete')) {
    return { value: null, missing: 'not_entered', qualityFlags: [] };
  }

  // 순서 7: 정상 계산 — 필터링 없이 원본 배열 그대로 computeKneeCalc에 넘긴다(UI와 동일 값).
  const result = computeKneeCalc({ shared: shared as any, module: kneeModule as any });
  return { value: Number(result.relatedness.max), missing: null, qualityFlags: [] };
}
