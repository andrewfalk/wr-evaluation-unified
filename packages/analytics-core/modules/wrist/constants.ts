// src/modules/wrist/utils/data.js에서 이동한 순수 상수(계산·legacy-normalizer가 함께 필요).
// src/의 원본 data.js는 건드리지 않는다(§1-3 — syncWristModuleData가 _pendingPreset을
// BK 대표값 복사 로직과 같은 루프에 인터리브해서 쓰기 때문에 리팩터링 자체가 회귀 위험,
// elbow와 동일한 사유). 이 파일은 그 원본과 별개로 analytics-core 전용으로 새로 옮겨
// 적은 것 — 값은 동일해야 하며 derived.test.ts가 두 구현의 실제 출력 일치를 고정한다.

export interface OptionLike {
  value: string;
  label: string;
}

export const BK_TYPE_OPTIONS: OptionLike[] = [
  { value: '', label: '선택' },
  { value: 'BK2113', label: 'BK2113 수근관증후군' },
  { value: 'BK2101', label: 'BK2101 건초염/드퀘르벵/방아쇠수지' },
  { value: 'BK2103', label: 'BK2103 손목/손가락 관절병증' },
  { value: 'BK2106', label: 'BK2106 Guyon canal 압박성 신경병증' },
];

export const BK_TYPE_LABELS: Record<string, string> = Object.fromEntries(
  BK_TYPE_OPTIONS.filter((option) => option.value).map((option) => [option.value, option.label]),
);

export const EXPOSURE_TYPE_OPTIONS: OptionLike[] = [
  { value: 'repetition', label: '반복 동작' },
  { value: 'force', label: '힘 사용' },
  { value: 'awkward_posture', label: '부자연스러운 자세' },
];

export const EXPOSURE_TYPE_LABELS: Record<string, string> = Object.fromEntries(
  EXPOSURE_TYPE_OPTIONS.map((option) => [option.value, option.label]),
);

export const PRESSURE_SOURCE_OPTIONS: OptionLike[] = [
  { value: 'hard_surface', label: '딱딱한 표면' },
  { value: 'tool_edge', label: '공구 모서리' },
  { value: 'palm_contact', label: '손바닥 접촉' },
  { value: 'carrying_contact', label: '운반물 접촉' },
  { value: 'other', label: '기타' },
];

export const PRESSURE_SOURCE_LABELS: Record<string, string> = Object.fromEntries(
  PRESSURE_SOURCE_OPTIONS.map((option) => [option.value, option.label]),
);

export const VIBRATION_TOOL_OPTIONS: OptionLike[] = [
  { value: 'grinder', label: '그라인더' },
  { value: 'impact_wrench', label: '임팩트 렌치' },
  { value: 'hammer_drill', label: '해머 드릴' },
  { value: 'jackhammer', label: '착암기' },
  { value: 'polisher', label: '폴리셔' },
  { value: 'sander', label: '샌더' },
  { value: 'other', label: '기타' },
];

export const VIBRATION_TOOL_LABELS: Record<string, string> = Object.fromEntries(
  VIBRATION_TOOL_OPTIONS.map((option) => [option.value, option.label]),
);

// BK유형별 세부 분기 필드 — isComplete/missing 판정(getBranchRequiredFields)에 필요해
// legacy-normalizer/derived와 함께 이관한다.
export const WRIST_BRANCH_FIELDS: Record<string, string[]> = {
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
  BK2106: ['static_holding_level', 'direct_pressure_level', 'bk2106_pressure_source'],
};
