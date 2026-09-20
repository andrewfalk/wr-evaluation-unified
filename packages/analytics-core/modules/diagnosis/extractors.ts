// Raw extractor — diagnosis grain 1호 슬라이스(§5.5 ④ "신청상병 부위군").

import type { ExtractedValue, MissingReason, MigrationResult, QualityFlag, RepeatedObservation } from '../../types';
import { enumerateDiseaseEntities, type DiagnosisSideSource } from '../../grainEntities';
import { resolveDiagnosisModule, isValidDiagnosisModuleId } from '../../diagnosisMapping';
import type { GrainEntity } from '../../types';
import type { AnalysisPatient } from '../../migration/deterministicMigrate';
import type { DIAGNOSIS_MODULE_GROUP_ORDER } from './metadata';

type DiagnosisModuleGroupId = (typeof DIAGNOSIS_MODULE_GROUP_ORDER)[number];

function isBlank(x: unknown): boolean {
  return x === null || x === undefined || String(x).trim() === '';
}

// resolveDiagnosisModule(diag, [])의 activeModules=[] 인자는 "활성 모듈이 정확히 1개일 때
// 매핑 실패를 그 모듈로 fallback"하는 UI 편의 규칙(§확정 전제 밖)을 의도적으로 끈다 — 이
// 통계 변수는 "이 진단이 실제로 어느 부위에 매치되는가"만 다뤄야 하고, "다른 부위 진단인데
// 마침 그 case가 척추 모듈 하나만 켜서 척추로 집계됨" 같은 잡음을 넣으면 안 된다.
export function extractDiagnosisIdentityModuleGroup(
  migrationResult: MigrationResult<AnalysisPatient>,
): RepeatedObservation<string>[] {
  return enumerateDiseaseEntities(migrationResult).map((entity) => {
    const { diagnosis } = entity.source;

    // 명시적으로 "해당 모듈 없음"을 선택한 진단(예: 참고용으로만 기재) — 결측이 아니라
    // "부위군이 존재하지 않는다"는 구조적 사실이다.
    if (diagnosis.moduleId === '__none__') {
      return { entityKey: entity.entityKey, value: null, missing: 'not_applicable', qualityFlags: entity.qualityFlags };
    }

    const hint = resolveDiagnosisModule(diagnosis, []);
    if (hint && isValidDiagnosisModuleId(hint.moduleId)) {
      return { entityKey: entity.entityKey, value: hint.moduleId, missing: null, qualityFlags: entity.qualityFlags };
    }

    // 코드/이름 어느 쪽으로도 6개 모듈 중 하나에 매치되지 않는다 — §5.5 ②의 job 직종군
    // "presetId 없는 자유 입력"과 같은 성격(legacy_unknown): 값이 없는 게 아니라 알려진
    // 분류 체계로 못 묶는 것이다.
    return {
      entityKey: entity.entityKey,
      value: null,
      missing: 'not_entered',
      qualityFlags: [...entity.qualityFlags, 'legacy_unknown'],
    };
  });
}

interface DiagnosisModulePresence {
  resolved: Set<DiagnosisModuleGroupId>;
  hasUnresolved: boolean;
  qualityFlags: QualityFlag[];
}

// case grain "부위 포함 여부" 6종의 공통 계산 — extractDiagnosisIdentityModuleGroup과
// 같은 resolveDiagnosisModule(diag, []) 판정을 재사용하되, "목록 포함 여부"로 의미를
// 좁힌다: 어떤 부위로도 분류 안 되는(미분류) 진단이 하나라도 남아 있으면 그 진단이
// 사실 부위 X일 수도 있으므로 X=false를 확정할 수 없다(그래서 hasUnresolved를 따로
// 추적한다). 이 helper는 변수 키(6개 wrapper)마다 각각 새로 호출된다 — 서버가 변수
// 키 단위로 extractor를 호출하는 구조라(statsDatasetBuilder.ts) 결과를 캐싱해 1회로
// 줄이지는 않는다. qualityFlags는 __none__ 진단을 포함해 스캔한 모든 엔터티에서
// 무조건 먼저 수집한 뒤 분류를 시도한다.
function computeDiagnosisModulePresence(migrationResult: MigrationResult<AnalysisPatient>): DiagnosisModulePresence {
  const resolved = new Set<DiagnosisModuleGroupId>();
  const qualityFlags = new Set<QualityFlag>();
  let hasUnresolved = false;

  for (const entity of enumerateDiseaseEntities(migrationResult)) {
    for (const flag of entity.qualityFlags) qualityFlags.add(flag);
    const { diagnosis } = entity.source;
    if (diagnosis.moduleId === '__none__') continue;
    const hint = resolveDiagnosisModule(diagnosis, []);
    if (hint && isValidDiagnosisModuleId(hint.moduleId)) {
      resolved.add(hint.moduleId as DiagnosisModuleGroupId);
    } else {
      hasUnresolved = true;
      qualityFlags.add('legacy_unknown');
    }
  }

  return { resolved, hasUnresolved, qualityFlags: [...qualityFlags] };
}

function extractDiagnosisRollupHasModule(
  migrationResult: MigrationResult<AnalysisPatient>,
  targetModuleId: DiagnosisModuleGroupId,
): ExtractedValue<boolean> {
  const { resolved, hasUnresolved, qualityFlags } = computeDiagnosisModulePresence(migrationResult);
  if (resolved.has(targetModuleId)) {
    return { value: true, missing: null, qualityFlags };
  }
  if (hasUnresolved) {
    return { value: null, missing: 'not_entered', qualityFlags };
  }
  return { value: false, missing: null, qualityFlags };
}

export function extractDiagnosisRollupHasKnee(mr: MigrationResult<AnalysisPatient>): ExtractedValue<boolean> {
  return extractDiagnosisRollupHasModule(mr, 'knee');
}
export function extractDiagnosisRollupHasWrist(mr: MigrationResult<AnalysisPatient>): ExtractedValue<boolean> {
  return extractDiagnosisRollupHasModule(mr, 'wrist');
}
export function extractDiagnosisRollupHasElbow(mr: MigrationResult<AnalysisPatient>): ExtractedValue<boolean> {
  return extractDiagnosisRollupHasModule(mr, 'elbow');
}
export function extractDiagnosisRollupHasShoulder(mr: MigrationResult<AnalysisPatient>): ExtractedValue<boolean> {
  return extractDiagnosisRollupHasModule(mr, 'shoulder');
}
export function extractDiagnosisRollupHasSpine(mr: MigrationResult<AnalysisPatient>): ExtractedValue<boolean> {
  return extractDiagnosisRollupHasModule(mr, 'spine');
}
export function extractDiagnosisRollupHasCervical(mr: MigrationResult<AnalysisPatient>): ExtractedValue<boolean> {
  return extractDiagnosisRollupHasModule(mr, 'cervical');
}

// ── PR0-B4 Slice 6 — coverage 잔여 필드(매핑표 §1 shared.diagnoses[]).

// code/name — moduleGroup은 파생 그룹만 반환하고 원본 코드·명 자체는 노출하지 않았다.
// side와 무관하게 그 진단 자체의 값이라(side==='both'로 엔터티 2개가 생겨도 값은 동일하게
// 반복) — job_diagnosis grain에 job 레벨 값을 투영하는 것과 같은 패턴.
function extractDiagnosisIdentityStringField(
  migrationResult: MigrationResult<AnalysisPatient>,
  field: 'code' | 'name',
): RepeatedObservation<string>[] {
  return enumerateDiseaseEntities(migrationResult).map((entity) => {
    const raw = entity.source.diagnosis[field];
    if (isBlank(raw)) {
      return { entityKey: entity.entityKey, value: null, missing: 'not_entered', qualityFlags: entity.qualityFlags };
    }
    if (typeof raw !== 'string') {
      return { entityKey: entity.entityKey, value: null, missing: 'not_entered', qualityFlags: [...entity.qualityFlags, 'invalid'] };
    }
    return { entityKey: entity.entityKey, value: raw, missing: null, qualityFlags: entity.qualityFlags };
  });
}

export function extractDiagnosisIdentityCode(migrationResult: MigrationResult<AnalysisPatient>): RepeatedObservation<string>[] {
  return extractDiagnosisIdentityStringField(migrationResult, 'code');
}

export function extractDiagnosisIdentityName(migrationResult: MigrationResult<AnalysisPatient>): RepeatedObservation<string>[] {
  return extractDiagnosisIdentityStringField(migrationResult, 'name');
}

// 축성(척추/경추) 진단은 side 값과 무관하게 Right 키를 단일 "평가" 슬롯으로 쓴다
// (src/core/utils/assessmentGroups.js:38-46 unitsForDiagnosis의 isAxial 분기, DiagnosisForm.jsx:77도
// 축성이면 방향 라디오 자체를 숨겨 diag.side가 계속 공백으로 남는다). 이 규칙을 반영하지
// 않으면 axial 진단의 side가 항상 'unspecified'로 잡혀 assessmentRight/reasonRight에 정상
// 입력이 있어도 결측으로 잘못 집계된다 — 8차 검토 P1.
// 비축성 진단은 side가 'right'/'left'일 때만 그 키를 쓰고, 방향 미선택('unspecified')이면
// assessmentGroups.js 기준으로 평가단위 자체가 없으므로(findUnassignedSideDiagnoses) null.
//
// activeModules를 실제로 전달한다 — 9차 검토 P2 재현: unitsForDiagnosis도 실제
// activeModules로 resolveDiagnosisModule을 호출한다(assessmentGroups.js:36,
// DiagnosisForm.jsx:41 동일). 이건 "이 진단이 어느 부위군인가"를 통계 변수로 노출하는
// extractDiagnosisIdentityModuleGroup(위, activeModules=[] 고정 — 코드/명으로 안 잡히는
// 진단을 활성 모듈 1개로 흔들리게 두지 않으려는 의도적 정책)과는 다른 문제다. 여기는 "판정
// 값이 실제로 어느 필드에 저장돼 있는가"를 UI와 동일하게 라우팅하는 문제라 fallback을
// 꺼두면 척추/경추 단일 활성 모듈에서 코드·명으로 자동 분류되지 않는 진단(수동으로 축성
// 모듈을 골랐거나, UI가 활성 모듈 1개로 fallback한 진단)의 assessmentRight/reasonRight
// 입력이 있어도 통계에서 전부 결측으로 잡혔다.
function resolveAssessmentSide(
  migrationResult: MigrationResult<AnalysisPatient>,
  entity: GrainEntity<DiagnosisSideSource>,
): 'right' | 'left' | null {
  const { diagnosis, side } = entity.source;
  const activeModules = migrationResult.payload.data.activeModules ?? [];
  const hint = resolveDiagnosisModule(diagnosis, activeModules);
  if (hint?.moduleId === 'spine' || hint?.moduleId === 'cervical') return 'right';
  if (side === 'right' || side === 'left') return side;
  return null;
}

type AssessmentStatusResult = 'high' | 'low' | 'blank' | 'invalid';

// assessmentRight/Left — "업무관련성"(AssessmentTab.jsx SideAssessment), 값 도메인은
// ''/'high'/'low'뿐이다. extractDiagnosisAssessmentStatus(disease grain)와
// extractDiagnosisRollupAnyHighRelatedness(case grain, 아래)가 이 판정을 공유한다 —
// 두 곳에 따로 구현하면 "이 엔터티의 업무관련성이 확정됐는가"에 서로 다른 답이 생긴다.
function resolveDiagnosisAssessmentStatus(
  migrationResult: MigrationResult<AnalysisPatient>,
  entity: GrainEntity<DiagnosisSideSource>,
): AssessmentStatusResult {
  const effectiveSide = resolveAssessmentSide(migrationResult, entity);
  if (effectiveSide === null) return 'blank';
  const { diagnosis } = entity.source;
  const raw = effectiveSide === 'right' ? diagnosis.assessmentRight : diagnosis.assessmentLeft;
  if (isBlank(raw)) return 'blank';
  if (raw === 'high' || raw === 'low') return raw;
  return 'invalid';
}

export function extractDiagnosisAssessmentStatus(
  migrationResult: MigrationResult<AnalysisPatient>,
): RepeatedObservation<string>[] {
  return enumerateDiseaseEntities(migrationResult).map((entity) => {
    const result = resolveDiagnosisAssessmentStatus(migrationResult, entity);
    if (result === 'blank') {
      return { entityKey: entity.entityKey, value: null, missing: 'not_entered', qualityFlags: entity.qualityFlags };
    }
    if (result === 'invalid') {
      return { entityKey: entity.entityKey, value: null, missing: 'not_entered', qualityFlags: [...entity.qualityFlags, 'invalid'] };
    }
    return { entityKey: entity.entityKey, value: result, missing: null, qualityFlags: entity.qualityFlags };
  });
}

// case grain 롤업("업무관련성 높음 상병 포함 여부") — "any"이지 mode가 아니다: 신청 상병
// 중 하나라도 업무관련성 높음(high) 판정이면 true. 다만 false는 "모든 상병의 판정을
// 확인했는데 전부 low"일 때만 확정한다 — 미판정/오류 상병이 하나라도 섞여 있으면(그리고
// high가 없으면) 그 상병이 나중에 high일 수도 있으므로 false가 아니라 not_entered다.
// 판정(value/missing)은 오직 resolveDiagnosisAssessmentStatus의 결과 배열로만 정하고,
// qualityFlags는 스캔한 모든 엔터티에서 별도로 합친다 — 엔터티 ID 중복 같은 판정과
// 무관한 이유로 붙는 invalid 플래그가 판정 자체를 흔들면 안 된다.
export function extractDiagnosisRollupAnyHighRelatedness(
  migrationResult: MigrationResult<AnalysisPatient>,
): ExtractedValue<boolean> {
  const entities = enumerateDiseaseEntities(migrationResult);
  if (entities.length === 0) {
    return { value: null, missing: 'not_applicable', qualityFlags: [] };
  }

  const qualityFlags = new Set<QualityFlag>();
  let sawHigh = false;
  let sawUnresolved = false;
  for (const entity of entities) {
    for (const flag of entity.qualityFlags) qualityFlags.add(flag);
    const status = resolveDiagnosisAssessmentStatus(migrationResult, entity);
    if (status === 'high') sawHigh = true;
    else if (status === 'blank' || status === 'invalid') sawUnresolved = true;
    if (status === 'invalid') qualityFlags.add('invalid');
  }

  if (sawHigh) {
    return { value: true, missing: null, qualityFlags: [...qualityFlags] };
  }
  if (sawUnresolved) {
    return { value: null, missing: 'not_entered', qualityFlags: [...qualityFlags] };
  }
  return { value: false, missing: null, qualityFlags: [...qualityFlags] };
}

type LowReasonState =
  | { kind: 'not_entered' }
  | { kind: 'not_applicable' }
  | { kind: 'structural_missing' }
  | { kind: 'invalid' }
  | { kind: 'ok'; selected: Set<string>; legacyUnknown: boolean };

const LOW_REASON_OPTIONS = ['unrelated', 'unconfirmed', 'ageMild', 'delayed', 'lowBurden', 'belowThreshold', 'other'] as const;

// §매핑표 확정 규칙 — assessment !== 'low'면 reasonRight/Left 배열에 남은 값과 무관하게
// 무조건 not_applicable이다(AssessmentTab.jsx가 assessment==='low'일 때만 이 체크박스
// 목록을 렌더링하고, assessment가 바뀌어도 배열 자체는 지우지 않으므로 — 과거에 선택했던
// 사유가 새 판정에 잘못 집계되는 걸 막는다).
//
// §다중선택 배열 계약(계획서) 순서를 그대로 적용 — 8차 검토 P1 재현: 이전 구현은
// isBlank(raw)로 빈 배열([])까지 not_entered 취급해 분모에서 빠뜨렸고, raw.filter로
// 손상 원소(문자열 아닌 값)를 조용히 걸러내 손상 배열이 정상 응답처럼 통과했다.
// raw===undefined(스키마에 아직 없던 시절) → structural_missing
// !Array.isArray(raw) → not_entered + invalid (null 등 배열 아님)
// 원소 중 문자열이 아닌 게 있음 → not_entered + invalid (배열 전체 거부, 부분 필터링 금지)
// 그 외(정상 문자열 배열, 빈 배열 포함) → 옵션별 true/false, 미지원 옵션값이 섞여 있으면 legacy_unknown
function resolveLowReasonState(
  migrationResult: MigrationResult<AnalysisPatient>,
  entity: GrainEntity<DiagnosisSideSource>,
): LowReasonState {
  const effectiveSide = resolveAssessmentSide(migrationResult, entity);
  if (effectiveSide === null) return { kind: 'not_entered' };

  const { diagnosis } = entity.source;
  const assessment = effectiveSide === 'right' ? diagnosis.assessmentRight : diagnosis.assessmentLeft;
  if (assessment !== 'low') return { kind: 'not_applicable' };

  const raw = effectiveSide === 'right' ? diagnosis.reasonRight : diagnosis.reasonLeft;
  if (raw === undefined) return { kind: 'structural_missing' };
  if (!Array.isArray(raw)) return { kind: 'invalid' };
  if (!raw.every((v): v is string => typeof v === 'string')) return { kind: 'invalid' };
  const knownOptions: readonly string[] = LOW_REASON_OPTIONS;
  const legacyUnknown = raw.some((v) => !knownOptions.includes(v));
  return { kind: 'ok', selected: new Set(raw), legacyUnknown };
}

function extractDiagnosisAssessmentLowReasonOption(
  migrationResult: MigrationResult<AnalysisPatient>,
  option: (typeof LOW_REASON_OPTIONS)[number],
): RepeatedObservation<boolean>[] {
  return enumerateDiseaseEntities(migrationResult).map((entity) => {
    const state = resolveLowReasonState(migrationResult, entity);
    const missingByKind: Record<'not_entered' | 'not_applicable' | 'structural_missing', MissingReason> = {
      not_entered: 'not_entered',
      not_applicable: 'not_applicable',
      structural_missing: 'structural_missing',
    };
    if (state.kind === 'not_entered' || state.kind === 'not_applicable' || state.kind === 'structural_missing') {
      return { entityKey: entity.entityKey, value: null, missing: missingByKind[state.kind], qualityFlags: entity.qualityFlags };
    }
    if (state.kind === 'invalid') {
      const qualityFlags: QualityFlag[] = [...entity.qualityFlags, 'invalid'];
      return { entityKey: entity.entityKey, value: null, missing: 'not_entered', qualityFlags };
    }
    const qualityFlags: QualityFlag[] = state.legacyUnknown ? [...entity.qualityFlags, 'legacy_unknown'] : entity.qualityFlags;
    return { entityKey: entity.entityKey, value: state.selected.has(option), missing: null, qualityFlags };
  });
}

export function extractDiagnosisAssessmentLowReasonUnrelated(mr: MigrationResult<AnalysisPatient>) {
  return extractDiagnosisAssessmentLowReasonOption(mr, 'unrelated');
}
export function extractDiagnosisAssessmentLowReasonUnconfirmed(mr: MigrationResult<AnalysisPatient>) {
  return extractDiagnosisAssessmentLowReasonOption(mr, 'unconfirmed');
}
export function extractDiagnosisAssessmentLowReasonAgeMild(mr: MigrationResult<AnalysisPatient>) {
  return extractDiagnosisAssessmentLowReasonOption(mr, 'ageMild');
}
export function extractDiagnosisAssessmentLowReasonDelayed(mr: MigrationResult<AnalysisPatient>) {
  return extractDiagnosisAssessmentLowReasonOption(mr, 'delayed');
}
export function extractDiagnosisAssessmentLowReasonLowBurden(mr: MigrationResult<AnalysisPatient>) {
  return extractDiagnosisAssessmentLowReasonOption(mr, 'lowBurden');
}
export function extractDiagnosisAssessmentLowReasonBelowThreshold(mr: MigrationResult<AnalysisPatient>) {
  return extractDiagnosisAssessmentLowReasonOption(mr, 'belowThreshold');
}
export function extractDiagnosisAssessmentLowReasonOther(mr: MigrationResult<AnalysisPatient>) {
  return extractDiagnosisAssessmentLowReasonOption(mr, 'other');
}
