import { registerModule } from '../../core/moduleRegistry';
import { WristEvaluation } from './WristEvaluation';
import { createWristModuleData, createWristJobEvaluation } from './utils/data';
import { computeWristCalc, isWristAssessmentComplete } from './utils/calculations';
import { wristExportHandlers } from './utils/exportHandlers';

const PRESET_COMMON_FIELDS = [
  'main_task_name', 'direct_anatomic_link',
  'exposure_types', 'repetition_level',
  'daily_exposure_hours', 'shift_share_percent', 'days_per_week',
  'work_pattern', 'rest_distribution',
  'force_level', 'awkward_posture_level',
];

registerModule({
  id: 'wrist',
  name: '손목/손가락',
  icon: '✋',
  description: '손목 및 손가락 질환 공통 노출 평가',
  EvaluationComponent: WristEvaluation,
  createModuleData: createWristModuleData,
  computeCalc: computeWristCalc,
  isComplete: isWristAssessmentComplete,
  exportHandlers: wristExportHandlers,
  tabs: [
    { id: 'burden', label: '신체부담 평가' },
  ],
  presetConfig: {
    label: '손목 공통 노출',
    fields: [
      { key: 'main_task_name', label: '대표 문제 작업', type: 'string' },
      { key: 'daily_exposure_hours', label: '1일 노출시간', type: 'number' },
      { key: 'shift_share_percent', label: '근무시간 비중 (%)', type: 'number' },
      { key: 'work_pattern', label: '작업 형태', type: 'string' },
      { key: 'rest_distribution', label: '휴식 분포', type: 'string' },
      { key: 'force_level', label: '힘 사용', type: 'string' },
    ],
    extractFromModule(moduleData, sharedJobId) {
      const jobEval = (moduleData.jobEvaluations || []).find(j => j.sharedJobId === sharedJobId);
      if (!jobEval) return null;
      const entry = (jobEval.diagnosisEntries || []).find(e =>
        e.daily_exposure_hours || e.main_task_name || (e.exposure_types && e.exposure_types.length)
      );
      if (!entry) return null;

      const result = {};
      for (const key of PRESET_COMMON_FIELDS) {
        const val = entry[key];
        if (val !== undefined && val !== '' && val !== null && !(Array.isArray(val) && val.length === 0)) {
          result[key] = val;
        }
      }
      return Object.keys(result).length > 0 ? result : null;
    },
    applyToModule(moduleData, sharedJobId, presetData) {
      const jobEvals = [...(moduleData.jobEvaluations || [])];
      const idx = jobEvals.findIndex(j => j.sharedJobId === sharedJobId);
      if (idx < 0) {
        jobEvals.push({ ...createWristJobEvaluation(sharedJobId), _pendingPreset: presetData });
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
          if (presetData[key] !== undefined) patched[key] = presetData[key];
        }
        return patched;
      });
      jobEvals[idx] = jobEval;
      return { ...moduleData, jobEvaluations: jobEvals };
    },
  },
});
