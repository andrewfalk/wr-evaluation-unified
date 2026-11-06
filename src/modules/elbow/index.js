import { registerModule } from '../../core/moduleRegistry';
import { ElbowEvaluation } from './ElbowEvaluation';
import { createElbowModuleData, createElbowJobEvaluation, createElbowDiagnosisEntry } from './utils/data';
import { computeElbowCalc, isElbowAssessmentComplete } from './utils/calculations';
import { ensureModule, splitList, parseDate } from '../../core/utils/batchImportHelpers';

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
  icon: '💪',
  description: '팔꿈치 질환 공통 신체부담 평가',
  EvaluationComponent: ElbowEvaluation,
  createModuleData: createElbowModuleData,
  computeCalc: computeElbowCalc,
  isComplete: isElbowAssessmentComplete,
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
  batchImportConfig: {
    columns: {
      elbowRecentTaskChange: ['팔꿈치_시간적선후관계_최근작업변화', 'elbow_recent_task_change'],
      elbowTaskChangeDate: ['팔꿈치_시간적선후관계_작업변화시점', 'elbow_task_change_date'],
      elbowSymptomOnsetInterval: ['팔꿈치_시간적선후관계_증상발생까지기간', 'elbow_symptom_onset_interval'],
      elbowImprovesWithRest: ['팔꿈치_시간적선후관계_휴식시호전', 'elbow_improves_with_rest'],
      elbowBkType: ['팔꿈치_bk유형', 'elbow_bk_type'],
      elbowBkSelectionMode: ['팔꿈치_bk선택방식'],
      elbowMainTaskName: ['팔꿈치_문제작업명', 'elbow_main_task_name'],
      elbowDirectAnatomicLink: ['팔꿈치_핵심동작연결성', 'elbow_direct_anatomic_link'],
      elbowExposureTypes: ['팔꿈치_공통핵심노출유형', '팔꿈치_핵심노출유형', 'elbow_exposure_types'],
      elbowRepetitionLevel: ['팔꿈치_반복동작정도'],
      elbowDailyExposureHours: ['팔꿈치_1일노출시간', 'elbow_daily_exposure_hours'],
      elbowShiftSharePercent: ['팔꿈치_하루작업비중', '팔꿈치_교대비율', 'elbow_shift_share_percent'],
      elbowDaysPerWeek: ['팔꿈치_주당수행일수', 'elbow_days_per_week'],
      elbowWorkPattern: ['팔꿈치_작업형태', 'elbow_work_pattern'],
      elbowRestDistribution: ['팔꿈치_휴식분포', 'elbow_rest_distribution'],
      elbowForceLevel: ['팔꿈치_힘사용', 'elbow_force_level'],
      elbowAwkwardPostureLevel: ['팔꿈치_비중립자세', 'elbow_awkward_posture_level'],
      elbowStaticHoldingLevel: ['팔꿈치_정적유지', 'elbow_static_holding_level'],
      elbowDirectPressureLevel: ['팔꿈치_직접압박수준', 'elbow_direct_pressure_level'],
      elbowVibrationExposure: ['팔꿈치_진동노출', 'elbow_vibration_exposure'],
      elbowBk2101CycleSeconds: ['팔꿈치_bk2101_주기초', 'elbow_bk2101_cycle_seconds'],
      elbowBk2101RepetitionPerHour: ['팔꿈치_bk2101_시간당반복횟수', 'elbow_bk2101_repetition_per_hour'],
      elbowBk2101Monotony: ['팔꿈치_bk2101_단조반복', 'elbow_bk2101_monotony'],
      elbowBk2101ForcedDorsalExtension: ['팔꿈치_bk2101_배측굴곡', 'elbow_bk2101_forced_dorsal_extension'],
      elbowBk2101Prosupination: ['팔꿈치_bk2101_회내회외', 'elbow_bk2101_prosupination'],
      elbowBk2105ElbowLeaning: ['팔꿈치_bk2105_팔꿈치지지', 'elbow_bk2105_elbow_leaning'],
      elbowBk2105RepeatedFrictionImpact: ['팔꿈치_bk2105_반복마찰충격', 'elbow_bk2105_repeated_friction_impact'],
      elbowBk2105PressureSource: ['팔꿈치_bk2105_압박원인', 'elbow_bk2105_pressure_source'],
      elbowBk2106RepeatedMechanicalExposure: ['팔꿈치_bk2106_반복기계적부담', 'elbow_bk2106_repeated_mechanical_exposure'],
      elbowBk2106NoncorrectablePosture: ['팔꿈치_bk2106_강제자세', 'elbow_bk2106_noncorrectable_posture'],
      elbowBk2106ProlongedJointPosition: ['팔꿈치_bk2106_관절자세유지', 'elbow_bk2106_prolonged_joint_position'],
      elbowBk2106PressureSource: ['팔꿈치_bk2106_압박원인', 'elbow_bk2106_pressure_source'],
      elbowBk2106ToolPressing: ['팔꿈치_bk2106_공구압박', 'elbow_bk2106_tool_pressing'],
      elbowBk2106FrequentHighForceGrip: ['팔꿈치_bk2106_고힘그립', 'elbow_bk2106_frequent_high_force_grip'],
      elbowBk2103VibrationToolType: ['팔꿈치_bk2103_진동공구종류', 'elbow_bk2103_vibration_tool_type'],
      elbowBk2103DailyVibrationHours: ['팔꿈치_bk2103_진동시간', 'elbow_bk2103_daily_vibration_hours'],
      elbowBk2103HandheldOrGuided: ['팔꿈치_bk2103_손유도공구', 'elbow_bk2103_handheld_or_guided'],
      elbowBk2103ToolPressing: ['팔꿈치_bk2103_공구를강하게쥐거나누르면서사용하는작업', '팔꿈치_bk2103_공구압박', 'elbow_bk2103_tool_pressing'],
      elbowBk2103FrequentHighForceGrip: ['팔꿈치_bk2103_강하게쥐는동작반복', '팔꿈치_bk2103_고힘그립', 'elbow_bk2103_frequent_high_force_grip'],
    },
    applyRow({ patient, row, diagnosis, job, colMap, getCell }) {
      if (!diagnosis || !job) return;

      const hasElbowData = [
        colMap.elbowBkType,
        colMap.elbowMainTaskName,
        colMap.elbowExposureTypes,
        colMap.elbowRecentTaskChange,
      ].some(index => getCell(row, index));
      if (!hasElbowData) return;

      const elbowData = ensureModule(patient, 'elbow');
      if (!elbowData.temporalSequence) {
        elbowData.temporalSequence = elbowData.temporalRelation || createElbowModuleData().temporalSequence;
      }
      if (!Array.isArray(elbowData.jobEvaluations)) {
        elbowData.jobEvaluations = [];
      }

      let jobEvaluation = elbowData.jobEvaluations.find(item => item.sharedJobId === job.id);
      if (!jobEvaluation) {
        jobEvaluation = createElbowJobEvaluation(job.id);
        elbowData.jobEvaluations.push(jobEvaluation);
      }
      if (!Array.isArray(jobEvaluation.diagnosisEntries)) {
        jobEvaluation.diagnosisEntries = [];
      }

      let entry = jobEvaluation.diagnosisEntries.find(item => item.diagnosisId === diagnosis.id);
      if (!entry) {
        entry = createElbowDiagnosisEntry(diagnosis);
        jobEvaluation.diagnosisEntries.push(entry);
      }

      const bk2103ToolPressing =
        String(
          getCell(row, colMap.elbowBk2103ToolPressing)
          || getCell(row, colMap.elbowBk2103FrequentHighForceGrip)
          || getCell(row, colMap.elbowBk2106ToolPressing)
          || entry.bk2103_tool_pressing
          || ''
        ).trim();

      Object.assign(entry, {
        selectedBkType: String(getCell(row, colMap.elbowBkType) || entry.selectedBkType || '').trim(),
        bkSelectionMode: String(getCell(row, colMap.elbowBkSelectionMode) || entry.bkSelectionMode || 'manual').trim() || 'manual',
        main_task_name: String(getCell(row, colMap.elbowMainTaskName) || entry.main_task_name || '').trim(),
        direct_anatomic_link: String(getCell(row, colMap.elbowDirectAnatomicLink) || entry.direct_anatomic_link || '').trim(),
        exposure_types: splitList(getCell(row, colMap.elbowExposureTypes)).length ? splitList(getCell(row, colMap.elbowExposureTypes)) : (entry.exposure_types || []),
        repetition_level: String(getCell(row, colMap.elbowRepetitionLevel) || entry.repetition_level || '').trim(),
        daily_exposure_hours: String(getCell(row, colMap.elbowDailyExposureHours) || entry.daily_exposure_hours || ''),
        shift_share_percent: String(getCell(row, colMap.elbowShiftSharePercent) || entry.shift_share_percent || ''),
        days_per_week: String(getCell(row, colMap.elbowDaysPerWeek) || entry.days_per_week || ''),
        work_pattern: String(getCell(row, colMap.elbowWorkPattern) || entry.work_pattern || '').trim(),
        rest_distribution: String(getCell(row, colMap.elbowRestDistribution) || entry.rest_distribution || '').trim(),
        force_level: String(getCell(row, colMap.elbowForceLevel) || entry.force_level || '').trim(),
        awkward_posture_level: String(getCell(row, colMap.elbowAwkwardPostureLevel) || entry.awkward_posture_level || '').trim(),
        static_holding_level: String(getCell(row, colMap.elbowStaticHoldingLevel) || entry.static_holding_level || '').trim(),
        direct_pressure_level: String(getCell(row, colMap.elbowDirectPressureLevel) || entry.direct_pressure_level || '').trim(),
        vibration_exposure: String(getCell(row, colMap.elbowVibrationExposure) || entry.vibration_exposure || '').trim(),
        bk2101_cycle_seconds: String(getCell(row, colMap.elbowBk2101CycleSeconds) || entry.bk2101_cycle_seconds || ''),
        bk2101_repetition_per_hour: String(getCell(row, colMap.elbowBk2101RepetitionPerHour) || entry.bk2101_repetition_per_hour || ''),
        bk2101_monotony: String(getCell(row, colMap.elbowBk2101Monotony) || entry.bk2101_monotony || '').trim(),
        bk2101_forced_dorsal_extension: String(getCell(row, colMap.elbowBk2101ForcedDorsalExtension) || entry.bk2101_forced_dorsal_extension || '').trim(),
        bk2101_prosupination: String(getCell(row, colMap.elbowBk2101Prosupination) || entry.bk2101_prosupination || '').trim(),
        bk2105_elbow_leaning: String(getCell(row, colMap.elbowBk2105ElbowLeaning) || entry.bk2105_elbow_leaning || '').trim(),
        bk2105_pressure_source: splitList(getCell(row, colMap.elbowBk2105PressureSource)).length ? splitList(getCell(row, colMap.elbowBk2105PressureSource)) : (entry.bk2105_pressure_source || []),
        bk2106_pressure_source: splitList(getCell(row, colMap.elbowBk2106PressureSource)).length ? splitList(getCell(row, colMap.elbowBk2106PressureSource)) : (entry.bk2106_pressure_source || []),
        bk2103_vibration_tool_type: splitList(getCell(row, colMap.elbowBk2103VibrationToolType)).length ? splitList(getCell(row, colMap.elbowBk2103VibrationToolType)) : (entry.bk2103_vibration_tool_type || []),
        bk2103_daily_vibration_hours: String(getCell(row, colMap.elbowBk2103DailyVibrationHours) || entry.bk2103_daily_vibration_hours || ''),
        bk2103_tool_pressing: bk2103ToolPressing,
      });

      if (getCell(row, colMap.elbowRecentTaskChange)) {
        elbowData.temporalSequence.recent_task_change = String(getCell(row, colMap.elbowRecentTaskChange)).trim();
      }
      if (getCell(row, colMap.elbowTaskChangeDate)) {
        elbowData.temporalSequence.task_change_date = parseDate(getCell(row, colMap.elbowTaskChangeDate));
      }
      if (getCell(row, colMap.elbowSymptomOnsetInterval)) {
        elbowData.temporalSequence.symptom_onset_interval = String(getCell(row, colMap.elbowSymptomOnsetInterval)).trim();
      }
      if (getCell(row, colMap.elbowImprovesWithRest)) {
        elbowData.temporalSequence.improves_with_rest = String(getCell(row, colMap.elbowImprovesWithRest)).trim();
      }
    },
  },
});
