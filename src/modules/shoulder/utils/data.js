// 어깨 모듈 전용 데이터

export const createShoulderJobExtras = (sharedJobId = '') => ({
  sharedJobId,
  overheadHours: '',
  repetitiveMediumHours: '',
  repetitiveFastHours: '',
  heavyLoadCount: '',    // 횟수/일
  heavyLoadSeconds: '',  // 초/회
  vibrationHours: '',
  evidenceSources: [],
});

export const createShoulderModuleData = () => ({
  jobExtras: [],
  returnConsiderations: ''
});

// Ellman Classification 옵션
export const ELLMAN_OPTIONS = [
  { value: '', label: '선택' },
  { value: 'N/A', label: '해당없음' },
  { value: 'Grade 1', label: 'Grade 1' },
  { value: 'Grade 2', label: 'Grade 2' },
  { value: 'Grade 3', label: 'Grade 3' },
  { value: 'Full', label: 'Full' },
];

// 업무관련성 평가 낮음 사유 선택지(무릎과 동일)는 core 평가 어휘로 옮겼다(Phase 2 P2-52) — 옛 import 경로(테스트)를 위해 다시 내보낸다.
export { LOW_REASON_OPTIONS } from '../../../core/assessment/vocabulary';
