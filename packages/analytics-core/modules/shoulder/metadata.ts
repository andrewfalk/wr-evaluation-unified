// 변수 카탈로그 — shoulder.exposure.anyExceeded 1개(§1-1). "formula family당 대표 변수 1개"
// 확정 범위(총 7개, knee 포함) — 전체 카탈로그 확장은 PR0-B3.

import type { AnalyticsVariableMetadata } from '../../types';

// ELLMAN_OPTIONS(AssessmentTab.jsx)가 실제로 제공하는 4개 등급의 심각도 순서 — 오름차순.
// Ellman 분류의 임상 관례상 Grade 1~3은 회전근개 부분층 파열의 깊이 등급, Full은 전층
// 파열(부분층보다 중증)이라 등급 순서의 맨 끝에 둔다. "N/A"는 klGrade와 동일한 이유로
// 이 순서에 끼워넣지 않는다(knee/metadata.ts KNEE_KLG_ORDER 주석 참고).
export const SHOULDER_ELLMAN_ORDER = ['Grade 1', 'Grade 2', 'Grade 3', 'Full'] as const;

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
  {
    // PR0-B3 Part B — diagnosis_side grain. knee.diagnosisSide.klGrade와 동일한 패턴.
    key: 'shoulder.diagnosisSide.ellmanClass',
    label: 'Ellman Class',
    group: '어깨 · 진단별 판정',
    moduleId: 'shoulder',
    grain: 'diagnosis_side',
    type: 'ordinal',
    provenance: 'clinician_judgment',
    dependsOn: [
      'activeModules',
      'shared.diagnoses[].id',
      'shared.diagnoses[].code',
      'shared.diagnoses[].name',
      'shared.diagnoses[].moduleId',
      'shared.diagnoses[].side',
      'shared.diagnoses[].ellmanRight',
      'shared.diagnoses[].ellmanLeft',
    ],
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association', 'formula_audit'],
    sensitivity: 'non_sensitive',
    formulaFamily: 'shoulder_ellman_class_side',
    supportedFormulaPolicies: [],
  },
];
