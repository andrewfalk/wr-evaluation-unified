// 프리셋 파일(public/job-presets.json)을 불러오지 못했을 때 쓰는 기본 프리셋 3건(REFACTORING_ROADMAP Phase 2 C6, P2-53).
// 값은 옛 src/modules/knee/utils/data.js의 FALLBACK_PRESETS 그대로다. usePresetManagement가 normalizeBuiltinPreset으로 정규화해 쓴다
// (무릎 중량물·쪼그려앉기 값만 담긴 옛 내장 프리셋 형식).

export interface FallbackPreset {
  readonly id: number;
  readonly jobName: string;
  readonly category: string;
  readonly weight: number;
  readonly squatting: number;
  readonly source: string;
}

export const FALLBACK_PRESETS: readonly FallbackPreset[] = [
  { id: 1, jobName: '건설 현장 배근공', category: '건설업', weight: 2500, squatting: 180, source: 'Fallback' },
  { id: 2, jobName: '기계 조립원', category: '제조업', weight: 1500, squatting: 120, source: 'Fallback' },
  { id: 3, jobName: '포장작업원', category: '제조업', weight: 300, squatting: 60, source: 'Fallback' },
];
