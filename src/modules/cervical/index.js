import { registerModule } from '../../core/moduleRegistry';
import { CervicalEvaluation } from './CervicalEvaluation';
import { createCervicalModuleData, createCervicalTask } from './utils/data';
import { computeCervicalCalc, isCervicalAssessmentComplete } from './utils/calculations';
import { cervicalExportHandlers } from './utils/exportHandlers';

registerModule({
  id: 'cervical',
  name: '경추(목)',
  icon: '👤',
  description: '경추 질환 공통 부담 노출 평가',
  EvaluationComponent: CervicalEvaluation,
  createModuleData: createCervicalModuleData,
  computeCalc: computeCervicalCalc,
  isComplete: isCervicalAssessmentComplete,
  exportHandlers: cervicalExportHandlers,
  tabs: [
    { id: 'burden', label: '부담 노출 평가' },
  ],
  presetConfig: {
    label: '경추 작업목록',
    fields: 'tasks',
    extractFromModule(moduleData, sharedJobId) {
      const tasks = (moduleData.tasks || []).filter(task => task.sharedJobId === sharedJobId);
      if (!tasks.length) return null;

      return {
        tasks: tasks.map(task => ({
          name: task.name,
          exposure_types: [...(task.exposure_types || [])],
          load_weight_kg: task.load_weight_kg,
          carry_hours_per_shift: task.carry_hours_per_shift,
          forced_neck_posture: task.forced_neck_posture,
          neck_nonneutral_hours_per_day: task.neck_nonneutral_hours_per_day,
          combined_flexion_rotation_posture: task.combined_flexion_rotation_posture,
          precision_work: task.precision_work,
          notes: task.notes,
        })),
      };
    },
    applyToModule(moduleData, sharedJobId, presetData) {
      // sharedJobId가 비어있는 레거시 태스크는 첫 직업에 귀속될 예정이므로 preset 적용 시 덮어씀
      const otherTasks = (moduleData.tasks || []).filter(task => task.sharedJobId && task.sharedJobId !== sharedJobId);
      const newTasks = (presetData.tasks || []).map((task, index) => ({
        ...createCervicalTask(index, sharedJobId),
        ...task,
        sharedJobId,
        exposure_types: [...(task.exposure_types || [])],
      }));

      return {
        ...moduleData,
        tasks: [...otherTasks, ...newTasks],
      };
    },
  },
});
