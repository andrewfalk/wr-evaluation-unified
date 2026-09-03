// 서버 분석 경로 전용 결정적 마이그레이션. 클라이언트 UI용 src/core/utils/data.js의
// migratePatient는 건드리지 않는다 — 이건 그 함수의 이식이 아니라, `knee.relatedness.max`
// 계산에 필요한 최소 범위만 결정적으로(Date.now()/crypto.randomUUID() 없이) 재구현한 것.
// 계획서 §5(pr0-b1-transient-possum.md) 참고.

import { isValidStrictDateTime } from '../dates';
import { deterministicJobId } from './uuidv5';
import type { MigrationIssue, MigrationResult } from '../types';

export interface AnalysisJob {
  id: string;
  jobName: string;
  presetId: string | null;
  startDate: string;
  endDate: string;
  workPeriodOverride: string;
  workDaysPerYear: number;
}

export interface AnalysisKneeJobExtras {
  sharedJobId: string;
  weight: string;
  squatting: string;
  evidenceSources: unknown[];
  stairs: boolean;
  kneeTwist: boolean;
  startStop: boolean;
  tightSpace: boolean;
  kneeContact: boolean;
  jumpDown: boolean;
}

export interface AnalysisPatient {
  createdAt: string;
  data: {
    shared: Record<string, unknown> & { jobs?: AnalysisJob[] };
    modules: Record<string, unknown> & {
      knee?: Record<string, unknown> & { jobs?: unknown[]; jobExtras?: AnalysisKneeJobExtras[] };
      spine?: Record<string, unknown>;
    };
    activeModules: string[];
  };
  [key: string]: unknown;
}

export interface DeterministicMigrateOptions {
  caseId: string;
  createdAtFallbackIso: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * §5.1 처리 순서를 그대로 구현한다. `caseId`/`createdAtFallbackIso`가 계약을 위반하면
 * (§5.3) throw한다 — missing 값이 아니라 호출자 계약 위반이므로 조용히 넘어가지 않는다.
 */
export function deterministicMigrate(
  rawPayload: unknown,
  opts: DeterministicMigrateOptions,
): MigrationResult<AnalysisPatient> {
  if (!opts.caseId || typeof opts.caseId !== 'string') {
    throw new Error('deterministicMigrate: opts.caseId is required and must be a non-empty string');
  }
  if (!isValidStrictDateTime(opts.createdAtFallbackIso)) {
    throw new Error(
      'deterministicMigrate: opts.createdAtFallbackIso must be a strict RFC3339 timestamp with an explicit timezone (Z or ±HH:mm)',
    );
  }

  const issues: MigrationIssue[] = [];
  const raw: any = isPlainObject(rawPayload) ? rawPayload : {};
  const rawData: any = isPlainObject(raw.data) ? raw.data : {};

  // 1. createdAt 우선순위 3단계 — patient.createdAt → shared.evaluationDate → 폴백
  const createdAt: string = raw.createdAt || rawData.shared?.evaluationDate || opts.createdAtFallbackIso;

  // 2. 형태 판별 3-way(원본 migratePatient와 동일한 분기)
  let shared: Record<string, unknown>;
  let modules: Record<string, unknown>;
  let activeModules: string[];
  if (isPlainObject(rawData.modules) && Array.isArray(rawData.activeModules)) {
    // 이미 신형식
    shared = isPlainObject(rawData.shared) ? { ...rawData.shared } : {};
    modules = { ...rawData.modules };
    activeModules = rawData.activeModules;
  } else if (raw.moduleId && rawData.module !== undefined) {
    // 구형식 단일모듈 → 정규화
    shared = isPlainObject(rawData.shared) ? { ...rawData.shared } : {};
    modules = { [raw.moduleId]: rawData.module };
    activeModules = [raw.moduleId];
  } else {
    shared = isPlainObject(rawData.shared) ? { ...rawData.shared } : {};
    modules = isPlainObject(rawData.modules) ? { ...rawData.modules } : {};
    activeModules = Array.isArray(rawData.activeModules) ? rawData.activeModules : [];
  }

  // 3. shared.jobs가 truthy면(빈 배열 포함) 조기 반환 함정을 그대로 재현 —
  //    그 경우 modules.knee.jobs(레거시)가 있어도 손대지 않는다.
  if (!shared.jobs) {
    shared = { ...shared, jobs: [] as AnalysisJob[] };

    // 4. modules.knee.jobs(구형식) → shared.jobs + jobExtras 백필
    const kneeMod = modules.knee as Record<string, unknown> | undefined;
    const legacyKneeJobs = Array.isArray(kneeMod?.jobs) ? (kneeMod!.jobs as any[]) : [];
    if (legacyKneeJobs.length > 0) {
      const newJobs: AnalysisJob[] = [];
      const kneeExtras: AnalysisKneeJobExtras[] = [];
      legacyKneeJobs.forEach((kneeJob, index) => {
        const id: string = kneeJob?.id || deterministicJobId(opts.caseId, index);
        newJobs.push({
          id,
          jobName: kneeJob?.jobName || '',
          presetId: kneeJob?.presetId || null,
          startDate: kneeJob?.startDate || '',
          endDate: kneeJob?.endDate || '',
          workPeriodOverride: kneeJob?.workPeriodOverride || '',
          workDaysPerYear: 250,
        });
        kneeExtras.push({
          sharedJobId: id,
          weight: kneeJob?.weight || '',
          squatting: kneeJob?.squatting || '',
          evidenceSources: kneeJob?.evidenceSources || [],
          stairs: kneeJob?.stairs || false,
          kneeTwist: kneeJob?.kneeTwist || false,
          startStop: kneeJob?.startStop || false,
          tightSpace: kneeJob?.tightSpace || false,
          kneeContact: kneeJob?.kneeContact || false,
          jumpDown: kneeJob?.jumpDown || false,
        });
      });
      shared = { ...shared, jobs: newJobs };
      const { jobs: _legacyJobs, ...kneeModRest } = kneeMod as Record<string, unknown>;
      modules = { ...modules, knee: { ...kneeModRest, jobExtras: kneeExtras } };
    }

    // 5. 규칙 3을 안 탄 경로에서 새로 만든 shared.jobs가 비면 빈 필드 job 1개 보장
    if ((shared.jobs as AnalysisJob[]).length === 0) {
      shared = {
        ...shared,
        jobs: [
          {
            id: deterministicJobId(opts.caseId, 0),
            jobName: '',
            presetId: null,
            startDate: '',
            endDate: '',
            workPeriodOverride: '',
            workDaysPerYear: 250,
          },
        ],
      };
    }
  }

  // 6. modules.spine 레거시 직업 필드 감지 — 원본의 spine job 주입 로직은 구현하지 않고
  //    issue만 남긴다(§5.2). extractor가 이 issue를 보면 payload를 신뢰하지 않는다.
  const spineMod = modules.spine as Record<string, unknown> | undefined;
  if (
    spineMod &&
    (spineMod.jobName !== undefined ||
      spineMod.careerYears !== undefined ||
      spineMod.careerMonths !== undefined ||
      spineMod.workDaysPerYear !== undefined)
  ) {
    issues.push({ code: 'unsupported_legacy_spine_jobs' });
  }

  const payload: AnalysisPatient = {
    ...raw,
    createdAt,
    data: { shared, modules, activeModules },
  };

  return { payload, issues };
}
