// src/modules/cervical/utils/data.js::syncCervicalModuleData(62-89)의 결정적 부분만
// 독립적으로 새로 옮겨 적은 것(§1-3, elbow/wrist와 동일 패턴) — task 정규화(기본값 채움+
// exposure_types 필터). `_pendingPreset`은 cervical엔 없고(§1-3 표에 없음), `changed` 플래그는
// UI 전용 쓰기 트리거라 여기 없다(src/의 원본 syncCervicalModuleData는 그대로 잔류).
//
// cervical은 BK유형 분기·레거시 flat 진단별 저장 구조가 없어 elbow/wrist보다 훨씬 단순하다
// (buildLegacyEntryMap·BK 자동추론·대표값 donor 복사 전부 불필요). 원본의 orphan task
// 정리(jobIds에 없는 sharedJobId를 가진 task 제거)도 여기서는 하지 않는다 — computeCervicalCalc
// 가 어차피 `task.sharedJobId === job.id`로 job별 필터링을 다시 하므로, pruning 여부가
// 계산 결과(jobSummaries)에 영향을 주지 않는다(저장소 정리는 UI 쓰기 경로의 몫).
//
// 원본 createCervicalTask()는 `id: Date.now() + Math.random()`로 비결정적 ID를 만드는데,
// computeCervicalCalc/isCervicalAssessmentComplete 어디에서도 task.id를 읽지 않는다(job별
// 분류는 전부 task.sharedJobId === job.id로 이뤄짐) — 그래서 이 정규화는 id를 아예 만들지
// 않는다(있으면 보존, 없으면 그대로 둠). 계획서(§1-3 cervical 필수 보완 #2) 참고.

import type { DiagnosisLike } from '../../diagnosisMapping';
import { resolveDiagnosisModule } from '../../diagnosisMapping';
import { isPlainObject } from '../../migration/deterministicMigrate';

export interface OptionLike {
  value: string;
  label: string;
}

export const EXPOSURE_TYPE_OPTIONS: OptionLike[] = [
  { value: 'shoulder_heavy_load', label: '어깨에 무거운 하중 운반' },
  { value: 'awkward_static_neck_load', label: '장시간 비중립·정적 목 부하' },
];

export const EXPOSURE_TYPE_LABELS: Record<string, string> = Object.fromEntries(
  EXPOSURE_TYPE_OPTIONS.map((option) => [option.value, option.label]),
);

export interface CervicalTask {
  id?: string | number;
  sharedJobId?: string;
  name?: string;
  exposure_types?: string[];
  load_weight_kg?: string | number;
  carry_hours_per_shift?: string | number;
  forced_neck_posture?: string;
  neck_nonneutral_hours_per_day?: string | number;
  combined_flexion_rotation_posture?: string;
  precision_work?: string;
  notes?: string;
  [key: string]: unknown;
}

export interface CervicalModuleShape {
  returnConsiderations?: string;
  tasks?: CervicalTask[];
  [key: string]: unknown;
}

export interface CervicalDiagnosis extends DiagnosisLike {
  id?: string;
  confirmedRight?: string;
  assessmentRight?: string;
  reasonRight?: unknown[];
}

export interface CervicalJobLike {
  id?: string;
  jobName?: string;
  workDaysPerYear?: string | number;
  startDate?: string;
  endDate?: string;
  workPeriodOverride?: string;
  [key: string]: unknown;
}

function createCervicalTaskDefaults(index: number, sharedJobId: string): CervicalTask {
  return {
    sharedJobId,
    name: `작업 ${index + 1}`,
    exposure_types: [],
    load_weight_kg: '',
    carry_hours_per_shift: '',
    forced_neck_posture: '',
    neck_nonneutral_hours_per_day: '',
    combined_flexion_rotation_posture: '',
    precision_work: '',
    notes: '',
  };
}

export function isCervicalDiagnosis(diag: CervicalDiagnosis, activeModules: string[] = []): boolean {
  return resolveDiagnosisModule(diag, activeModules)?.moduleId === 'cervical';
}

function normalizeCervicalTask(task: CervicalTask = {}, index: number, firstJobId: string): CervicalTask {
  const normalized: CervicalTask = { ...createCervicalTaskDefaults(index, firstJobId), ...(task || {}) };
  normalized.sharedJobId = normalized.sharedJobId || firstJobId;

  // exposure_types는 배열이어야 하는데 저장 값이 손상됐거나 다른 타입이면 배열 메서드
  // 호출에서 예외가 난다(elbow/wrist 리뷰에서 발견된 함정, cervical도 동일 위험) — 배열이
  // 아니면 빈 배열로 취급한다.
  const rawExposureTypes = Array.isArray(normalized.exposure_types) ? normalized.exposure_types : [];
  normalized.exposure_types = rawExposureTypes.filter((value) =>
    EXPOSURE_TYPE_OPTIONS.some((option) => option.value === value),
  );

  return normalized;
}

export interface NormalizedCervicalModuleData {
  moduleData: {
    returnConsiderations: string;
    tasks: CervicalTask[];
  };
}

// 원본 syncCervicalModuleData와 동일한 task 정규화 — orphan task pruning과 `changed`
// 플래그(둘 다 계산 결과에 영향 없음, 위 파일 상단 주석 참고)만 제외한다.
export function normalizeCervicalModuleData(
  moduleData: CervicalModuleShape = {},
  jobs: CervicalJobLike[] = [],
): NormalizedCervicalModuleData {
  const firstJobId = jobs[0]?.id || '';
  // 배열 원소가 plain object가 아니면(레거시/외부 입력의 null 등) task.sharedJobId 접근에서
  // 예외가 나므로 걸러낸다(elbow/wrist 리뷰에서 발견된 함정과 동일).
  const rawTasks = Array.isArray(moduleData.tasks) ? moduleData.tasks : [];
  const sanitizedTasks = rawTasks.filter(isPlainObject) as unknown as CervicalTask[];
  const normalizedTasks = sanitizedTasks.map((task, index) => normalizeCervicalTask(task, index, firstJobId));

  return {
    moduleData: {
      returnConsiderations: moduleData?.returnConsiderations || '',
      tasks: normalizedTasks,
    },
  };
}
