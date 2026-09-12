// PR0-B3 Part A — grain별 canonical entity enumerator. 변수 extractor와 무관하게 그
// grain의 "행 모집단"을 결정하는 단일 진실원(계획 pr0-b3-shimmying-magpie.md "핵심
// 아키텍처" 절) — 모든 반복 grain 변수는 이 목록을 1:1 map()으로만 순회해야 한다.

import { isPlainObject } from './migration/deterministicMigrate';
import type { AnalysisPatient } from './migration/deterministicMigrate';
import type { GrainEntity, MigrationResult, QualityFlag } from './types';
import type { SpineJobLike, SpineModuleShape } from './modules/spine/types';
import type { SpineVibrationInterval } from './modules/spine/vibration';
import type { SpineTask } from './modules/spine/mddm';
import type { DiagnosisLike } from './diagnosisMapping';
import type { JobLike } from './workPeriod';

function isBlank(x: unknown): boolean {
  return x === null || x === undefined || String(x).trim() === '';
}

// 결측/중복 id를 유일해질 때까지 결정적으로 보정한다(원본 배열 index 기반 — case ID나
// Math.random()에 의존하지 않아 같은 payload에 대해 항상 같은 결과를 낸다). 중복이
// 보정된 id끼리 다시 충돌하는 경우(예: 원본에 'a'/'a#2'/'a'가 섞여 있음)까지 방어한다.
function resolveUniqueLocalId(rawId: unknown, index: number, seenIds: Set<string>): { id: string; flags: QualityFlag[] } {
  const flags: QualityFlag[] = [];
  let id: string | null = null;
  if (typeof rawId === 'string' && rawId !== '') id = rawId;
  else if (typeof rawId === 'number' && Number.isFinite(rawId)) id = String(rawId);

  if (id === null) {
    id = `__missing_${index}`;
    flags.push('invalid');
  }
  if (seenIds.has(id)) {
    flags.push('invalid');
    let suffix = 0;
    let candidate = id;
    while (seenIds.has(candidate)) {
      suffix += 1;
      candidate = `${id}#${suffix}`;
    }
    id = candidate;
  }
  seenIds.add(id);
  return { id, flags };
}

// canonical 목록 자체의 entityKey 유일성을 자체 검증한다 — extractor 출력과의 길이/집합
// 비교만으로는 enumerator가 처음부터 중복 키를 내놓는 경우(위 보정 로직의 결함)를 못 잡는다.
function assertUniqueEntityKeys<TSource>(entities: GrainEntity<TSource>[], grainLabel: string): void {
  const seen = new Set<string>();
  for (const entity of entities) {
    const serialized = JSON.stringify(entity.entityKey);
    if (seen.has(serialized)) {
      throw new Error(`${grainLabel} enumerator가 중복 entityKey를 반환했다: ${serialized}`);
    }
    seen.add(serialized);
  }
}

/**
 * vibration_interval grain(§2 키: (case, jobId, intervalId)) 엔터티 열거. spine 모듈이
 * 비활성이거나 데이터가 없으면 빈 배열(그 case는 이 grain에서 관측 행 0개) — case grain
 * extractor의 structural_missing/not_assessed 판정과 달리, 반복 grain은 "행이 없다"로
 * 표현한다(§11 "grain 행 수는 fixture별 exact count로 검증" 요구와 일치).
 */
export function enumerateVibrationIntervalEntities(
  mr: MigrationResult<AnalysisPatient>,
): GrainEntity<SpineVibrationInterval>[] {
  const { payload } = mr;
  const activeModules = payload.data.activeModules ?? [];
  const spineModule = (payload.data.modules as Record<string, unknown> | undefined)?.spine;
  if (!activeModules.includes('spine') || !isPlainObject(spineModule)) return [];

  const shared = (payload.data.shared as Record<string, unknown>) ?? {};
  const rawJobs = Array.isArray(shared.jobs) ? shared.jobs : [];
  const jobs = rawJobs.filter(isPlainObject) as unknown as SpineJobLike[];
  const jobIds = new Set(jobs.map((j) => j.id).filter((id): id is string => typeof id === 'string' && id !== ''));
  const firstJobId = jobs.length > 0 && typeof jobs[0].id === 'string' ? jobs[0].id : '';

  const rawIntervals = Array.isArray((spineModule as { vibrationIntervals?: unknown }).vibrationIntervals)
    ? (spineModule as { vibrationIntervals?: unknown[] }).vibrationIntervals!
    : [];
  const intervals = rawIntervals.filter(isPlainObject) as unknown as SpineVibrationInterval[];

  const out: GrainEntity<SpineVibrationInterval>[] = [];
  const seenIds = new Set<string>();
  intervals.forEach((interval, index) => {
    const { id, flags } = resolveUniqueLocalId(interval.id, index, seenIds);

    // groupIntervalsByJob(vibration.ts)과 동일한 job 귀속 규칙 — sharedJobId가 있으면
    // 그 job, 없으면 첫 직력에 귀속(원본 계산 동작 그대로). 참조가 존재하지 않는 jobId를
    // 가리키면 orphan_reference로 표시하되 엔터티 자체는 그대로 만든다(값 판정은
    // extractor가 함, 엔터티 존재 여부는 원본 저장 데이터 그대로 반영).
    const rawSharedJobId = typeof interval.sharedJobId === 'string' ? interval.sharedJobId : '';
    const resolvedJobId = rawSharedJobId || firstJobId;
    if (rawSharedJobId && !jobIds.has(rawSharedJobId)) flags.push('orphan_reference');

    out.push({ entityKey: [resolvedJobId, id], source: interval, qualityFlags: flags });
  });

  assertUniqueEntityKeys(out, 'vibration_interval');
  return out;
}

/**
 * task grain(§2 키: (case, jobId, taskId)) 엔터티 열거. vibration_interval과 정확히 같은
 * job 귀속 규칙(sharedJobId 우선, 없으면 첫 직력)과 orphan_reference 판정을 공유한다 — 두
 * grain 모두 spine 모듈의 하위 반복 컬렉션이라 같은 계약을 따른다.
 */
export function enumerateTaskEntities(mr: MigrationResult<AnalysisPatient>): GrainEntity<SpineTask>[] {
  const { payload } = mr;
  const activeModules = payload.data.activeModules ?? [];
  const spineModule = (payload.data.modules as Record<string, unknown> | undefined)?.spine;
  if (!activeModules.includes('spine') || !isPlainObject(spineModule)) return [];

  const shared = (payload.data.shared as Record<string, unknown>) ?? {};
  const rawJobs = Array.isArray(shared.jobs) ? shared.jobs : [];
  const jobs = rawJobs.filter(isPlainObject) as unknown as SpineJobLike[];
  const jobIds = new Set(jobs.map((j) => j.id).filter((id): id is string => typeof id === 'string' && id !== ''));
  const firstJobId = jobs.length > 0 && typeof jobs[0].id === 'string' ? jobs[0].id : '';

  const rawTasks = Array.isArray((spineModule as { tasks?: unknown }).tasks)
    ? (spineModule as { tasks?: unknown[] }).tasks!
    : [];
  const tasks = rawTasks.filter(isPlainObject) as unknown as SpineTask[];

  const out: GrainEntity<SpineTask>[] = [];
  const seenIds = new Set<string>();
  tasks.forEach((task, index) => {
    const { id, flags } = resolveUniqueLocalId(task.id, index, seenIds);

    const rawSharedJobId = typeof task.sharedJobId === 'string' ? task.sharedJobId : '';
    const resolvedJobId = rawSharedJobId || firstJobId;
    if (rawSharedJobId && !jobIds.has(rawSharedJobId)) flags.push('orphan_reference');

    out.push({ entityKey: [resolvedJobId, id], source: task, qualityFlags: flags });
  });

  assertUniqueEntityKeys(out, 'task');
  return out;
}

// diagnosis_side grain(§2 키: (case, diagnosisId, side)) 엔터티의 원본 참조 — extractor가
// side를 다시 판정하지 않고 이 shape을 그대로 쓴다(§핵심 아키텍처 "엔터티가 원본 참조를
// 담는다" 원칙, Part A vibration_interval과 동일한 설계).
export interface DiagnosisSideSource {
  diagnosis: DiagnosisLike & Record<string, unknown>;
  side: 'right' | 'left' | 'unspecified';
}

/**
 * diagnosis_side grain 엔터티 열거. `shared.diagnoses[]`의 각 진단을 side별로 explode한다
 * (side==='both'면 right/left 두 엔터티, side가 'right'/'left'면 그 하나, 그 외(공백 등)는
 * 'unspecified' 하나 — 값 판정은 extractor 몫이므로 여기서 드롭하지 않는다).
 *
 * code/name이 둘 다 공백인 진단은 실제 진단이 아니라 UI가 "진단 추가" 클릭만으로 만드는 빈
 * placeholder 행이므로 엔터티를 만들지 않는다(createDiagnosis() 기본값, src/core/utils/data.js).
 * 이 규칙은 실제 운영 데이터로 아직 검증하지 않았다 — Part B 착수 시 계획서가 요구한
 * "실제 데이터에서 side 공백 진단 실태 조회"는 이 세션에 DB 접근이 없어 수행하지 못했다.
 */
export function enumerateDiagnosisSideEntities(
  mr: MigrationResult<AnalysisPatient>,
): GrainEntity<DiagnosisSideSource>[] {
  const shared = (mr.payload.data.shared as Record<string, unknown>) ?? {};
  const rawDiagnoses = Array.isArray(shared.diagnoses) ? shared.diagnoses : [];
  const diagnoses = rawDiagnoses.filter(isPlainObject) as unknown as Array<DiagnosisLike & Record<string, unknown>>;

  const out: GrainEntity<DiagnosisSideSource>[] = [];
  const seenIds = new Set<string>();

  diagnoses.forEach((dx, index) => {
    if (isBlank(dx.code) && isBlank(dx.name)) return; // 빈 placeholder — 엔터티를 만들지 않음

    const { id, flags } = resolveUniqueLocalId(dx.id, index, seenIds);

    const sides: Array<'right' | 'left' | 'unspecified'> =
      dx.side === 'both' ? ['right', 'left'] : dx.side === 'right' || dx.side === 'left' ? [dx.side] : ['unspecified'];

    for (const side of sides) {
      out.push({ entityKey: [id, side], source: { diagnosis: dx, side }, qualityFlags: flags });
    }
  });

  assertUniqueEntityKeys(out, 'diagnosis_side');
  return out;
}

// job grain(§2 키: (case, jobId)) 엔터티의 원본 참조 — createSharedJob()이 만드는 필드
// 전부를 그대로 들고 다닌다(JobLike는 getEffectiveWorkPeriod 등 기존 유틸이 요구하는
// 최소 필드셋일 뿐, 실제 원본 필드는 이보다 많다).
export type JobEntitySource = JobLike & Record<string, unknown>;

/**
 * job grain 엔터티 열거. `shared.jobs[]`는 어떤 모듈이 활성인지와 무관하게 항상 존재하는
 * 공유 필드다(diagnosis_side와 동일한 이유로 activeModules를 검사하지 않는다 — 직업력은
 * 모듈에 속하지 않는다).
 *
 * jobName·startDate·endDate·workPeriodOverride가 전부 공백인 job은 createSharedJob()의
 * 순수 기본값(사용자가 "직력 추가"만 누르고 아무것도 안 채운 상태)이라 실제 직력이 아니다
 * — diagnosis_side의 code/name 둘 다 공백 규칙과 동일한 판단으로 엔터티를 만들지 않는다.
 */
export function enumerateJobEntities(mr: MigrationResult<AnalysisPatient>): GrainEntity<JobEntitySource>[] {
  const shared = (mr.payload.data.shared as Record<string, unknown>) ?? {};
  const rawJobs = Array.isArray(shared.jobs) ? shared.jobs : [];
  const jobs = rawJobs.filter(isPlainObject) as unknown as JobEntitySource[];

  const out: GrainEntity<JobEntitySource>[] = [];
  const seenIds = new Set<string>();

  jobs.forEach((job, index) => {
    const isPlaceholder =
      isBlank(job.jobName) && isBlank(job.startDate) && isBlank(job.endDate) && isBlank(job.workPeriodOverride);
    if (isPlaceholder) return;

    const { id, flags } = resolveUniqueLocalId(job.id, index, seenIds);
    out.push({ entityKey: [id], source: job, qualityFlags: flags });
  });

  assertUniqueEntityKeys(out, 'job');
  return out;
}
