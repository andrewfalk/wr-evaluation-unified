// 경추 case grain 추출기(extractors.ts)가 공유하는 "정규화 전 원본 task" 검사 헬퍼.
//
// normalizeCervicalModuleData(legacyNormalize.ts)는 두 가지를 조용히 바꾼다:
//  · exposure_types가 배열이 아니거나 허용값(EXPOSURE_TYPE_OPTIONS)이 아닌 원소를 포함하면
//    그 값만(또는 전부) 제거해 []로 만든다 — 정상 빈 배열(노출유형 미선택)과 손상 입력이
//    구분되지 않아, 손상이 "작업 없음 = 유효한 0"으로 오인된다.
//  · sharedJobId가 없거나 빈값이면 첫 직업에 연결한다(`sharedJobId || firstJobId`).
// 그래서 검사는 정규화 "전에" 원본 task에서, 정규화와 같은 직업 연결 규칙으로 수행한다.
// 명시적으로 삭제된 직업 id를 가리키는 고아 작업은 정규화가 제거하지 않지만 계산기
// (computeCervicalCalc)가 현재 직업에 연결된 작업만 쓰므로 여기서도 제외한다.

import { isPlainObject } from '../../migration/deterministicMigrate';
import { EXPOSURE_TYPE_OPTIONS, type CervicalJobLike } from './legacyNormalize';
import { isJobIdExcluded } from '../../jobScope';

export interface LinkedRawCervicalTask {
  task: Record<string, unknown>;
  jobId: unknown;
}

const ALLOWED_EXPOSURE_TYPES: ReadonlySet<string> = new Set(EXPOSURE_TYPE_OPTIONS.map((option) => option.value));

/** 현재 직업에 연결된 원본 task(정규화와 같은 연결 규칙, 고아 작업 제외). */
export function getLinkedRawCervicalTasks(
  cervicalModule: Record<string, unknown>,
  jobs: readonly CervicalJobLike[],
): LinkedRawCervicalTask[] {
  const firstJobId = jobs[0]?.id || '';
  const jobIds = new Set<unknown>(jobs.map((job) => job.id));
  const rawTasks = Array.isArray(cervicalModule.tasks) ? cervicalModule.tasks : [];
  return rawTasks
    .filter(isPlainObject)
    .map((task) => ({ task: task as Record<string, unknown>, jobId: task.sharedJobId || firstJobId }))
    .filter(({ jobId }) => jobIds.has(jobId));
}

/**
 * 평가(통계) 대상 직업에 연결된 원본 task — getLinkedRawCervicalTasks로 **전체 직업 기준** 귀속을 확정한 뒤
 * "신체부담평가 미포함" 직력에 귀속된 task만 사후 제거한다. 포함 직력만 getLinkedRawCervicalTasks에 넘기면
 * 첫 직력이 미포함일 때 sharedJobId 없는 task가 다음 직력으로 재귀속되어 화면·보고서(전체 jobs로 정규화)와
 * 값이 달라진다(고아 task 제외 규칙은 getLinkedRawCervicalTasks 그대로).
 */
export function getEvaluatedRawCervicalTasks(
  cervicalModule: Record<string, unknown>,
  jobs: readonly CervicalJobLike[],
): LinkedRawCervicalTask[] {
  return getLinkedRawCervicalTasks(cervicalModule, jobs).filter(({ jobId }) => !isJobIdExcluded(jobs, jobId));
}

/** 원본 exposure_types가 정상인가 — 미설정(undefined/null)은 빈 배열로 허용, 그 외에는 배열이고
 *  모든 원소가 허용된 노출유형 문자열이어야 한다(알 수 없는 문자열, 정상+알 수 없는 값 혼합 포함). */
export function isValidRawExposureTypes(raw: unknown): boolean {
  if (raw === undefined || raw === null) return true;
  return Array.isArray(raw) && raw.every((value) => typeof value === 'string' && ALLOWED_EXPOSURE_TYPES.has(value));
}

/** 현재 직업에 연결된 작업 중 exposure_types가 손상된 것이 하나라도 있으면 false. */
export function validateRawCervicalTaskExposure(linkedTasks: readonly LinkedRawCervicalTask[]): boolean {
  return linkedTasks.every(({ task }) => isValidRawExposureTypes(task.exposure_types));
}
