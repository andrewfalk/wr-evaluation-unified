import { registerModule } from '../../core/moduleRegistry';
import { ElbowEvaluation } from './ElbowEvaluation';
import { createElbowModuleData, createElbowJobEvaluation } from './utils/data';
import { computeElbowCalc, isElbowAssessmentComplete } from './utils/calculations';
import { elbowExportHandlers } from './utils/exportHandlers';

// 프리셋에 저장할 공통 노출 필드 (BK 유형과 무관한 직업 물리부담 정보)
const PRESET_COMMON_FIELDS = [
  'main_task_name', 'direct_anatomic_link',
  'exposure_types', 'repetition_level',
  'daily_exposure_hours', 'shift_share_percent', 'days_per_week',
  'work_pattern', 'rest_distribution',
  'force_level', 'awkward_posture_level',
];

registerModule({
  id: 'elbow',
  name: '팔꿈치',
  icon: '🦾',
  description: '팔꿈치 질환 공통 신체부담 평가',
  EvaluationComponent: ElbowEvaluation,
  createModuleData: createElbowModuleData,
  computeCalc: computeElbowCalc,
  isComplete: isElbowAssessmentComplete,
  exportHandlers: elbowExportHandlers,
  tabs: [
    { id: 'burden', label: '신체부담 평가' },
  ],
  presetConfig: {
    label: '팔꿈치 공통 노출',
    fields: [
      { key: 'main_task_name', label: '핵심 문제 작업', type: 'string' },
      { key: 'daily_exposure_hours', label: '1일 노출시간', type: 'number' },
      { key: 'shift_share_percent', label: '근무시간 비중 (%)', type: 'number' },
      { key: 'work_pattern', label: '작업 형태', type: 'string' },
      { key: 'rest_distribution', label: '휴식 분포', type: 'string' },
      { key: 'force_level', label: '힘 수준', type: 'string' },
    ],
    extractFromModule(moduleData, sharedJobId) {
      const jobEval = (moduleData.jobEvaluations || []).find(j => j.sharedJobId === sharedJobId);
      if (!jobEval) return null;
      // 첫 번째 유효 entry에서 공통 필드 추출
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
        // jobEvaluation이 아직 없음 → 생성하고 _pendingPreset으로 보관
        jobEvals.push({ ...createElbowJobEvaluation(sharedJobId), _pendingPreset: presetData });
        return { ...moduleData, jobEvaluations: jobEvals };
      }
      const jobEval = { ...jobEvals[idx] };
      if (!jobEval.diagnosisEntries || jobEval.diagnosisEntries.length === 0) {
        // 진단 엔트리 미생성 → _pendingPreset으로 보관
        jobEval._pendingPreset = presetData;
        jobEvals[idx] = jobEval;
        return { ...moduleData, jobEvaluations: jobEvals };
      }
      // 기존 엔트리에 공통 필드 직접 적용
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
