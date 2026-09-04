// Raw extractor — shoulder.exposure.anyExceeded 1개 변수(§1-1). §1-1a 공통 0단계 +
// shoulder 전용 우선순위(모듈 비활성 → shared.jobs 비어있음 → 정상 계산)를 구현한다.

import type { ExtractedValue, MissingReason, MigrationResult, QualityFlag } from '../../types';
import { isPlainObject } from '../../migration/deterministicMigrate';
import { computeShoulderCalc, type ShoulderJobExtras } from './derived';
import type { AnalysisPatient } from '../../migration/deterministicMigrate';

function isBlank(x: unknown): boolean {
  return x === null || x === undefined || String(x).trim() === '';
}

// §1-1a 공통 0단계 숫자 파싱 규칙이 적용되는 원본 필드 6종(computeJobExposures가 읽는 값).
const NUMERIC_EXTRA_FIELDS: Array<keyof ShoulderJobExtras> = [
  'overheadHours',
  'repetitiveMediumHours',
  'repetitiveFastHours',
  'heavyLoadCount',
  'heavyLoadSeconds',
  'vibrationHours',
];

export function extractShoulderExposureAnyExceeded(
  migrationResult: MigrationResult<AnalysisPatient>,
): ExtractedValue<boolean> {
  const { payload } = migrationResult;

  // 순서 1(공통 0단계): 모듈 비활성 또는 data.modules.shoulder가 plain object가 아님.
  const activeModules = payload.data.activeModules ?? [];
  const shoulderModule = (payload.data.modules as Record<string, unknown> | undefined)?.shoulder;
  if (!activeModules.includes('shoulder') || !isPlainObject(shoulderModule)) {
    const missing: MissingReason = 'structural_missing';
    return { value: null, missing, qualityFlags: [] };
  }

  // 순서 2: shared.jobs 비어있음 → 직업 정보 자체가 없음.
  const shared = (payload.data.shared as Record<string, unknown>) ?? {};
  const jobs = Array.isArray(shared.jobs) ? (shared.jobs as Array<Record<string, unknown>>) : [];
  if (jobs.length === 0) {
    return { value: null, missing: 'not_entered', qualityFlags: [] };
  }

  // 순서 3(공통 0단계 숫자 파싱): coercion 이전 원본 문자열을 먼저 본다 — 비어있지 않은데
  // parseFloat가 NaN이면 invalid qualityFlag. 값 자체는 기존 계산기(parseFloat(x)||0)와
  // 동일하게 그대로 0으로 계산되도록 둔다(계산 로직 재구현 금지).
  const jobExtras = Array.isArray((shoulderModule as { jobExtras?: unknown }).jobExtras)
    ? ((shoulderModule as { jobExtras?: ShoulderJobExtras[] }).jobExtras as ShoulderJobExtras[])
    : [];
  const qualityFlagSet = new Set<QualityFlag>();
  for (const job of jobs) {
    const extra = jobExtras.find((e) => e.sharedJobId === job.id) ?? {};
    for (const field of NUMERIC_EXTRA_FIELDS) {
      const raw = extra[field];
      if (isBlank(raw)) continue;
      if (!Number.isFinite(parseFloat(String(raw)))) {
        qualityFlagSet.add('invalid');
      }
    }
  }

  // 순서 4: 정상 계산 — 필터링 없이 원본 배열 그대로 computeShoulderCalc에 넘긴다(UI와 동일 값).
  const result = computeShoulderCalc({ shared, module: shoulderModule });
  return { value: result.anyExceeded, missing: null, qualityFlags: Array.from(qualityFlagSet) };
}
