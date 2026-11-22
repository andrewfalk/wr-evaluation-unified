// 무릎 모듈 전용 데이터

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

// K-L 등급·낮음 사유 선택지는 core 평가 어휘로 옮겼다(Phase 2 P2-52) — 옛 import 경로(테스트)를 위해 다시 내보낸다.
export { KLG_OPTIONS, LOW_REASON_OPTIONS } from '../../../core/assessment/vocabulary';

// 보조변수 라벨
export const AUX_LABELS = {
  stairs: '계단오르내리기',
  kneeTwist: '무릎 비틀림',
  startStop: '출발/정지 반복',
  tightSpace: '좁은 공간',
  kneeContact: '무릎 접촉/충격',
  jumpDown: '뛰어내리기'
};
