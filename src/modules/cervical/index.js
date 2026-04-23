import { registerModule } from '../../core/moduleRegistry';
import { CervicalEvaluation } from './CervicalEvaluation';
import { createCervicalJobEvaluation, createCervicalModuleData } from './utils/data';
import { computeCervicalCalc, isCervicalAssessmentComplete } from './utils/calculations';
import { cervicalExportHandlers } from './utils/exportHandlers';

const PRESET_COMMON_FIELDS = [
  'main_task_name',
  'exposure_types',
  'load_weight_kg',
  'carry_hours_per_shift',
  'forced_neck_posture',
  'neck_flexion_hours_per_day',
  'combined_flexion_rotation_posture',
  'precision_work',
];

function clonePresetValue(value) {
  return Array.isArray(value) ? [...value] : value;
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
    label: '경추 공통 노출',
    fields: [
      { key: 'main_task_name', label: '대표 문제 작업', type: 'string' },
      { key: 'load_weight_kg', label: '하중 (kg)', type: 'number' },
      { key: 'carry_hours_per_shift', label: '교대당 운반 시간', type: 'number' },
      { key: 'forced_neck_posture', label: '부자연스러운 목 자세 강제', type: 'string' },
      { key: 'neck_flexion_hours_per_day', label: '비중립 정적 자세 시간', type: 'number' },
      { key: 'combined_flexion_rotation_posture', label: '굴곡/신전+회전/측굴 동시 발생', type: 'string' },
      { key: 'precision_work', label: '고도의 정밀 작업', type: 'string' },
    ],
    extractFromModule(moduleData, sharedJobId) {
      const jobEval = (moduleData.jobEvaluations || []).find(j => j.sharedJobId === sharedJobId);
      if (!jobEval) return null;

      const entry = (jobEval.diagnosisEntries || []).find(e =>
        e.main_task_name
        || (e.exposure_types && e.exposure_types.length)
        || e.load_weight_kg
        || e.carry_hours_per_shift
        || e.neck_flexion_hours_per_day
      );
      if (!entry) return null;

      const result = {};
      for (const key of PRESET_COMMON_FIELDS) {
        const val = entry[key];
        if (val !== undefined && val !== '' && val !== null && !(Array.isArray(val) && val.length === 0)) {
          result[key] = clonePresetValue(val);
        }
      }
      return Object.keys(result).length > 0 ? result : null;
    },
    applyToModule(moduleData, sharedJobId, presetData) {
      const jobEvals = [...(moduleData.jobEvaluations || [])];
      const idx = jobEvals.findIndex(j => j.sharedJobId === sharedJobId);
      if (idx < 0) {
        jobEvals.push({ ...createCervicalJobEvaluation(sharedJobId), _pendingPreset: presetData });
        return { ...moduleData, jobEvaluations: jobEvals };
      }

      const jobEval = { ...jobEvals[idx] };
      if (!jobEval.diagnosisEntries || jobEval.diagnosisEntries.length === 0) {
        jobEval._pendingPreset = presetData;
        jobEvals[idx] = jobEval;
        return { ...moduleData, jobEvaluations: jobEvals };
      }

      jobEval.diagnosisEntries = jobEval.diagnosisEntries.map(entry => {
        const patched = { ...entry };
        for (const key of PRESET_COMMON_FIELDS) {
          if (presetData[key] !== undefined) patched[key] = clonePresetValue(presetData[key]);
        }
        return patched;
      });
      jobEvals[idx] = jobEval;
      return { ...moduleData, jobEvaluations: jobEvals };
    },
  },
});
