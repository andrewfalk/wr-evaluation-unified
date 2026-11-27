// 손목 모듈 데이터의 고유 값(P2-69b) — 상수 표·엔트리 필드와 순서·분기 필드·BK 추론·상병 판정·공구 압박 보정 근거를
// 지금 값 그대로 적는다(규칙으로 생성하지 않는다). 팩토리·sync는 공용(_shared/upperLimb/dataFactories)이고,
// utils/data.ts가 이 값으로 공용 코드를 묶어 옛 이름 그대로 내보낸다. 두 모듈 config의 키 집합은 테스트가 같음을 지킨다.
import { resolveDiagnosisModule } from '../../../core/utils/diagnosisMapping';
import type { UpperLimbDataConfig, UpperLimbDiagnosisLike, UpperLimbEntryFieldKind } from '../../_shared/upperLimb/dataFactories';

export const BK_TYPE_OPTIONS = [
  { value: '', label: '선택' },
  { value: 'BK2113', label: 'BK2113 수근관증후군' },
  { value: 'BK2101', label: 'BK2101 건초염/드퀘르벵/방아쇠수지' },
  { value: 'BK2103', label: 'BK2103 손목/손가락 관절병증' },
  { value: 'BK2106', label: 'BK2106 Guyon canal 압박성 신경병증' },
];

export const BK_TYPE_LABELS = Object.fromEntries(
  BK_TYPE_OPTIONS.filter(option => option.value).map(option => [option.value, option.label])
);

export const EXPOSURE_TYPE_OPTIONS = [
  { value: 'repetition', label: '반복 동작' },
  { value: 'force', label: '힘 사용' },
  { value: 'awkward_posture', label: '부자연스러운 자세' },
];

export const EXPOSURE_TYPE_LABELS = Object.fromEntries(
  EXPOSURE_TYPE_OPTIONS.map(option => [option.value, option.label])
);

export const PRESSURE_SOURCE_OPTIONS = [
  { value: 'hard_surface', label: '딱딱한 표면' },
  { value: 'tool_edge', label: '공구 모서리' },
  { value: 'palm_contact', label: '손바닥 접촉' },
  { value: 'carrying_contact', label: '운반물 접촉' },
  { value: 'other', label: '기타' },
];

export const PRESSURE_SOURCE_LABELS = Object.fromEntries(
  PRESSURE_SOURCE_OPTIONS.map(option => [option.value, option.label])
);

export const VIBRATION_TOOL_OPTIONS = [
  { value: 'grinder', label: '그라인더' },
  { value: 'impact_wrench', label: '임팩트 렌치' },
  { value: 'hammer_drill', label: '해머 드릴' },
  { value: 'jackhammer', label: '착암기' },
  { value: 'polisher', label: '폴리셔' },
  { value: 'sander', label: '샌더' },
  { value: 'other', label: '기타' },
];

export const VIBRATION_TOOL_LABELS = Object.fromEntries(
  VIBRATION_TOOL_OPTIONS.map(option => [option.value, option.label])
);

export const WRIST_BRANCH_FIELDS = {
  BK2113: ['bk2113_repetitive_wrist_motion'],
  BK2101: [
    'bk2101_cycle_seconds',
    'bk2101_monotony',
    'static_holding_level',
    'bk2101_forced_dorsal_extension',
    'bk2101_prosupination',
  ],
  BK2103: [
    'vibration_exposure',
    'bk2103_vibration_tool_type',
    'bk2103_daily_vibration_hours',
    'bk2103_tool_pressing',
  ],
  BK2106: [
    'static_holding_level',
    'direct_pressure_level',
    'bk2106_pressure_source',
  ],
};

/** 엔트리 필드(diagnosisId·selectedBkType·bkSelectionMode 다음)와 순서 — 옛 createWristDiagnosisEntry의 순서 그대로. */
const WRIST_ENTRY_FIELDS: ReadonlyArray<readonly [string, UpperLimbEntryFieldKind]> = [
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
  ['bk2113_repetitive_wrist_motion', 'text'],
  ['bk2101_cycle_seconds', 'text'],
  ['bk2101_repetition_per_hour', 'text'],
  ['bk2101_monotony', 'text'],
  ['bk2101_forced_dorsal_extension', 'text'],
  ['bk2101_prosupination', 'text'],
  ['bk2106_pressure_source', 'list'],
  ['bk2103_vibration_tool_type', 'list'],
  ['bk2103_daily_vibration_hours', 'text'],
  ['bk2103_tool_pressing', 'text'],
  ['bk2103_frequent_high_force_grip', 'text'],
];

/** bk2103_tool_pressing이 비었을 때 'yes'로 채우는 근거 필드. */
const WRIST_TOOL_PRESSING_SOURCES = ['bk2103_frequent_high_force_grip'];

export function inferWristBkTypeFromDiagnosis(diagnosis: UpperLimbDiagnosisLike = {}): string {
  const code = String(diagnosis.code || '').trim().toUpperCase();
  const name = String(diagnosis.name || '').trim();

  if (code === 'G56.0' || /수근관|carpal tunnel|cts/i.test(name)) return 'BK2113';

  if (code === 'M65.3' || code === 'M65.4') return 'BK2101';
  if (/방아쇠|trigger finger|trigger thumb|드퀘르벵|de quervain|건초염|tenosynovitis|tendovaginitis/i.test(name)) {
    return 'BK2101';
  }

  if (/kienb[oö]ck|월상골|손목.*관절|wrist arthrosis|wrist arthropathy|손가락.*관절|finger arthrosis|finger arthropathy|hand arthropathy|손가락.*관절염|수지.*관절염|수부.*관절염|finger arthritis|hand arthritis|DIP arthritis|PIP arthritis/i.test(name)) {
    return 'BK2103';
  }

  if (/guyon|기용관|ulnar neuropathy at wrist|손목.*척골신경/i.test(name)) return 'BK2106';
  if (code === 'G56.2' && /손목|기용관|guyon|wrist/i.test(name)) return 'BK2106';

  return '';
}

export function isWristDiagnosis(diag: UpperLimbDiagnosisLike, activeModules: string[] = []): boolean {
  const resolved = resolveDiagnosisModule(diag, activeModules);
  if (resolved?.moduleId === 'wrist') return true;
  if (diag?.moduleId === '__none__' || resolved) return false;
  return Boolean(inferWristBkTypeFromDiagnosis(diag));
}

/** 공용 데이터 팩토리(_shared/upperLimb/dataFactories)에 넘기는 이 모듈의 값. */
export const wristDataConfig = {
  entryFields: WRIST_ENTRY_FIELDS,
  branchFields: WRIST_BRANCH_FIELDS,
  exposureTypeOptions: EXPOSURE_TYPE_OPTIONS,
  inferBkType: inferWristBkTypeFromDiagnosis,
  isDiagnosis: isWristDiagnosis,
  toolPressingSources: WRIST_TOOL_PRESSING_SOURCES,
  diagnosesKey: 'wristDiagnoses',
} satisfies UpperLimbDataConfig<'wristDiagnoses'>;
