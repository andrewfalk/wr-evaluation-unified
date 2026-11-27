// 팔꿈치 모듈 데이터의 고유 값(P2-69b) — 상수 표·엔트리 필드와 순서·분기 필드·BK 추론·상병 판정·공구 압박 보정 근거를
// 지금 값 그대로 적는다(규칙으로 생성하지 않는다). 팩토리·sync는 공용(_shared/upperLimb/dataFactories)이고,
// utils/data.ts가 이 값으로 공용 코드를 묶어 옛 이름 그대로 내보낸다. 두 모듈 config의 키 집합은 테스트가 같음을 지킨다.
import { resolveDiagnosisModule } from '../../../core/utils/diagnosisMapping';
import type { UpperLimbDataConfig, UpperLimbDiagnosisLike, UpperLimbEntryFieldKind } from '../../_shared/upperLimb/dataFactories';

export const BK_TYPE_OPTIONS = [
  { value: '', label: '선택' },
  { value: 'BK2101', label: 'BK2101 상과병변/부착부 건병증' },
  { value: 'BK2103', label: 'BK2103 팔꿈치 골관절염/박리성 골연골염' },
  { value: 'BK2105', label: 'BK2105 팔꿈치 점액낭염' },
  { value: 'BK2106', label: 'BK2106 주관증후군/척골신경병변' },
];

export const BK_TYPE_LABELS = Object.fromEntries(
  BK_TYPE_OPTIONS.filter(option => option.value).map(option => [option.value, option.label])
);

export const EXPOSURE_TYPE_OPTIONS = [
  { value: 'repetition', label: '반복 동작' },
  { value: 'force', label: '힘 사용' },
  { value: 'awkward_posture', label: '비중립 자세' },
];

export const EXPOSURE_TYPE_LABELS = Object.fromEntries(
  EXPOSURE_TYPE_OPTIONS.map(option => [option.value, option.label])
);

export const PRESSURE_SOURCE_OPTIONS = [
  { value: 'hard_surface', label: '딱딱한 표면' },
  { value: 'tool_edge', label: '공구 모서리' },
  { value: 'ground_contact', label: '바닥 접촉' },
  { value: 'carrying_contact', label: '운반 접촉' },
  { value: 'other', label: '기타' },
];

export const PRESSURE_SOURCE_LABELS = Object.fromEntries(
  PRESSURE_SOURCE_OPTIONS.map(option => [option.value, option.label])
);

export const VIBRATION_TOOL_OPTIONS = [
  { value: 'grinder', label: '그라인더' },
  { value: 'jackhammer', label: '착암기' },
  { value: 'demolition_hammer', label: '파쇄 해머' },
  { value: 'chipping_hammer', label: '치핑 해머' },
  { value: 'tamping_machine', label: '탬핑 머신' },
  { value: 'rotary_hammer', label: '로터리 해머' },
  { value: 'compactor', label: '컴팩터' },
  { value: 'reciprocating_saw', label: '왕복톱' },
  { value: 'rivet_hammer', label: '리벳 해머' },
  { value: 'rust_hammer', label: '러스트 해머' },
  { value: 'powder_actuated_tool', label: '화약식 공구' },
  { value: 'forging_hammer', label: '단조 해머' },
  { value: 'other', label: '기타' },
];

export const VIBRATION_TOOL_LABELS = Object.fromEntries(
  VIBRATION_TOOL_OPTIONS.map(option => [option.value, option.label])
);

export const ELBOW_BRANCH_FIELDS = {
  BK2101: [
    'bk2101_cycle_seconds',
    'bk2101_monotony',
    'static_holding_level',
    'bk2101_forced_dorsal_extension',
    'bk2101_prosupination',
  ],
  BK2105: [
    'bk2105_elbow_leaning',
    'direct_pressure_level',
    'bk2105_pressure_source',
  ],
  BK2106: [
    'static_holding_level',
    'direct_pressure_level',
    'bk2106_pressure_source',
  ],
  BK2103: [
    'vibration_exposure',
    'bk2103_vibration_tool_type',
    'bk2103_daily_vibration_hours',
    'bk2103_tool_pressing',
  ],
};

/** 엔트리 필드(diagnosisId·selectedBkType·bkSelectionMode 다음)와 순서 — 옛 createElbowDiagnosisEntry의 순서 그대로. */
const ELBOW_ENTRY_FIELDS: ReadonlyArray<readonly [string, UpperLimbEntryFieldKind]> = [
  ['main_task_name', 'text'],
  ['direct_anatomic_link', 'text'],
  ['exposure_types', 'list'],
  ['repetition_level', 'text'],
  ['daily_exposure_hours', 'text'],
  ['shift_share_percent', 'text'],
  ['days_per_week', 'text'],
  ['work_pattern', 'text'],
  ['rest_distribution', 'text'],
  ['force_level', 'text'],
  ['awkward_posture_level', 'text'],
  ['static_holding_level', 'text'],
  ['direct_pressure_level', 'text'],
  ['vibration_exposure', 'text'],
  ['bk2101_cycle_seconds', 'text'],
  ['bk2101_repetition_per_hour', 'text'],
  ['bk2101_monotony', 'text'],
  ['bk2101_forced_dorsal_extension', 'text'],
  ['bk2101_prosupination', 'text'],
  ['bk2105_elbow_leaning', 'text'],
  ['bk2105_repeated_friction_impact', 'text'],
  ['bk2105_pressure_source', 'list'],
  ['bk2106_repeated_mechanical_exposure', 'text'],
  ['bk2106_noncorrectable_posture', 'text'],
  ['bk2106_prolonged_joint_position', 'text'],
  ['bk2106_pressure_source', 'list'],
  ['bk2103_vibration_tool_type', 'list'],
  ['bk2103_daily_vibration_hours', 'text'],
  ['bk2103_handheld_or_guided', 'text'],
  ['bk2103_tool_pressing', 'text'],
  ['bk2103_frequent_high_force_grip', 'text'],
];

/** bk2103_tool_pressing이 비었을 때 'yes'로 채우는 근거 필드. */
const ELBOW_TOOL_PRESSING_SOURCES = ['bk2103_frequent_high_force_grip', 'bk2106_tool_pressing', 'bk2106_frequent_high_force_grip'];

export function inferElbowBkTypeFromDiagnosis(diagnosis: UpperLimbDiagnosisLike = {}): string {
  const code = String(diagnosis.code || '').trim().toUpperCase();
  const name = String(diagnosis.name || '').trim();

  if (/^M77\.0/.test(code) || /^M77\.1/.test(code)) return 'BK2101';
  if (/^T75\.2/.test(code)) return 'BK2103';

  if (/점액낭염/.test(name)) return 'BK2105';
  if (/주관증후군|척골신경|압박성\s*단신경병증|단신경병증/.test(name)) return 'BK2106';
  if (/진동성\s*팔꿈치\s*관절병증|팔꿈치\s*골관절염|박리성\s*골연골염/.test(name)) return 'BK2103';
  if (/외측\s*상과염|내측\s*상과염|상과염|테니스\s*엘보|골프\s*엘보|부착부\s*건병증|삽입건병증/.test(name)) return 'BK2101';

  return '';
}

export function isElbowDiagnosis(diag: UpperLimbDiagnosisLike, activeModules: string[] = []): boolean {
  return resolveDiagnosisModule(diag, activeModules)?.moduleId === 'elbow';
}

/** 공용 데이터 팩토리(_shared/upperLimb/dataFactories)에 넘기는 이 모듈의 값. */
export const elbowDataConfig = {
  entryFields: ELBOW_ENTRY_FIELDS,
  branchFields: ELBOW_BRANCH_FIELDS,
  exposureTypeOptions: EXPOSURE_TYPE_OPTIONS,
  inferBkType: inferElbowBkTypeFromDiagnosis,
  isDiagnosis: isElbowDiagnosis,
  toolPressingSources: ELBOW_TOOL_PRESSING_SOURCES,
  diagnosesKey: 'elbowDiagnoses',
} satisfies UpperLimbDataConfig<'elbowDiagnoses'>;
