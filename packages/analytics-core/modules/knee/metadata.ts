// 변수 카탈로그 — knee.relatedness.max 1개(§4.4). 계획서 §5 스키마를 그대로 따른다.
// PR0-B1은 이 변수 하나로 좁혔다 — K-L Grade·판정상태는 diagnosis_side grain 값이라
// case grain으로 올리려면 다중 상병 축약(reducer) 규칙이 필요한데, 그건 그 grain이
// 실제로 생기는 PR(PR0-B2 이후)에서 grain 의미론과 함께 정한다.

// PR0-B2: 6개 모듈 공통 스키마라 ../../types.ts로 옮겼다 — re-export해서 이 파일과
// index.ts(`export * from './metadata'`)를 통해 기존 import 경로를 그대로 유지한다.
export type { AnalyticsVariableMetadata } from '../../types';
import type { AnalyticsVariableMetadata } from '../../types';

export const KNEE_METADATA: AnalyticsVariableMetadata[] = [
  {
    key: 'knee.relatedness.max',
    label: '신체부담기여도(최대)',
    group: '무릎 · 파생지표',
    moduleId: 'knee',
    grain: 'case',
    type: 'continuous',
    unit: '%',
    provenance: 'derived',
    // dependsOn의 정의: 공식이 실제로 읽는 필드뿐 아니라 value나 missing/qualityFlags
    // 판정 결과를 바꿀 수 있는 모든 원천 필드를 포함한다.
    dependsOn: [
      // 공식 계산 입력
      'shared.birthDate',
      'shared.injuryDate',
      'activeModules',
      'shared.jobs[].id',
      'shared.jobs[].startDate',
      'shared.jobs[].endDate',
      'shared.jobs[].workPeriodOverride',
      'modules.knee.jobs[]',
      'modules.knee.jobExtras[].sharedJobId',
      'modules.knee.jobExtras[].weight',
      'modules.knee.jobExtras[].squatting',
      // missing/qualityFlags 판정에만 관여(§5.2 unsupported_legacy_spine_jobs 감지)
      'modules.spine.jobName',
      'modules.spine.careerYears',
      'modules.spine.careerMonths',
      'modules.spine.workDaysPerYear',
    ],
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association', 'formula_audit'],
    sensitivity: 'non_sensitive',
    formulaFamily: 'knee_relatedness',
    // formulaVersion 필드/버전 dispatcher가 무릎 module data·computeKneeCalc 어디에도
    // 없어(data.js:54, calculations.js:118) recompute_recorded_version은 선언 불가.
    supportedFormulaPolicies: ['recompute_current'],
  },
];
