import { registerModule } from '../../core/moduleRegistry';
import { WristEvaluation } from './WristEvaluation';
import { createWristModuleData, createWristJobEvaluation, createWristDiagnosisEntry } from './utils/data';
import { computeWristCalc, isWristAssessmentComplete } from './utils/calculations';
import { wristExportHandlers } from './utils/exportHandlers';
import { ensureModule, splitList, parseDate } from '../../core/utils/batchImportHelpers';

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
  batchImportConfig: {
    columns: {
      wristRecentTaskChange: ['손목_시간적선후관계_최근작업변화', 'wrist_recent_task_change'],
      wristTaskChangeDate: ['손목_시간적선후관계_작업변화시점', 'wrist_task_change_date'],
      wristSymptomOnsetInterval: ['손목_시간적선후관계_증상발생까지기간', 'wrist_symptom_onset_interval'],
      wristImprovesWithRest: ['손목_시간적선후관계_휴식시호전', 'wrist_improves_with_rest'],
      wristBkType: ['손목_bk유형', 'wrist_bk_type'],
      wristBkSelectionMode: ['손목_bk선택방식', 'wrist_bk_selection_mode'],
      wristMainTaskName: ['손목_문제작업명', 'wrist_main_task_name'],
      wristDirectAnatomicLink: ['손목_핵심동작연결성', 'wrist_direct_anatomic_link'],
      wristExposureTypes: ['손목_공통핵심노출유형', '손목_핵심노출유형', 'wrist_exposure_types'],
      wristRepetitionLevel: ['손목_반복동작정도', 'wrist_repetition_level'],
      wristDailyExposureHours: ['손목_1일노출시간', 'wrist_daily_exposure_hours'],
      wristShiftSharePercent: ['손목_하루작업비중', '손목_근무시간비중', 'wrist_shift_share_percent'],
      wristDaysPerWeek: ['손목_주당수행일수', 'wrist_days_per_week'],
      wristWorkPattern: ['손목_작업형태', 'wrist_work_pattern'],
      wristRestDistribution: ['손목_휴식분포', 'wrist_rest_distribution'],
      wristForceLevel: ['손목_힘사용', 'wrist_force_level'],
      wristAwkwardPostureLevel: ['손목_비중립자세', 'wrist_awkward_posture_level'],
      wristStaticHoldingLevel: ['손목_정적유지', 'wrist_static_holding_level'],
      wristDirectPressureLevel: ['손목_직접압박수준', 'wrist_direct_pressure_level'],
      wristVibrationExposure: ['손목_진동노출', 'wrist_vibration_exposure'],
      wristBk2113RepetitiveMotion: ['손목_bk2113_반복손목운동', 'wrist_bk2113_repetitive_wrist_motion'],
      wristBk2101CycleSeconds: ['손목_bk2101_주기초', 'wrist_bk2101_cycle_seconds'],
      wristBk2101RepetitionPerHour: ['손목_bk2101_시간당반복횟수', 'wrist_bk2101_repetition_per_hour'],
      wristBk2101Monotony: ['손목_bk2101_단조반복', 'wrist_bk2101_monotony'],
      wristBk2101ForcedDorsalExtension: ['손목_bk2101_배측굴곡', 'wrist_bk2101_forced_dorsal_extension'],
      wristBk2101Prosupination: ['손목_bk2101_회내회외', 'wrist_bk2101_prosupination'],
      wristBk2103VibrationToolType: ['손목_bk2103_진동공구종류', 'wrist_bk2103_vibration_tool_type'],
      wristBk2103DailyVibrationHours: ['손목_bk2103_진동시간', 'wrist_bk2103_daily_vibration_hours'],
      wristBk2103ToolPressing: ['손목_bk2103_공구압박', 'wrist_bk2103_tool_pressing'],
      wristBk2103FrequentHighForceGrip: ['손목_bk2103_고강도파지', 'wrist_bk2103_frequent_high_force_grip'],
      wristBk2106PressureSource: ['손목_bk2106_압박원인', 'wrist_bk2106_pressure_source'],
    },
    applyRow({ patient, row, diagnosis, job, colMap, getCell }) {
      if (!diagnosis || !job) return;

      const hasWristData = [
        colMap.wristBkType,
        colMap.wristMainTaskName,
        colMap.wristExposureTypes,
        colMap.wristRecentTaskChange,
      ].some(index => getCell(row, index));
      if (!hasWristData) return;

      const wristData = ensureModule(patient, 'wrist');
      if (!wristData.temporalSequence) {
        wristData.temporalSequence = wristData.temporalRelation || createWristModuleData().temporalSequence;
      }
      if (!Array.isArray(wristData.jobEvaluations)) {
        wristData.jobEvaluations = [];
      }

      let jobEvaluation = wristData.jobEvaluations.find(item => item.sharedJobId === job.id);
      if (!jobEvaluation) {
        jobEvaluation = createWristJobEvaluation(job.id);
        wristData.jobEvaluations.push(jobEvaluation);
      }
      if (!Array.isArray(jobEvaluation.diagnosisEntries)) {
        jobEvaluation.diagnosisEntries = [];
      }

      let entry = jobEvaluation.diagnosisEntries.find(item => item.diagnosisId === diagnosis.id);
      if (!entry) {
        entry = createWristDiagnosisEntry(diagnosis);
        jobEvaluation.diagnosisEntries.push(entry);
      }

      const wristToolPressing = String(
        getCell(row, colMap.wristBk2103ToolPressing)
        || entry.bk2103_tool_pressing
        || ''
      ).trim();
      const wristHighForceGrip = String(
        getCell(row, colMap.wristBk2103FrequentHighForceGrip)
        || entry.bk2103_frequent_high_force_grip
        || ''
      ).trim();

      Object.assign(entry, {
        selectedBkType: String(getCell(row, colMap.wristBkType) || entry.selectedBkType || '').trim(),
        bkSelectionMode: String(getCell(row, colMap.wristBkSelectionMode) || entry.bkSelectionMode || 'manual').trim() || 'manual',
        main_task_name: String(getCell(row, colMap.wristMainTaskName) || entry.main_task_name || '').trim(),
        direct_anatomic_link: String(getCell(row, colMap.wristDirectAnatomicLink) || entry.direct_anatomic_link || '').trim(),
        exposure_types: splitList(getCell(row, colMap.wristExposureTypes)).length ? splitList(getCell(row, colMap.wristExposureTypes)) : (entry.exposure_types || []),
        repetition_level: String(getCell(row, colMap.wristRepetitionLevel) || entry.repetition_level || '').trim(),
        daily_exposure_hours: String(getCell(row, colMap.wristDailyExposureHours) || entry.daily_exposure_hours || ''),
        shift_share_percent: String(getCell(row, colMap.wristShiftSharePercent) || entry.shift_share_percent || ''),
        days_per_week: String(getCell(row, colMap.wristDaysPerWeek) || entry.days_per_week || ''),
        work_pattern: String(getCell(row, colMap.wristWorkPattern) || entry.work_pattern || '').trim(),
        rest_distribution: String(getCell(row, colMap.wristRestDistribution) || entry.rest_distribution || '').trim(),
        force_level: String(getCell(row, colMap.wristForceLevel) || entry.force_level || '').trim(),
        awkward_posture_level: String(getCell(row, colMap.wristAwkwardPostureLevel) || entry.awkward_posture_level || '').trim(),
        static_holding_level: String(getCell(row, colMap.wristStaticHoldingLevel) || entry.static_holding_level || '').trim(),
        direct_pressure_level: String(getCell(row, colMap.wristDirectPressureLevel) || entry.direct_pressure_level || '').trim(),
        vibration_exposure: String(getCell(row, colMap.wristVibrationExposure) || entry.vibration_exposure || '').trim(),
        bk2113_repetitive_wrist_motion: String(getCell(row, colMap.wristBk2113RepetitiveMotion) || entry.bk2113_repetitive_wrist_motion || '').trim(),
        bk2101_cycle_seconds: String(getCell(row, colMap.wristBk2101CycleSeconds) || entry.bk2101_cycle_seconds || ''),
        bk2101_repetition_per_hour: String(getCell(row, colMap.wristBk2101RepetitionPerHour) || entry.bk2101_repetition_per_hour || ''),
        bk2101_monotony: String(getCell(row, colMap.wristBk2101Monotony) || entry.bk2101_monotony || '').trim(),
        bk2101_forced_dorsal_extension: String(getCell(row, colMap.wristBk2101ForcedDorsalExtension) || entry.bk2101_forced_dorsal_extension || '').trim(),
        bk2101_prosupination: String(getCell(row, colMap.wristBk2101Prosupination) || entry.bk2101_prosupination || '').trim(),
        bk2103_vibration_tool_type: splitList(getCell(row, colMap.wristBk2103VibrationToolType)).length ? splitList(getCell(row, colMap.wristBk2103VibrationToolType)) : (entry.bk2103_vibration_tool_type || []),
        bk2103_daily_vibration_hours: String(getCell(row, colMap.wristBk2103DailyVibrationHours) || entry.bk2103_daily_vibration_hours || ''),
        bk2103_tool_pressing: wristToolPressing,
        bk2103_frequent_high_force_grip: wristHighForceGrip,
        bk2106_pressure_source: splitList(getCell(row, colMap.wristBk2106PressureSource)).length ? splitList(getCell(row, colMap.wristBk2106PressureSource)) : (entry.bk2106_pressure_source || []),
      });

      if (getCell(row, colMap.wristRecentTaskChange)) {
        wristData.temporalSequence.recent_task_change = String(getCell(row, colMap.wristRecentTaskChange)).trim();
      }
      if (getCell(row, colMap.wristTaskChangeDate)) {
        wristData.temporalSequence.task_change_date = parseDate(getCell(row, colMap.wristTaskChangeDate));
      }
      if (getCell(row, colMap.wristSymptomOnsetInterval)) {
        wristData.temporalSequence.symptom_onset_interval = String(getCell(row, colMap.wristSymptomOnsetInterval)).trim();
      }
      if (getCell(row, colMap.wristImprovesWithRest)) {
        wristData.temporalSequence.improves_with_rest = String(getCell(row, colMap.wristImprovesWithRest)).trim();
      }
    },
  },
});
