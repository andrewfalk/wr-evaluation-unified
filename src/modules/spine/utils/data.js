// 척추 모듈 전용 데이터

export const createTask = (index = 0) => ({
  id: Date.now() + Math.random(),
  name: `작업 ${index + 1}`,
  posture: 'G1',
  weight: 15,
  frequency: 80,
  timeValue: 5,
  timeUnit: 'sec',
  correctionFactor: 1.0,
  force: 0
});

export const createSpineModuleData = () => ({
  tasks: [createTask(0)],
  aiAnalysisResult: null
});
