import { registerModule } from '../../core/moduleRegistry';
import { CervicalEvaluation } from './CervicalEvaluation';
import { createCervicalModuleData, createCervicalTask, EXPOSURE_TYPE_OPTIONS } from './utils/data';
import { computeCervicalCalc, isCervicalAssessmentComplete } from './utils/calculations';
import { cervicalExportHandlers } from './utils/exportHandlers';
import { ensureModule, parseYesNo, splitList } from '../../core/utils/batchImportHelpers';

const EXPOSURE_TYPE_LOOKUP = EXPOSURE_TYPE_OPTIONS.reduce((acc, option) => {
  acc[option.value] = option.value;
  acc[option.label] = option.value;
  return acc;
}, {});

function parseExposureTypes(value) {
  return splitList(value)
    .map(item => EXPOSURE_TYPE_LOOKUP[item] || item)
    .filter(mapped => EXPOSURE_TYPE_OPTIONS.some(option => option.value === mapped));
}

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
  batchImportConfig: {
    columns: {
      cervicalTaskName: ['경추_작업명', 'cervical_task_name'],
      cervicalExposureTypes: ['경추_노출유형', 'cervical_exposure_types'],
      cervicalLoadWeightKg: ['경추_하중(kg)', 'cervical_load_weight_kg'],
      cervicalCarryHoursPerShift: ['경추_교대당운반시간', 'cervical_carry_hours_per_shift'],
      cervicalForcedNeckPosture: ['경추_부자연스러운목자세강제', 'cervical_forced_neck_posture'],
      cervicalNeckNonneutralHours: ['경추_비중립정적자세시간', 'cervical_neck_nonneutral_hours_per_day'],
      cervicalCombinedFlexionRotationPosture: ['경추_굴곡신전회전측굴동시발생', 'cervical_combined_flexion_rotation_posture'],
      cervicalPrecisionWork: ['경추_고도의정밀작업', 'cervical_precision_work'],
      cervicalNotes: ['경추_메모', 'cervical_notes'],
    },
    applyRow({ patient, row, job, colMap, getCell, rowIndex }) {
      if (!job) return;

      const hasCervicalData = [
        colMap.cervicalTaskName,
        colMap.cervicalExposureTypes,
        colMap.cervicalLoadWeightKg,
        colMap.cervicalCarryHoursPerShift,
        colMap.cervicalForcedNeckPosture,
        colMap.cervicalNeckNonneutralHours,
        colMap.cervicalCombinedFlexionRotationPosture,
        colMap.cervicalPrecisionWork,
        colMap.cervicalNotes,
      ].some(index => getCell(row, index));
      if (!hasCervicalData) return;

      const cervicalData = ensureModule(patient, 'cervical');
      if (!Array.isArray(cervicalData.tasks)) {
        cervicalData.tasks = [];
      }

      const taskName = String(getCell(row, colMap.cervicalTaskName) || '').trim();
      const exposureTypes = parseExposureTypes(getCell(row, colMap.cervicalExposureTypes));
      const taskKey = taskName || `__row_${rowIndex}`;

      let task = (cervicalData.tasks || []).find(item =>
        item.sharedJobId === job.id
        && (item.name || '') === taskKey
      );

      if (!task) {
        const jobTaskCount = (cervicalData.tasks || []).filter(item => item.sharedJobId === job.id).length;
        task = createCervicalTask(jobTaskCount, job.id);
        task.name = taskName || task.name;
        cervicalData.tasks.push(task);
      }

      Object.assign(task, {
        sharedJobId: job.id,
        name: taskName || task.name,
        exposure_types: exposureTypes.length > 0 ? exposureTypes : (task.exposure_types || []),
        load_weight_kg: String(getCell(row, colMap.cervicalLoadWeightKg) || task.load_weight_kg || ''),
        carry_hours_per_shift: String(getCell(row, colMap.cervicalCarryHoursPerShift) || task.carry_hours_per_shift || ''),
        forced_neck_posture: parseYesNo(getCell(row, colMap.cervicalForcedNeckPosture), task.forced_neck_posture || ''),
        neck_nonneutral_hours_per_day: String(getCell(row, colMap.cervicalNeckNonneutralHours) || task.neck_nonneutral_hours_per_day || ''),
        combined_flexion_rotation_posture: parseYesNo(
          getCell(row, colMap.cervicalCombinedFlexionRotationPosture),
          task.combined_flexion_rotation_posture || ''
        ),
        precision_work: parseYesNo(getCell(row, colMap.cervicalPrecisionWork), task.precision_work || ''),
        notes: String(getCell(row, colMap.cervicalNotes) || task.notes || '').trim(),
      });
    },
  },
});
