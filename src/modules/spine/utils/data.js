// 척추 모듈 전용 데이터
import { SPINE_FORMULA_V513 } from './formulaVersion';

export const createTask = (index = 0, sharedJobId = '') => ({
  id: Date.now() + Math.random(),
  name: `작업 ${index + 1}`,
  posture: 'G1',
  weight: 15,
  frequency: 80,
  timeValue: 5,
  timeUnit: 'sec',
  correctionFactor: 1.0,
  force: 0,
  sharedJobId
});

// 전신진동(BK 2110) 노출 구간. aw는 대표 진동가속도의 하한/상한 범위.
// timeValue는 1일 총 노출시간(MDDM의 timeValue×frequency 구조와 다름 — frequency 없음).
export const createVibrationInterval = (index = 0, sharedJobId = '') => ({
  id: Date.now() + Math.random(),
  name: `진동작업 ${index + 1}`,
  awMin: 0.5,
  awMax: 0.8,
  timeValue: 4,
  timeUnit: 'hr',
  sharedJobId
});

export const createSpineModuleData = () => ({
  // 평가 수행 여부 3상태 (대칭): 'unknown'(미평가) | 'none'(노출없음) | 'present'(노출있음)
  // MDDM(요추 압박력)은 대다수 케이스에서 수행하므로 기본 'present'로 입력창을 바로 연다.
  mddmStatus: 'present',
  vibrationExposureStatus: 'unknown',
  // UI 편집 탭 상태 (계산 분기가 아님): 'mddm' | 'wbv'
  activeSpineTab: 'mddm',
  tasks: [createTask(0)],      // MDDM 작업 — 편집 편의상 1개로 시작(출력/완료는 mddmStatus로 게이트)
  vibrationIntervals: [],      // WBV 노출 구간 — '노출있음' 전환 시 UI가 첫 구간 seed
  aiAnalysisResult: null,
  formulaVersion: SPINE_FORMULA_V513
});
