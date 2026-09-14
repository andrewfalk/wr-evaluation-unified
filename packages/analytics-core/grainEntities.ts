// PR0-B3 Part A — grain별 canonical entity enumerator. 변수 extractor와 무관하게 그
// grain의 "행 모집단"을 결정하는 단일 진실원(계획 pr0-b3-shimmying-magpie.md "핵심
// 아키텍처" 절) — 모든 반복 grain 변수는 이 목록을 1:1 map()으로만 순회해야 한다.

import { isPlainObject } from './migration/deterministicMigrate';
import type { AnalysisPatient } from './migration/deterministicMigrate';
import type { GrainEntity, MigrationResult, QualityFlag } from './types';
import type { SpineJobLike, SpineModuleShape } from './modules/spine/types';
import type { SpineVibrationInterval } from './modules/spine/vibration';
import type { SpineTask } from './modules/spine/mddm';
import type { CervicalTask, CervicalJobLike } from './modules/cervical/legacyNormalize';
import { normalizeElbowModuleData } from './modules/elbow/legacyNormalize';
import type { ElbowDiagnosis, ElbowJobLike, ElbowModuleShape } from './modules/elbow/legacyNormalize';
import { normalizeWristModuleData } from './modules/wrist/legacyNormalize';
import type { WristDiagnosis, WristJobLike, WristModuleShape } from './modules/wrist/legacyNormalize';
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

/**
 * cervical_task grain(§2 키: (case, jobId, taskId)) 엔터티 열거. spine의 task grain과
 * 정확히 같은 job 귀속 규칙(sharedJobId 우선, 없으면 첫 직력)과 orphan_reference 판정을
 * 공유하지만, spine의 `task` grain과는 별도 grain이다(PR0-B4 Slice 7 — "spine task와
 * 완전 분리" 계획 결정) — 두 모듈의 작업 목록은 서로 다른 개념이라 같은 grain으로
 * 묶으면 entityKey가 우연히 같은 (jobId, taskId) 조합을 가리키는 서로 다른 작업을
 * 혼동시킬 위험이 있다.
 */
export function enumerateCervicalTaskEntities(mr: MigrationResult<AnalysisPatient>): GrainEntity<CervicalTask>[] {
  const { payload } = mr;
  const activeModules = payload.data.activeModules ?? [];
  const cervicalModule = (payload.data.modules as Record<string, unknown> | undefined)?.cervical;
  if (!activeModules.includes('cervical') || !isPlainObject(cervicalModule)) return [];

  const shared = (payload.data.shared as Record<string, unknown>) ?? {};
  const rawJobs = Array.isArray(shared.jobs) ? shared.jobs : [];
  const jobs = rawJobs.filter(isPlainObject) as unknown as CervicalJobLike[];
  const jobIds = new Set(jobs.map((j) => j.id).filter((id): id is string => typeof id === 'string' && id !== ''));
  const firstJobId = jobs.length > 0 && typeof jobs[0].id === 'string' ? jobs[0].id : '';

  const rawTasks = Array.isArray((cervicalModule as { tasks?: unknown }).tasks)
    ? (cervicalModule as { tasks?: unknown[] }).tasks!
    : [];
  const tasks = rawTasks.filter(isPlainObject) as unknown as CervicalTask[];

  const out: GrainEntity<CervicalTask>[] = [];
  const seenIds = new Set<string>();
  tasks.forEach((task, index) => {
    const { id, flags } = resolveUniqueLocalId(task.id, index, seenIds);

    const rawSharedJobId = typeof task.sharedJobId === 'string' ? task.sharedJobId : '';
    const resolvedJobId = rawSharedJobId || firstJobId;
    if (rawSharedJobId && !jobIds.has(rawSharedJobId)) flags.push('orphan_reference');

    out.push({ entityKey: [resolvedJobId, id], source: task, qualityFlags: flags });
  });

  assertUniqueEntityKeys(out, 'cervical_task');
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

// job_diagnosis grain(§2 키: (case, jobId, diagnosisId)) 엔터티 원본 참조 — PR0-B4 Slice
// 8b. elbow/wrist 두 모듈이 공유하는 단일 grain이라 source에 moduleId를 담아, 각 모듈
// 전용 extractor가 다른 모듈 origin entity를 받으면 not_applicable을 반환하도록 강제한다
// (§job_diagnosis 계약 "elbow/wrist 공유 모집단" 절). entry는 정규화된 엔트리
// (normalizeElbowModuleData/normalizeWristModuleData의 출력)라 exposure_types 등은 이미
// 배열 여부·옵션값이 보정된 상태다 — exposure_types는 계약 문서가 "손상값 invalid
// 플래그"를 저위험으로 격하해도 된다고 명시했지만(행 포함 판정에 더 이상 raw 조회가
// 필요 없음), BK 다중선택 필드(bk2105/2106_pressure_source 등)는 계약을 그대로 적용해야
// 해서 정규화가 `_corruptedArrayFields` 마커를 entry에 남겨 손상 여부를 보존한다
// (§Slice 8c 리뷰 지적 — legacyNormalize.ts의 normalizeDiagnosisEntry 참고).
export interface JobDiagnosisCommonEntry {
  diagnosisId?: string;
  selectedBkType?: string;
  bkSelectionMode?: string;
  bkAutoSyncedFrom?: string;
  main_task_name?: string;
  direct_anatomic_link?: string;
  exposure_types?: string[];
  repetition_level?: string;
  force_level?: string;
  awkward_posture_level?: string;
  work_pattern?: string;
  rest_distribution?: string;
  daily_exposure_hours?: string | number;
  shift_share_percent?: string | number;
  days_per_week?: string | number;
  [key: string]: unknown;
}

export interface JobDiagnosisSource {
  moduleId: 'elbow' | 'wrist';
  entry: JobDiagnosisCommonEntry;
}

// 값 계산 단계에서 프로덕션이 여전히 내부적으로 `${sharedJobId}:${diagnosisId}` 콜론
// 결합 키를 쓴다(레거시 병합 로직 자체, legacyNormalize.ts의 buildLegacyEntryMap) —
// entityKey는 배열이라 안전해도, 그 값을 만들어내는 프로덕션 로직 내부는 여전히 이
// 충돌에 노출될 수 있어 애초에 ':' 포함 id를 분석 대상에서 제외한다.
function isUsableEntityId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && !id.includes(':');
}

// 11차 검토 P2 재현 — 10차 수정은 firstJobId가 "위험할 때만" linkedJobId 없는 항목을
// 걸렀을 뿐, (1) linkedJobId가 명시돼 있어도 그 값 자체의 타입/형식은 전혀 검사하지
// 않았고 (2) diagnosisId는 아예 검사 대상이 아니었다. buildLegacyEntryMap이
// `${sharedJobId}:${diagnosisId}` 문자열 템플릿으로 키를 만드는 한, 숫자 linkedJobId나
// 숫자 diagnosisId도 문자열 job/진단 id와 똑같이 충돌할 수 있다(예: linkedJobId:123 →
// 문자열 '123' 직력과 충돌, diagnosisId:7 → 문자열 '7' 진단과 충돌).
//
// 13차 검토 P2 재현 — 11차 수정은 `record.linkedJobId || firstJobId`로 effectiveJobId를
// 구했는데, `||`는 0·false처럼 "값은 있지만 falsy인" 손상 타입도 "미입력"과 똑같이
// 취급해 firstJobId로 조용히 재위임해버린다. buildLegacyEntryMap 자체도 같은 `||`를
// 쓰지만(재구현 금지 대상, 프로덕션 계산 로직) 우리 쪽 사전 검증(sanitize)은 그 결함을
// 그대로 물려받으면 안 된다 — "진짜 미입력"(undefined/null/빈 문자열, legacyNormalize.ts
// 의 폴백이 의도한 자연스러운 상태)과 "명시적으로 값이 있지만 타입이 손상됨"(0·false·
// 숫자·':' 포함 문자열 등)을 truthy 여부가 아니라 이 구분으로 갈라야 한다 — 후자는
// firstJobId 유효성과 무관하게 무조건 제외한다(첫 직력으로 재위임 금지).
function isBlankLinkedReference(id: unknown): boolean {
  return id === undefined || id === null || id === '';
}

// firstJobId의 위험 여부와 무관하게 매 레거시 항목마다 "이 항목이 실제로 연결될 최종
// job id"(linkedJobId 우선, 없으면 firstJobId — buildLegacyEntryMap과 동일한 우선순위)
// 와 diagnosisId를 각각 검사한다: 값이 존재하는데 usable 문자열이 아니면 그 항목 전체를
// 제거한다. 값이 아예 없으면(진짜 미입력) legacyNormalize.ts 자체의 `!sharedJobId`/
// `!legacyEntry.diagnosisId` 가드가 이미 안전하게 드롭하므로 손대지 않는다 —
// "명시적 참조가 손상됐으면 첫 직력으로 재위임하지 않고 제외, 손상되지 않은 값은
// 그대로 우선순위 유지"라는 계약을 그대로 구현한다.
function sanitizeLegacyDiagnosisEvaluations(
  moduleData: Record<string, unknown> | undefined,
  firstJobId: unknown,
): Record<string, unknown> | undefined {
  if (!isPlainObject(moduleData)) return moduleData;

  const rawDiagnosisEvaluations = (moduleData as { diagnosisEvaluations?: unknown }).diagnosisEvaluations;
  if (!Array.isArray(rawDiagnosisEvaluations)) return moduleData;

  const sanitizedDiagnosisEvaluations = rawDiagnosisEvaluations.filter((entry) => {
    if (!isPlainObject(entry)) return true; // 비객체 원소는 그대로 둬서 기존 정규화의 방어 로직이 처리하게 한다.
    const record = entry as { linkedJobId?: unknown; diagnosisId?: unknown };

    if (isBlankLinkedReference(record.linkedJobId)) {
      // 진짜 미입력 — buildLegacyEntryMap과 동일하게 firstJobId로 폴백한다. firstJobId
      // 자체가 위험하면(숫자·':' 포함 등) 여기서 제외한다(10~11차 수정과 동일).
      if (firstJobId && !isUsableEntityId(firstJobId)) return false;
    } else {
      // 명시적으로 값이 있다(0·false 포함) — 타입이 손상됐으면 firstJobId 유효성과
      // 무관하게 무조건 제외한다(첫 직력으로 재위임 금지).
      if (!isUsableEntityId(record.linkedJobId)) return false;
    }

    if (record.diagnosisId && !isUsableEntityId(record.diagnosisId)) return false;

    return true;
  });

  return { ...moduleData, diagnosisEvaluations: sanitizedDiagnosisEvaluations };
}

/**
 * job_diagnosis grain 엔터티 열거 — 마스터 계획 §2가 이미 cross join으로 확정해둔 대로
 * (데이터 모델에 job↔diagnosis 명시적 링크 필드가 없다) 행 포함 필터링을 하지 않는다.
 * normalizeElbowModuleData/normalizeWristModuleData가 이미 이 cross join을 만들어주므로
 * (nextJobEvaluations[].diagnosisEntries[]) 그대로 재사용한다(재구현 금지 원칙).
 *
 * ID 유효성 필터(':' 미포함 등)와 dedup(첫 등장 채택)은 elbow/wrist로 나누기 전에
 * jobs/diagnoses 각각 한 번만 수행한다 — 같은 diagnosis는 resolveDiagnosisModule이
 * 정확히 하나의 moduleId만 반환하므로(또는 어느 쪽도 아님), 사전 dedup 이후에는
 * elbow 쪽 cross join과 wrist 쪽 cross join의 진단 id 집합이 서로 겹칠 수 없다 —
 * entityKey 충돌은 구조적으로 발생하지 않는다(assertUniqueEntityKeys는 안전망).
 */
export function enumerateJobDiagnosisEntities(mr: MigrationResult<AnalysisPatient>): GrainEntity<JobDiagnosisSource>[] {
  const { payload } = mr;
  const activeModules = payload.data.activeModules ?? [];
  const shared = (payload.data.shared as Record<string, unknown>) ?? {};

  const rawJobs = Array.isArray(shared.jobs) ? shared.jobs : [];
  const allJobs = rawJobs.filter(isPlainObject) as unknown as Array<{ id?: unknown } & Record<string, unknown>>;
  const rawDiagnoses = Array.isArray(shared.diagnoses) ? shared.diagnoses : [];
  const allDiagnoses = rawDiagnoses.filter(isPlainObject) as unknown as Array<{ id?: unknown } & Record<string, unknown>>;

  // job은 유효성(문자열·비었는지·':' 포함 여부) 배제를 여기서 전혀 하지 않는다(10차
  // 검토 P2 — 9차 수정은 ':' 포함 id만 옮겼을 뿐, 숫자·빈 문자열·undefined id는 여전히
  // 여기서 제거해 같은 버그를 재현시켰다). buildLegacyEntryMap(legacyNormalize.ts)이
  // linkedJobId 없는 레거시 항목을 `jobs[0]?.id`(첫 직력, 원본 배열의 실제 0번 원소)에
  // 귀속시키므로, 원본 배열의 0번 위치를 어떤 이유로든 정규화 호출 *전에* 바꾸면(제거든
  // 필터든) 그 폴백이 실제로는 다른 직력을 가리키게 되어 값이 옮겨 붙는다. 그래서 유효한
  // 문자열 id를 가진 job만 dedup(첫 등장 채택)하고, 그 외(숫자·빈 문자열·undefined 등)는
  // 원본 위치 그대로 통과시킨다 — 이런 job은 출력 엔터티 자체를 만들 수 없어(entityKey
  // 구성 불가) 아래 isUsableEntityId 필터가 결국 걸러내므로 여기서 미리 배제할 필요가
  // 없고, 배제하면 오히려 firstJobId 폴백만 어긋난다.
  const seenJobIds = new Set<string>();
  const dedupedJobs = allJobs.filter((job) => {
    if (typeof job.id !== 'string' || job.id === '') return true;
    if (seenJobIds.has(job.id)) return false;
    seenJobIds.add(job.id);
    return true;
  });

  // diagnosis는 legacyEntryMap이 diagnosisId로 직접 조회할 뿐 위치(첫 번째/순서)에
  // 의존하지 않으므로(§리뷰 확인 — job의 firstJobId 같은 포지셔널 폴백이 없음), 여기서
  // ':' 포함 id까지 미리 배제해도 다른 진단으로 값이 새는 위험이 없다.
  const seenDiagnosisIds = new Set<string>();
  const diagnoses = allDiagnoses.filter((dx) => {
    if (!isUsableEntityId(dx.id)) return false;
    if (seenDiagnosisIds.has(dx.id)) return false;
    seenDiagnosisIds.add(dx.id);
    return true;
  });

  // buildLegacyEntryMap(legacyNormalize.ts)과 정확히 같은 규칙으로 firstJobId를 미리
  // 계산한다(`jobs[0]?.id || ''`) — dedupedJobs는 0번 위치를 절대 건드리지 않으므로
  // allJobs[0]과 항상 같다.
  const firstJobId = dedupedJobs[0]?.id ?? '';

  const out: GrainEntity<JobDiagnosisSource>[] = [];
  const modules = payload.data.modules as Record<string, unknown> | undefined;

  const elbowModule = modules?.elbow;
  if (activeModules.includes('elbow') && isPlainObject(elbowModule)) {
    const synced = normalizeElbowModuleData(
      sanitizeLegacyDiagnosisEvaluations(elbowModule as Record<string, unknown>, firstJobId) as ElbowModuleShape,
      dedupedJobs as unknown as ElbowJobLike[],
      diagnoses as unknown as ElbowDiagnosis[],
      activeModules,
    );
    for (const jobEvaluation of synced.moduleData.jobEvaluations) {
      const jobId = jobEvaluation.sharedJobId;
      // ':' 포함 등 손상된 job id는 분석 엔터티로 만들지 않는다 — 레거시 귀속은 이미
      // 정규화 단계에서 (손상됐더라도) 원래 job으로 정확히 끝났으므로, 여기서 걸러내도
      // 다른 job으로 값이 새지 않는다.
      if (!isUsableEntityId(jobId)) continue;
      for (const entry of jobEvaluation.diagnosisEntries || []) {
        out.push({ entityKey: [jobId, entry.diagnosisId as string], source: { moduleId: 'elbow', entry }, qualityFlags: [] });
      }
    }
  }

  const wristModule = modules?.wrist;
  if (activeModules.includes('wrist') && isPlainObject(wristModule)) {
    const synced = normalizeWristModuleData(
      sanitizeLegacyDiagnosisEvaluations(wristModule as Record<string, unknown>, firstJobId) as WristModuleShape,
      dedupedJobs as unknown as WristJobLike[],
      diagnoses as unknown as WristDiagnosis[],
      activeModules,
    );
    for (const jobEvaluation of synced.moduleData.jobEvaluations) {
      const jobId = jobEvaluation.sharedJobId;
      if (!isUsableEntityId(jobId)) continue;
      for (const entry of jobEvaluation.diagnosisEntries || []) {
        out.push({ entityKey: [jobId, entry.diagnosisId as string], source: { moduleId: 'wrist', entry }, qualityFlags: [] });
      }
    }
  }

  assertUniqueEntityKeys(out, 'job_diagnosis');
  return out;
}
