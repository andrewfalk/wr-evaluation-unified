// 손목 모듈 데이터 — 엔트리·직력·모듈 팩토리와 sync는 팔꿈치·손목 공용(_shared/upperLimb/dataFactories, P2-69b)이고,
// 이 모듈의 값(상수 표·엔트리 필드와 순서·분기 필드·BK 추론·상병 판정·공구 압박 보정 근거)은 ./dataConfig에 있다. 이 파일은
// 그 값으로 공용 코드를 묶어 옛 이름 그대로 내보낸다(이 경로를 import하는 소비자가 있다 — 화면·index·서술·테스트).
import {
  createUpperLimbDataApi,
  createUpperLimbJobEvaluation,
  createUpperLimbModuleData,
  createUpperLimbTemporalSequence,
} from '../../_shared/upperLimb/dataFactories';
import { wristDataConfig } from './dataConfig';
import type {
  UpperLimbDiagnosisEntry,
  UpperLimbDiagnosisLike,
  UpperLimbJobEvaluation,
  UpperLimbJobLike,
  UpperLimbModuleData,
  UpperLimbModuleDataInput,
  UpperLimbTemporalSequence,
} from '../../_shared/upperLimb/dataFactories';

export type WristDiagnosisLike = UpperLimbDiagnosisLike;
export type WristJobLike = UpperLimbJobLike;
export type WristDiagnosisEntry = UpperLimbDiagnosisEntry;
export type WristTemporalSequence = UpperLimbTemporalSequence;
export type WristJobEvaluation = UpperLimbJobEvaluation;
export type WristModuleDataInput = UpperLimbModuleDataInput;
export type WristModuleData = UpperLimbModuleData;

export {
  BK_TYPE_OPTIONS,
  BK_TYPE_LABELS,
  EXPOSURE_TYPE_OPTIONS,
  EXPOSURE_TYPE_LABELS,
  PRESSURE_SOURCE_OPTIONS,
  PRESSURE_SOURCE_LABELS,
  VIBRATION_TOOL_OPTIONS,
  VIBRATION_TOOL_LABELS,
  WRIST_BRANCH_FIELDS,
  inferWristBkTypeFromDiagnosis,
  isWristDiagnosis,
} from './dataConfig';

export const createWristTemporalSequence = createUpperLimbTemporalSequence;

export const createWristJobEvaluation = createUpperLimbJobEvaluation;
export const createWristModuleData = createUpperLimbModuleData;

const api = createUpperLimbDataApi(wristDataConfig);

export const createWristDiagnosisEntry = api.createDiagnosisEntry;
export const createWristDiagnosisEvaluation = api.createDiagnosisEvaluation;
export const resetWristBranchFields = api.resetBranchFields;
export const syncWristModuleData = api.syncModuleData;
