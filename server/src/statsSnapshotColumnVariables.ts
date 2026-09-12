// PR0-B3 Part C — payload가 아니라 SnapshotRow(DB 컬럼)에서 직접 오는 변수. analytics-core는
// patient payload(migration 대상)만 다루므로 이 변수들은 analytics-core extractor로 만들 수
// 없다 — statsDatasetBuilder.ts가 SnapshotRow를 직접 읽어 값을 뽑는다(analytics-core 경유
// 안 함). getIntegratedCatalog()(statsCatalog.ts)가 이 메타데이터를 analytics-core 카탈로그와
// 병합한다 — Part A가 미리 만들어둔 합류 지점(계획 "통합 카탈로그" 절).
import type { AnalyticsVariableMetadata, ExtractedValue } from '@wr/analytics-core';
import type { SnapshotRow } from './statsSnapshot';

export const ASSIGNED_DOCTOR_KEY = 'case.staff.assignedDoctorUserId';
export const REGISTERED_AT_KEY = 'case.meta.registeredAt';

export const SNAPSHOT_COLUMN_VARIABLES: AnalyticsVariableMetadata[] = [
  {
    key: ASSIGNED_DOCTOR_KEY,
    label: '담당의',
    group: '사례 메타 · 공통',
    moduleId: 'meta',
    grain: 'case',
    type: 'categorical',
    provenance: 'raw',
    dependsOn: ['patient_records.assigned_doctor_user_id'],
    availableAt: 'assessment',
    shownToAssessor: true,
    // 확정 전제(마스터 계획 §확정 전제) — "담당의 집계: 전체 사용자 허용, 별도 권한 없음".
    // 공변량·cluster 용도도 막지 않는다(§5.5 ③) — 회귀(prediction) 자체는 PR4-A 범위.
    allowedAnalysisPurposes: ['association', 'formula_audit'],
    // 사례 수가 최소 cohort 미만인 의사를 "기타"로 병합하는 전용 로직(§5.5 ③)은 아직
    // 없다 — 기존 discrete 변수 공통 소수 셀 억제(statsDescriptiveSuppression.ts)가
    // person 단위로 레벨별 최소 인원 미달 시 그 분포 자체를 억제하는 것으로 최소한의
    // 보호를 제공한다. 담당의 전용 "기타" 병합은 별도 과제로 남긴다.
    sensitivity: 'staff_identifier',
    formulaFamily: 'case_meta_assigned_doctor',
    supportedFormulaPolicies: [],
    analysisRole: 'analyzable',
  },
  {
    key: REGISTERED_AT_KEY,
    label: '등록일',
    group: '사례 메타 · 공통',
    moduleId: 'meta',
    grain: 'case',
    type: 'date',
    provenance: 'raw',
    dependsOn: ['patient_records.created_at'],
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association', 'formula_audit'],
    sensitivity: 'non_sensitive',
    formulaFamily: 'case_meta_registered_at',
    supportedFormulaPolicies: [],
    // §"필터 전용 변수 계약" — date 타입은 statsDescriptiveSuppression.ts의
    // mapCatalogTypeToKind가 아직 처리하지 못한다(카탈로그에 date가 0건이던 시절 만든
    // throw 분기, PR1). 분석 변수 후보에서 빼고 필터로만 노출해 그 예외 경로 자체를
    // 피한다 — 등록일은 실제로도 "이 기간에 등록된 사례만" 거르는 용도가 자연스럽다.
    analysisRole: 'filter_only',
  },
];

// UTC 고정 — 프로젝트 전역 관례(dev-intranet-server.ps1의 TZ=UTC 코멘트, patient_records.
// created_at은 timestamptz)와 동일하게 날짜만 잘라 ISO(YYYY-MM-DD)로 만든다. 이 문자열은
// 사전순 비교가 곧 시간순 비교와 같아(statsDatasetBuilder.ts의 matchesFilter가 gt/gte/
// lt/lte/between에서 하는 순수 JS `<`/`>` 문자열 비교가 그대로 올바른 결과를 낸다 — 별도
// 날짜 파싱 분기를 추가할 필요가 없다).
function toIsoDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** neededKeys 중 SnapshotRow 컬럼 변수는 analytics-core를 거치지 않고 여기서 직접 값을
 * 만든다. 그 키가 아니면 null(호출부가 기존 analytics-core 경로로 폴백). */
export function extractSnapshotColumnValue(key: string, row: SnapshotRow): ExtractedValue<unknown> | null {
  if (key === ASSIGNED_DOCTOR_KEY) {
    if (row.assignedDoctorUserId === null) {
      return { value: null, missing: 'not_entered', qualityFlags: [] };
    }
    return { value: row.assignedDoctorUserId, missing: null, qualityFlags: [] };
  }
  if (key === REGISTERED_AT_KEY) {
    return { value: toIsoDateOnly(row.createdAt), missing: null, qualityFlags: [] };
  }
  return null;
}
