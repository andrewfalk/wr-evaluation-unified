// 팔꿈치 모듈 데이터 — 엔트리·직력·모듈 팩토리와 sync는 팔꿈치·손목 공용(_shared/upperLimb/dataFactories, P2-69b)이고,
// 이 모듈의 값(상수 표·엔트리 필드와 순서·분기 필드·BK 추론·상병 판정·공구 압박 보정 근거)은 ./dataConfig에 있다. 이 파일은
// 그 값으로 공용 코드를 묶어 옛 이름 그대로 내보낸다(이 경로를 import하는 소비자가 있다 — 화면·index·서술·테스트).
import {
  createUpperLimbDataApi,
  createUpperLimbJobEvaluation,
  createUpperLimbModuleData,
  createUpperLimbTemporalSequence,
} from '../../_shared/upperLimb/dataFactories';
import { elbowDataConfig } from './dataConfig';
import type {
  UpperLimbDiagnosisEntry,
  UpperLimbDiagnosisLike,
  UpperLimbJobEvaluation,
  UpperLimbJobLike,
  UpperLimbModuleData,
  UpperLimbModuleDataInput,
  UpperLimbTemporalSequence,
} from '../../_shared/upperLimb/dataFactories';

export type ElbowDiagnosisLike = UpperLimbDiagnosisLike;
export type ElbowJobLike = UpperLimbJobLike;
export type ElbowDiagnosisEntry = UpperLimbDiagnosisEntry;
export type ElbowTemporalSequence = UpperLimbTemporalSequence;
export type ElbowJobEvaluation = UpperLimbJobEvaluation;
export type ElbowModuleDataInput = UpperLimbModuleDataInput;
export type ElbowModuleData = UpperLimbModuleData;

export {
  BK_TYPE_OPTIONS,
  BK_TYPE_LABELS,
  EXPOSURE_TYPE_OPTIONS,
  EXPOSURE_TYPE_LABELS,
  PRESSURE_SOURCE_OPTIONS,
  PRESSURE_SOURCE_LABELS,
  VIBRATION_TOOL_OPTIONS,
  VIBRATION_TOOL_LABELS,
  ELBOW_BRANCH_FIELDS,
  inferElbowBkTypeFromDiagnosis,
  isElbowDiagnosis,
} from './dataConfig';

export const createElbowTemporalSequence = createUpperLimbTemporalSequence;

export function createElbowTemporalRelation(): ElbowTemporalSequence {
  return createElbowTemporalSequence();
}

export const createElbowJobEvaluation = createUpperLimbJobEvaluation;
export const createElbowModuleData = createUpperLimbModuleData;

const api = createUpperLimbDataApi(elbowDataConfig);

export const createElbowDiagnosisEntry = api.createDiagnosisEntry;
export const createElbowDiagnosisEvaluation = api.createDiagnosisEvaluation;
export const resetElbowBranchFields = api.resetBranchFields;
export const syncElbowModuleData = api.syncModuleData;
