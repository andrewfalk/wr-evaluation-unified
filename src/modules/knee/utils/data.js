// 무릎 모듈 전용 데이터

export const createKneeDiagnosis = () => ({
  id: crypto.randomUUID(),
  code: '',
  name: '',
  side: '',
  confirmedCode: '',
  confirmedName: '',
  klgRight: '',
  klgLeft: '',
  confirmedRight: '',
  confirmedLeft: '',
  assessmentRight: '',
  assessmentLeft: '',
  reasonRight: [],
  reasonRightOther: '',
  reasonLeft: [],
  reasonLeftOther: ''
});

// 구형식 호환용 (BatchImportModal 마이그레이션 전까지)
export const createJob = () => ({
  id: crypto.randomUUID(),
  jobName: '',
  presetId: null,
  startDate: '',
  endDate: '',
  workPeriodOverride: '',
  evidenceSources: [],
  weight: '',
  squatting: '',
  stairs: false,
  kneeTwist: false,
  startStop: false,
  tightSpace: false,
  kneeContact: false,
  jumpDown: false
});

export const createKneeJobExtras = (sharedJobId = '') => ({
  sharedJobId,
  weight: '',
  squatting: '',
  evidenceSources: [],
  stairs: false,
  kneeTwist: false,
  startStop: false,
  tightSpace: false,
  kneeContact: false,
  jumpDown: false,
});

export const createKneeModuleData = () => ({
  jobExtras: [],
  returnConsiderations: ''
});

// KLG 옵션
export const KLG_OPTIONS = [
  { value: '', label: '선택' },
  { value: 'N/A', label: '해당없음' },
  { value: '1', label: '1등급' },
  { value: '2', label: '2등급' },
  { value: '3', label: '3등급' },
  { value: '4', label: '4등급' }
];

// 업무관련성 평가 낮음 사유 옵션
export const LOW_REASON_OPTIONS = [
  { value: 'unrelated', label: '신체부담과 관련없는 상병' },
  { value: 'mild', label: '상병 미확인/연령대비 경미' },
  { value: 'delayed', label: '업무중단 후 상당기간 경과' },
  { value: 'lowBurden', label: '누적 신체부담 낮음' },
  { value: 'other', label: '기타' }
];

// 보조변수 라벨
export const AUX_LABELS = {
  stairs: '계단오르내리기',
  kneeTwist: '무릎 비틀림',
  startStop: '출발/정지 반복',
  tightSpace: '좁은 공간',
  kneeContact: '무릎 접촉/충격',
  jumpDown: '뛰어내리기'
};

// Fallback Presets
export const FALLBACK_PRESETS = [
  { id: 1, jobName: "건설 현장 배근공", category: "건설업", weight: 2500, squatting: 180, source: "Fallback" },
  { id: 2, jobName: "기계 조립원", category: "제조업", weight: 1500, squatting: 120, source: "Fallback" },
  { id: 3, jobName: "포장작업원", category: "제조업", weight: 300, squatting: 60, source: "Fallback" }
];
