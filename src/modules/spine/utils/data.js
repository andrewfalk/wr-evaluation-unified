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

export const createSpineModuleData = () => ({
  tasks: [createTask(0)],
  aiAnalysisResult: null,
  formulaVersion: SPINE_FORMULA_V513
});
