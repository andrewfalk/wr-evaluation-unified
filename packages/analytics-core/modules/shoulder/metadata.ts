// 변수 카탈로그 — shoulder.exposure.anyExceeded 1개(§1-1). "formula family당 대표 변수 1개"
// 확정 범위(총 7개, knee 포함) — 전체 카탈로그 확장은 PR0-B3.

import type { AnalyticsVariableMetadata } from '../../types';

export const SHOULDER_METADATA: AnalyticsVariableMetadata[] = [
  {
    key: 'shoulder.exposure.anyExceeded',
    label: '노출 한도 초과 여부(5종 중 1개 이상)',
    group: '어깨 · 파생지표',
    moduleId: 'shoulder',
    grain: 'case',
    type: 'boolean',
    provenance: 'derived',
    // dependsOn: 공식이 읽는 필드 + missing/qualityFlags 판정에 영향 주는 필드 전부(§5.2 원칙).
    dependsOn: [
      'activeModules',
      'shared.jobs[].id',
      'shared.jobs[].startDate',
      'shared.jobs[].endDate',
      'shared.jobs[].workPeriodOverride',
      'shared.jobs[].workDaysPerYear',
      'modules.shoulder.jobExtras[].sharedJobId',
      'modules.shoulder.jobExtras[].overheadHours',
      'modules.shoulder.jobExtras[].repetitiveMediumHours',
      'modules.shoulder.jobExtras[].repetitiveFastHours',
      'modules.shoulder.jobExtras[].heavyLoadCount',
      'modules.shoulder.jobExtras[].heavyLoadSeconds',
      'modules.shoulder.jobExtras[].vibrationHours',
    ],
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association', 'formula_audit'],
    sensitivity: 'non_sensitive',
    formulaFamily: 'shoulder_exposure',
    // BK2117 임계값(EXPOSURE_LIMITS, derived.ts)에는 버전 개념이 없다 — 과거 구현이 보존된
    // 대체 버전이 없어 recompute_recorded_version 선언 불가(knee.relatedness.max와 같은 사유).
    supportedFormulaPolicies: ['recompute_current'],
  },
];
