// 어깨 모듈 전용 데이터

export const createShoulderDiagnosis = () => ({
  id: crypto.randomUUID(),
  code: '',
  name: '',
  side: '',
  confirmedCode: '',
  confirmedName: '',
  ellmanRight: '',
  ellmanLeft: '',
  confirmedRight: '',
  confirmedLeft: '',
  assessmentRight: '',
  assessmentLeft: '',
  reasonRight: [],
  reasonRightOther: '',
  reasonLeft: [],
  reasonLeftOther: ''
});

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

// 업무관련성 평가 낮음 사유 옵션 (무릎과 동일)
export const LOW_REASON_OPTIONS = [
  { value: 'unrelated', label: '신체부담과 관련없는 상병' },
  { value: 'mild', label: '상병 미확인/연령대비 경미' },
  { value: 'delayed', label: '업무중단 후 상당기간 경과' },
  { value: 'lowBurden', label: '누적 신체부담 낮음' },
  { value: 'other', label: '기타' }
];
