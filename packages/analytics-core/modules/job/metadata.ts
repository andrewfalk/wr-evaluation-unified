// PR0-B3 Part C — job grain 1호 슬라이스. job은 어떤 임상 모듈에도 속하지 않는 공유
// 개념(shared.jobs[])이라 6개 모듈처럼 UI 모듈과 1:1로 대응하지 않는다 — moduleId는
// 실제 모듈이 아니라 이 사실을 그대로 드러내는 값('job')이다. CatalogPanel.jsx의 모듈
// 칩 필터는 moduleId를 그대로 쓰므로 이 값이 "공통" 성격의 새 칩으로 자연히 나타난다.

export type { AnalyticsVariableMetadata } from '../../types';
import type { AnalyticsVariableMetadata } from '../../types';

export const JOB_METADATA: AnalyticsVariableMetadata[] = [
  {
    key: 'job.identity.jobNameNormalized',
    label: '직종명(정규화)',
    group: '직업력 · 공통',
    moduleId: 'job',
    grain: 'job',
    type: 'high_cardinality',
    provenance: 'raw',
    // §5.5 ① 계획 규칙 — 원본 jobName은 자유 텍스트라 수준이 수백 개다. 정규화(NFC→trim→
    // 공백 축약→전각/반각 통일→소문자화)는 표기 흔들림만 접고 실제 서로 다른 직종을
    // 합치지 않는다(실측: 355개 원본이 정규화 후에도 355개 — 병합 0건). 회귀 predictor로
    // 쓰면 estimability gate의 maxLevels 검사가 막아야 하지만, 그 게이트는 PR4-A(회귀)
    // 범위라 이번 PR에는 아직 없다 — 기술통계·필터 용도로만 카탈로그에 올린다.
    dependsOn: ['shared.jobs[].id', 'shared.jobs[].jobName', 'shared.jobs[].startDate', 'shared.jobs[].endDate', 'shared.jobs[].workPeriodOverride'],
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association'],
    // §5.5 ① — 자유 텍스트 고카디널리티 변수는 조합만으로 재식별 위험을 높인다. 최소
    // cohort·희귀범주 억제 시행은 아직 없지만(§5.1 참고 — 강제 로직은 별도 PR), 메타데이터
    // 선언 자체는 지금 정확히 해 둔다.
    sensitivity: 'quasi_identifier',
    formulaFamily: 'job_identity',
    supportedFormulaPolicies: [],
  },
  {
    // PR0-B3 Part A "변수 추가/제거해도 모집단 불변" 계약을 이 grain에서도 실측하려면
    // 최소 2개가 필요하다(vibration_interval/diagnosis_side와 동일한 이유). tenureYears는
    // jobNameNormalized와 결측 조건이 다르다(이름 없이 기간만 입력된 job은 흔한 실제
    // 패턴 — 이름 공백은 not_entered인데 기간은 정상 계산됨).
    key: 'job.identity.tenureYears',
    label: '근속기간(년)',
    group: '직업력 · 공통',
    moduleId: 'job',
    grain: 'job',
    type: 'continuous',
    unit: '년',
    provenance: 'derived',
    dependsOn: ['shared.jobs[].id', 'shared.jobs[].jobName', 'shared.jobs[].startDate', 'shared.jobs[].endDate', 'shared.jobs[].workPeriodOverride'],
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association', 'formula_audit'],
    sensitivity: 'non_sensitive',
    formulaFamily: 'job_tenure',
    supportedFormulaPolicies: [],
  },
  {
    // §2.1/§5.5 계획 — job grain 변수를 case로 올릴 때의 기본 대표 규칙. "가장 오래
    // 종사한 직력"의 직종명을 그 case의 대표값으로 삼는다. job.identity.tenureYears와
    // 정확히 같은 유효성 규칙을 재사용해 대표 후보를 고른다(중복 구현 금지).
    key: 'job.rollup.longestTenureJobNameNormalized',
    label: '대표 직종명(근속 최장)',
    group: '직업력 · 공통',
    moduleId: 'job',
    grain: 'case',
    type: 'high_cardinality',
    provenance: 'derived',
    dependsOn: ['shared.jobs[].id', 'shared.jobs[].jobName', 'shared.jobs[].startDate', 'shared.jobs[].endDate', 'shared.jobs[].workPeriodOverride'],
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association'],
    sensitivity: 'quasi_identifier',
    formulaFamily: 'job_rollup_longest_tenure',
    supportedFormulaPolicies: [],
  },
];
