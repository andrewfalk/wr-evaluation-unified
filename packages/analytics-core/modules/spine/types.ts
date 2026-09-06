// MDDM(mddm.ts)과 WBV(vibration.ts) 두 엔진이 공유하는 타입 — patientData.shared/module
// 모양은 한 case 안에서 두 엔진이 함께 읽으므로 여기 한 곳에 정의한다.

import type { DiagnosisLike } from '../../diagnosisMapping';

export interface SpineJobLike {
  id?: string;
  jobName?: string;
  workDaysPerYear?: string | number;
  startDate?: string;
  endDate?: string;
  workPeriodOverride?: string;
  [key: string]: unknown;
}

export interface SpineDiagnosis extends DiagnosisLike {
  id?: string;
  confirmedRight?: string;
  assessmentRight?: string;
  reasonRight?: unknown[];
}

// mddmStatus/vibrationExposureStatus 등 모듈 최상위 필드 + tasks/vibrationIntervals(각
// 엔진 파일에서 구체 타입 지정) — 여기서는 index signature로 느슨하게 잡고 각 엔진 파일이
// 자신이 읽는 배열만 좁혀 쓴다.
export interface SpineModuleShape {
  mddmStatus?: string;
  evalMethod?: string;
  vibrationExposureStatus?: string;
  formulaVersion?: string;
  careerYears?: number | string;
  careerMonths?: number | string;
  workDaysPerYear?: number | string;
  tasks?: unknown[];
  vibrationIntervals?: unknown[];
  [key: string]: unknown;
}
