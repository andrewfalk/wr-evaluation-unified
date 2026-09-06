// src/modules/spine/utils/calculations.js의 통합 진입점(computeSpineCalc/isSpineAssessmentComplete
// /isSpineDiagnosisComplete)만 이동 — MDDM/WBV 각 엔진 본체는 mddm.ts/vibration.ts 참고
// (계획서 §1-3 spine 항목의 파일 분리 지침).

import { resolveDiagnosisModule } from '../../diagnosisMapping';
import type { CompletionContext } from '../../analyticsRegistry';
import { computeMddmCalc, resolveMddmStatus, isMddmComplete, type MddmCalcResult, type MddmFormulaPolicy } from './mddm';
import { computeVibrationCalc, isVibrationComplete, type VibrationCalcResult } from './vibration';
import type { SpineDiagnosis, SpineJobLike, SpineModuleShape } from './types';

export * from './constants';
export * from './mddm';
export * from './vibration';
export type { SpineDiagnosis, SpineJobLike, SpineModuleShape } from './types';

export interface SpineCalcResult extends MddmCalcResult {
  mddmStatus: string;
  vibration: VibrationCalcResult;
}

// 전체 계산 결과 산출 (모듈 레벨) — 원본과 동일 로직. MDDM 평탄 필드는 top-level 유지,
// WBV는 vibration 서브키. mddmStatus도 top-level에 실어 출력/패널이 게이트한다.
export function computeSpineCalc(
  patientData: {
    shared?: { jobs?: SpineJobLike[]; diagnoses?: SpineDiagnosis[]; gender?: string };
    module?: SpineModuleShape;
    activeModules?: string[];
  },
  opts: { formulaPolicy?: MddmFormulaPolicy } = {},
): SpineCalcResult {
  const mod = patientData.module || {};
  const mddmStatus = resolveMddmStatus(mod);
  return {
    ...computeMddmCalc(patientData, opts),
    mddmStatus,
    vibration: computeVibrationCalc(patientData),
  };
}

// 척추 상병 완료 체크 — MDDM/WBV 양 경로 공용. 원본 그대로 이관(수정 범위 아님).
export function isSpineDiagnosisComplete(patientData: {
  shared?: { diagnoses?: SpineDiagnosis[] };
  activeModules?: string[];
}): boolean {
  const shared = patientData.shared || {};
  const diagnoses = shared.diagnoses || [];
  const spineDiags = diagnoses.filter((dx) => resolveDiagnosisModule(dx, patientData.activeModules || [])?.moduleId === 'spine');
  if (spineDiags.length === 0) return false;
  return spineDiags.every((dx) => {
    if (!dx.confirmedRight || !dx.assessmentRight) return false;
    if (dx.assessmentRight === 'low' && !dx.reasonRight?.length) return false;
    return true;
  });
}

// 완료 판정 — (MDDM 유효 || WBV 유효) && 상병. 둘 중 하나만 평가해도 완료 가능.
function isSpineAssessmentCompleteRaw(patientData: {
  shared?: { jobs?: SpineJobLike[]; diagnoses?: SpineDiagnosis[] };
  module?: SpineModuleShape;
  activeModules?: string[];
}): boolean {
  if (!isSpineDiagnosisComplete(patientData)) return false;
  return isMddmComplete(patientData) || isVibrationComplete(patientData);
}

/** 종합소견 완료 여부 판정 — 원본과 동일 로직. CompletionContext로 파라미터 타입 통일. */
export function isSpineAssessmentComplete(ctx: CompletionContext): boolean {
  return isSpineAssessmentCompleteRaw({
    shared: ctx.shared as { jobs?: SpineJobLike[]; diagnoses?: SpineDiagnosis[] },
    module: ctx.module as SpineModuleShape,
    activeModules: ctx.activeModules,
  });
}
