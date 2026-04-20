import { registerModule } from '../../core/moduleRegistry';
import { SpineEvaluation } from './SpineEvaluation';
import { createSpineModuleData, createTask } from './utils/data';
import { computeSpineCalc, isSpineAssessmentComplete } from './utils/calculations';
import { spineExportHandlers } from './utils/exportHandlers';

registerModule({
  id: 'spine',
  name: '척추 (요추)',
  icon: '\u2695\uFE0F',
  description: 'MDDM 척추압박력 평가',
  EvaluationComponent: SpineEvaluation,
  createModuleData: createSpineModuleData,
  computeCalc: computeSpineCalc,
  isComplete: isSpineAssessmentComplete,
  exportHandlers: spineExportHandlers,
  tabs: [
    { id: 'tasks', label: '신체부담 평가' },
  ],
  presetConfig: {
    label: '척추 작업목록',
    fields: 'tasks',
    extractFromModule(moduleData, sharedJobId) {
      let tasks = (moduleData.tasks || []).filter(t => t.sharedJobId === sharedJobId);
      // 미귀속 태스크 폴백 (sharedJobId가 빈 레거시 데이터)
      if (!tasks.length) {
        const unlinked = (moduleData.tasks || []).filter(t => !t.sharedJobId);
        if (unlinked.length) tasks = unlinked;
      }
      if (!tasks.length) return null;
      return {
        tasks: tasks.map(({ name, posture, weight, frequency, timeValue, timeUnit, correctionFactor }) =>
          ({ name, posture, weight, frequency, timeValue, timeUnit, correctionFactor })),
      };
    },
    applyToModule(moduleData, sharedJobId, presetData) {
      const otherTasks = (moduleData.tasks || []).filter(t => t.sharedJobId !== sharedJobId);
      const newTasks = (presetData.tasks || []).map((t, i) => ({
        ...createTask(i, sharedJobId),
        ...t,
      }));
      return { ...moduleData, tasks: [...otherTasks, ...newTasks] };
    },
  },
});
