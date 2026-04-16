import { useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { createDiagnosis, createSharedJob } from '../utils/data';
import { useAuth } from '../auth/AuthContext';
import { suggestModules } from '../utils/diagnosisMapping';
import { getModule } from '../moduleRegistry';
import { createKneeJobExtras } from '../../modules/knee/utils/data';
import { createShoulderJobExtras } from '../../modules/shoulder/utils/data';
import { createElbowDiagnosisEntry, createElbowJobEvaluation, createElbowModuleData } from '../../modules/elbow/utils/data';
import { createTask as createSpineTask } from '../../modules/spine/utils/data';
import { showAlert } from '../utils/platform';
import { createManagedPatient, touchPatientRecord } from '../services/patientRecords';

function normalizeHeader(value) {
  return String(value || '').trim().toLowerCase();
}

function parseDate(value) {
  if (!value) return '';
  if (typeof value === 'number') {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (!parsed) return '';
    return `${parsed.y}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;
  }
  const str = String(value).trim();
  const match = str.match(/(\d{4})[./-](\d{1,2})[./-](\d{1,2})/);
  if (match) {
    return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
  }
  return str;
}

function parseBool(value) {
  if (!value) return false;
  const str = String(value).trim().toLowerCase();
  return ['o', '1', 'true', 'yes', 'y', '예'].includes(str);
}

function parseGender(value) {
  const str = String(value || '').trim().toLowerCase();
  if (['남', '남자', 'male', 'm'].includes(str)) return 'male';
  if (['여', '여자', 'female', 'f'].includes(str)) return 'female';
  return '';
}

function parseSide(value) {
  const str = String(value || '').trim().toLowerCase();
  if (['우측', 'right'].includes(str)) return 'right';
  if (['좌측', 'left'].includes(str)) return 'left';
  if (['양측', 'both'].includes(str)) return 'both';
  return '';
}

function parseKlg(value) {
  if (!value) return '';
  const str = String(value).trim();
  if (str === 'N/A' || str === '해당없음') return 'N/A';
  const match = str.match(/(\d)/);
  return match ? match[1] : '';
}

function splitList(value) {
  if (!value) return [];
  return String(value).split('|').map(item => item.trim()).filter(Boolean);
}

function clonePatients(existingPatients = []) {
  return JSON.parse(JSON.stringify(existingPatients || []));
}

const IMPORT_FIELD_GROUPS = [
  {
    title: '기본정보',
    description: '환자 기본 정보와 평가 문서 정보',
    fields: ['이름', '생년월일', '재해일자', '키', '체중', '성별', '병원명', '진료과', '담당의', '특이사항', '복귀고려사항'],
  },
  {
    title: '진단',
    description: '진단 코드와 방향, 영상등급 입력',
    fields: ['진단코드', '진단명', '방향', 'KLG(우)', 'KLG(좌)', 'Ellman(우)', 'Ellman(좌)'],
  },
  {
    title: '직업/작업',
    description: '무릎, 어깨, 척추 입력이 연결되는 공통 직업 열',
    fields: ['직종명', '시작일', '종료일', '근무기간(년)', '근무기간(개월)', '작업명', '자세코드'],
  },
  {
    title: '팔꿈치',
    description: '공통 시간적 선후관계와 직업별-진단별 팔꿈치 열',
    fields: ['팔꿈치_시간적선후관계_최근작업변화', '팔꿈치_시간적선후관계_작업변화시점', '팔꿈치_BK유형', '팔꿈치_문제작업명', '팔꿈치_핵심노출유형'],
  },
];

const IMPORT_FIELD_COUNT = IMPORT_FIELD_GROUPS.reduce((sum, group) => sum + group.fields.length, 0);

export function BatchImportModal({ onClose, onImport, existingPatients = [] }) {
  const { session } = useAuth();
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [columns, setColumns] = useState([]);
  const [dragover, setDragover] = useState(false);
  const fileRef = useRef();

  const handleFile = (selectedFile) => {
    if (!selectedFile) return;
    setFile(selectedFile);

    const reader = new FileReader();
    reader.onload = event => {
      try {
        const data = new Uint8Array(event.target.result);
        const workbook = XLSX.read(data, { type: 'array' });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
        if (rows.length > 0) {
          setPreview(rows);
          setColumns(rows[0]);
        }
      } catch (error) {
        showAlert(`파일 읽기 오류: ${error.message}`);
      }
    };
    reader.readAsArrayBuffer(selectedFile);
  };

  const handleImport = async () => {
    if (!preview || preview.length < 2) {
      await showAlert('가져올 데이터가 없습니다.');
      return;
    }

    const headerRow = preview[0].map(normalizeHeader);
    const findCol = (...names) => headerRow.findIndex(header => names.some(name => header.includes(name)));
    const getCell = (row, index) => (index >= 0 ? row[index] : undefined);

    const colMap = {
      name: findCol('이름', 'name'),
      birthDate: findCol('생년월일', 'birth'),
      injuryDate: findCol('재해일자', 'injury'),
      height: findCol('키', 'height'),
      weight: findCol('체중', 'weight'),
      gender: findCol('성별', 'gender'),
      hospitalName: findCol('병원명', 'hospital'),
      department: findCol('진료과', 'department'),
      doctorName: findCol('담당의', 'doctor'),
      specialNotes: findCol('특이사항', 'special'),
      returnConsiderations: findCol('복귀고려사항', 'return'),
      diagCode: findCol('진단코드', 'code'),
      diagName: findCol('진단명', 'diag'),
      side: findCol('방향', 'side'),
      klgRight: findCol('klg(우)', 'klg_right'),
      klgLeft: findCol('klg(좌)', 'klg_left'),
      ellmanRight: findCol('ellman(우)', 'ellman_right'),
      ellmanLeft: findCol('ellman(좌)', 'ellman_left'),
      jobName: findCol('직종명', 'job'),
      jobStart: findCol('시작일', 'start'),
      jobEnd: findCol('종료일', 'end'),
      jobPeriodY: findCol('근무기간(년)', 'period(년)', 'period_y'),
      jobPeriodM: findCol('근무기간(개월)', 'period(개월)', 'period_m'),
      kneeWeight: findCol('중량물(kg)', 'jobweight'),
      kneeSquatting: findCol('쪼그려앉기', 'squat'),
      kneeStairs: findCol('계단오르내리기', 'stair'),
      kneeTwist: findCol('무릎비틀기', 'twist'),
      kneeStartStop: findCol('출발정지반복', 'startstop'),
      kneeTightSpace: findCol('좁은공간', 'tightspace'),
      kneeContact: findCol('무릎접촉충격', 'contact'),
      kneeJumpDown: findCol('점프착지', 'jump'),
      shoulderOverhead: findCol('오버헤드', 'overhead'),
      shoulderMedium: findCol('반복중간', 'repetitivemedium'),
      shoulderFast: findCol('반복빠름', 'repetitivefast'),
      shoulderHeavyCount: findCol('중량물횟수', 'heavyloadcount'),
      shoulderHeavySeconds: findCol('중량물시간', 'heavyloadseconds'),
      shoulderVibration: findCol('진동(시간/일)', 'vibration'),
      elbowRecentTaskChange: findCol('팔꿈치_시간적선후관계_최근작업변화', 'elbow_recent_task_change'),
      elbowTaskChangeDate: findCol('팔꿈치_시간적선후관계_작업변화시점', 'elbow_task_change_date'),
      elbowSymptomOnsetInterval: findCol('팔꿈치_시간적선후관계_증상발생까지기간', 'elbow_symptom_onset_interval'),
      elbowImprovesWithRest: findCol('팔꿈치_시간적선후관계_휴식시호전', 'elbow_improves_with_rest'),
      elbowBkType: findCol('팔꿈치_bk유형', 'elbow_bk_type'),
      elbowBkSelectionMode: findCol('팔꿈치_bk선택방식'),
      elbowMainTaskName: findCol('팔꿈치_문제작업명', 'elbow_main_task_name'),
      elbowDirectAnatomicLink: findCol('팔꿈치_핵심동작연결성', 'elbow_direct_anatomic_link'),
      elbowExposureTypes: findCol('팔꿈치_공통핵심노출유형', '팔꿈치_핵심노출유형', 'elbow_exposure_types'),
      elbowRepetitionLevel: findCol('팔꿈치_반복동작정도'),
      elbowDailyExposureHours: findCol('팔꿈치_1일노출시간', 'elbow_daily_exposure_hours'),
      elbowShiftSharePercent: findCol('팔꿈치_하루작업비중', '팔꿈치_교대비율', 'elbow_shift_share_percent'),
      elbowDaysPerWeek: findCol('팔꿈치_주당수행일수', 'elbow_days_per_week'),
      elbowWorkPattern: findCol('팔꿈치_작업형태', 'elbow_work_pattern'),
      elbowRestDistribution: findCol('팔꿈치_휴식분포', 'elbow_rest_distribution'),
      elbowForceLevel: findCol('팔꿈치_힘사용', 'elbow_force_level'),
      elbowAwkwardPostureLevel: findCol('팔꿈치_비중립자세', 'elbow_awkward_posture_level'),
      elbowStaticHoldingLevel: findCol('팔꿈치_정적유지', 'elbow_static_holding_level'),
      elbowDirectPressureLevel: findCol('팔꿈치_직접압박수준', 'elbow_direct_pressure_level'),
      elbowVibrationExposure: findCol('팔꿈치_진동노출', 'elbow_vibration_exposure'),
      elbowBk2101CycleSeconds: findCol('팔꿈치_bk2101_주기초', 'elbow_bk2101_cycle_seconds'),
      elbowBk2101RepetitionPerHour: findCol('팔꿈치_bk2101_시간당반복횟수', 'elbow_bk2101_repetition_per_hour'),
      elbowBk2101Monotony: findCol('팔꿈치_bk2101_단조반복', 'elbow_bk2101_monotony'),
      elbowBk2101ForcedDorsalExtension: findCol('팔꿈치_bk2101_배측굴곡', 'elbow_bk2101_forced_dorsal_extension'),
      elbowBk2101Prosupination: findCol('팔꿈치_bk2101_회내회외', 'elbow_bk2101_prosupination'),
      elbowBk2105ElbowLeaning: findCol('팔꿈치_bk2105_팔꿈치지지', 'elbow_bk2105_elbow_leaning'),
      elbowBk2105RepeatedFrictionImpact: findCol('팔꿈치_bk2105_반복마찰충격', 'elbow_bk2105_repeated_friction_impact'),
      elbowBk2105PressureSource: findCol('팔꿈치_bk2105_압박원인', 'elbow_bk2105_pressure_source'),
      elbowBk2106RepeatedMechanicalExposure: findCol('팔꿈치_bk2106_반복기계적부담', 'elbow_bk2106_repeated_mechanical_exposure'),
      elbowBk2106NoncorrectablePosture: findCol('팔꿈치_bk2106_강제자세', 'elbow_bk2106_noncorrectable_posture'),
      elbowBk2106ProlongedJointPosition: findCol('팔꿈치_bk2106_관절자세유지', 'elbow_bk2106_prolonged_joint_position'),
      elbowBk2106PressureSource: findCol('팔꿈치_bk2106_압박원인', 'elbow_bk2106_pressure_source'),
      elbowBk2106ToolPressing: findCol('팔꿈치_bk2106_공구압박', 'elbow_bk2106_tool_pressing'),
      elbowBk2106FrequentHighForceGrip: findCol('팔꿈치_bk2106_고힘그립', 'elbow_bk2106_frequent_high_force_grip'),
      elbowBk2103VibrationToolType: findCol('팔꿈치_bk2103_진동공구종류', 'elbow_bk2103_vibration_tool_type'),
      elbowBk2103DailyVibrationHours: findCol('팔꿈치_bk2103_진동시간', 'elbow_bk2103_daily_vibration_hours'),
      elbowBk2103HandheldOrGuided: findCol('팔꿈치_bk2103_손유도공구', 'elbow_bk2103_handheld_or_guided'),
      elbowBk2103ToolPressing: findCol('팔꿈치_bk2103_공구를강하게쥐거나누르면서사용하는작업', '팔꿈치_bk2103_공구압박', 'elbow_bk2103_tool_pressing'),
      elbowBk2103FrequentHighForceGrip: findCol('팔꿈치_bk2103_강하게쥐는동작반복', '팔꿈치_bk2103_고힘그립', 'elbow_bk2103_frequent_high_force_grip'),
      taskName: findCol('작업명', 'task'),
      posture: findCol('자세코드', 'posture'),
      taskWeight: findCol('작업중량', 'taskweight'),
      frequency: findCol('횟수/분', 'frequency'),
      timeValue: findCol('시간값', 'timevalue'),
      timeUnit: findCol('시간단위', 'timeunit'),
      correctionFactor: findCol('보정계수', 'correction'),
    };

    const resultPatients = clonePatients(existingPatients);
    const stats = { newPatients: 0, newDiagnoses: 0, newJobs: 0, skipped: 0 };

    const ensureModule = (patient, moduleId) => {
      if (!patient.data.activeModules.includes(moduleId)) {
        patient.data.activeModules.push(moduleId);
      }
      if (!patient.data.modules[moduleId]) {
        if (moduleId === 'elbow') {
          patient.data.modules[moduleId] = createElbowModuleData();
        } else {
          const mod = getModule(moduleId);
          if (mod?.createModuleData) patient.data.modules[moduleId] = mod.createModuleData();
        }
      }
      return patient.data.modules[moduleId];
    };

    const applyReturnConsiderations = (patient, value) => {
      if (!value) return;
      ['knee', 'shoulder', 'elbow'].forEach(moduleId => {
        if (patient.data.modules[moduleId]) {
          patient.data.modules[moduleId].returnConsiderations = value;
        }
      });
    };

    const ensureDiagnosis = (patient, diagCode, diagName, side) => {
      let diagnosis = (patient.data.shared.diagnoses || []).find(item =>
        item.code === diagCode && item.name === diagName && item.side === side
      );
      if (!diagnosis && (diagCode || diagName)) {
        diagnosis = { ...createDiagnosis(), code: diagCode, name: diagName, side };
        patient.data.shared.diagnoses.push(diagnosis);
        stats.newDiagnoses += 1;
      }
      return diagnosis;
    };

    const ensureSharedJob = (patient, row) => {
      const jobName = String(getCell(row, colMap.jobName) || '').trim();
      if (!jobName) return null;
      let job = (patient.data.shared.jobs || []).find(item => item.jobName === jobName);
      if (!job) {
        job = createSharedJob();
        job.jobName = jobName;
        job.startDate = parseDate(getCell(row, colMap.jobStart));
        job.endDate = parseDate(getCell(row, colMap.jobEnd));
        const years = parseInt(getCell(row, colMap.jobPeriodY), 10) || 0;
        const months = parseInt(getCell(row, colMap.jobPeriodM), 10) || 0;
        job.workPeriodOverride = years || months ? `${years}년 ${months}개월` : '';
        patient.data.shared.jobs.push(job);
        stats.newJobs += 1;
      }
      return job;
    };

    const ensureElbowEntry = (patient, jobId, diagnosis) => {
      const elbowData = ensureModule(patient, 'elbow');
      if (!elbowData.temporalSequence) {
        elbowData.temporalSequence = elbowData.temporalRelation || createElbowModuleData().temporalSequence;
      }
      if (!Array.isArray(elbowData.jobEvaluations)) {
        elbowData.jobEvaluations = [];
      }

      let jobEvaluation = elbowData.jobEvaluations.find(item => item.sharedJobId === jobId);
      if (!jobEvaluation) {
        jobEvaluation = createElbowJobEvaluation(jobId);
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

      return { elbowData, entry };
    };

    const updateElbowEvaluation = (patient, row, diagnosis, job) => {
      if (!diagnosis || !job) return;

      const hasElbowData = [
        colMap.elbowBkType,
        colMap.elbowMainTaskName,
        colMap.elbowExposureTypes,
        colMap.elbowRecentTaskChange,
      ].some(index => getCell(row, index));
      if (!hasElbowData) return;

      const { elbowData, entry } = ensureElbowEntry(patient, job.id, diagnosis);

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
    };

    const updateKneeShoulderSpine = (patient, row, diagnosis, job) => {
      const hasKneeData = [colMap.kneeWeight, colMap.kneeSquatting, colMap.kneeStairs, colMap.kneeTwist, colMap.kneeStartStop, colMap.kneeTightSpace, colMap.kneeContact, colMap.kneeJumpDown].some(index => getCell(row, index));
      const hasShoulderData = [colMap.shoulderOverhead, colMap.shoulderMedium, colMap.shoulderFast, colMap.shoulderHeavyCount, colMap.shoulderHeavySeconds, colMap.shoulderVibration].some(index => getCell(row, index));
      const hasSpineData = [colMap.taskName, colMap.posture].some(index => getCell(row, index));

      if (diagnosis && (getCell(row, colMap.klgRight) || getCell(row, colMap.klgLeft))) {
        diagnosis.klgRight = diagnosis.klgRight || parseKlg(getCell(row, colMap.klgRight));
        diagnosis.klgLeft = diagnosis.klgLeft || parseKlg(getCell(row, colMap.klgLeft));
      }

      if (diagnosis && (getCell(row, colMap.ellmanRight) || getCell(row, colMap.ellmanLeft))) {
        diagnosis.ellmanRight = diagnosis.ellmanRight || String(getCell(row, colMap.ellmanRight) || '').trim();
        diagnosis.ellmanLeft = diagnosis.ellmanLeft || String(getCell(row, colMap.ellmanLeft) || '').trim();
      }

      if (hasKneeData && job) {
        const kneeData = ensureModule(patient, 'knee');
        if (!kneeData.jobExtras) kneeData.jobExtras = [];
        let extra = (kneeData.jobExtras || []).find(item => item.sharedJobId === job.id);
        if (!extra) {
          extra = createKneeJobExtras(job.id);
          kneeData.jobExtras.push(extra);
        }
        Object.assign(extra, {
          weight: String(getCell(row, colMap.kneeWeight) || extra.weight || ''),
          squatting: String(getCell(row, colMap.kneeSquatting) || extra.squatting || ''),
          stairs: extra.stairs || parseBool(getCell(row, colMap.kneeStairs)),
          kneeTwist: extra.kneeTwist || parseBool(getCell(row, colMap.kneeTwist)),
          startStop: extra.startStop || parseBool(getCell(row, colMap.kneeStartStop)),
          tightSpace: extra.tightSpace || parseBool(getCell(row, colMap.kneeTightSpace)),
          kneeContact: extra.kneeContact || parseBool(getCell(row, colMap.kneeContact)),
          jumpDown: extra.jumpDown || parseBool(getCell(row, colMap.kneeJumpDown)),
        });
      }

      if (hasShoulderData && job) {
        const shoulderData = ensureModule(patient, 'shoulder');
        if (!shoulderData.jobExtras) shoulderData.jobExtras = [];
        let extra = (shoulderData.jobExtras || []).find(item => item.sharedJobId === job.id);
        if (!extra) {
          extra = createShoulderJobExtras(job.id);
          shoulderData.jobExtras.push(extra);
        }
        Object.assign(extra, {
          overheadHours: String(getCell(row, colMap.shoulderOverhead) || extra.overheadHours || ''),
          repetitiveMediumHours: String(getCell(row, colMap.shoulderMedium) || extra.repetitiveMediumHours || ''),
          repetitiveFastHours: String(getCell(row, colMap.shoulderFast) || extra.repetitiveFastHours || ''),
          heavyLoadCount: String(getCell(row, colMap.shoulderHeavyCount) || extra.heavyLoadCount || ''),
          heavyLoadSeconds: String(getCell(row, colMap.shoulderHeavySeconds) || extra.heavyLoadSeconds || ''),
          vibrationHours: String(getCell(row, colMap.shoulderVibration) || extra.vibrationHours || ''),
        });
      }

      if (hasSpineData) {
        const spineData = ensureModule(patient, 'spine');
        if (!spineData.tasks) spineData.tasks = [];
        const taskName = String(getCell(row, colMap.taskName) || '').trim();
        const posture = String(getCell(row, colMap.posture) || '').trim();
        if (taskName || posture) {
          let task = (spineData.tasks || []).find(item => item.name === taskName && item.posture === posture);
          if (!task) {
            task = createSpineTask((spineData.tasks || []).length, job?.id || '');
            spineData.tasks.push(task);
          }
          Object.assign(task, {
            sharedJobId: job?.id || task.sharedJobId,
            name: taskName || task.name,
            posture: posture || task.posture,
            weight: Number(getCell(row, colMap.taskWeight) || task.weight || 0),
            frequency: Number(getCell(row, colMap.frequency) || task.frequency || 0),
            timeValue: Number(getCell(row, colMap.timeValue) || task.timeValue || 0),
            timeUnit: String(getCell(row, colMap.timeUnit) || task.timeUnit || 'sec').trim().toLowerCase(),
            correctionFactor: Number(getCell(row, colMap.correctionFactor) || task.correctionFactor || 1),
          });
        }
      }
    };

    for (let rowIndex = 1; rowIndex < preview.length; rowIndex += 1) {
      const row = preview[rowIndex];
      if (!row || row.length === 0) continue;

      const name = String(getCell(row, colMap.name) || '').trim();
      if (!name) continue;

      const birthDate = parseDate(getCell(row, colMap.birthDate));
      const injuryDate = parseDate(getCell(row, colMap.injuryDate));
      const diagCode = String(getCell(row, colMap.diagCode) || '').trim();
      const diagName = String(getCell(row, colMap.diagName) || '').trim();
      const side = parseSide(getCell(row, colMap.side));

      let patient = resultPatients.find(item =>
        item.data.shared?.name === name
        && item.data.shared?.birthDate === birthDate
        && item.data.shared?.injuryDate === injuryDate
      );

      if (!patient) {
        const suggestedModules = suggestModules([{ code: diagCode, name: diagName, side }]);
        const modulesData = {};
        suggestedModules.forEach(moduleId => {
          if (moduleId === 'elbow') {
            modulesData.elbow = createElbowModuleData();
          } else {
            const mod = getModule(moduleId);
            if (mod?.createModuleData) modulesData[moduleId] = mod.createModuleData();
          }
        });

        patient = createManagedPatient(suggestedModules, modulesData, { session });
        patient.data.shared.name = name;
        patient.data.shared.birthDate = birthDate;
        patient.data.shared.injuryDate = injuryDate;
        patient.data.shared.height = String(getCell(row, colMap.height) || '');
        patient.data.shared.weight = String(getCell(row, colMap.weight) || '');
        patient.data.shared.gender = parseGender(getCell(row, colMap.gender));
        patient.data.shared.hospitalName = String(getCell(row, colMap.hospitalName) || '').trim();
        patient.data.shared.department = String(getCell(row, colMap.department) || '').trim();
        patient.data.shared.doctorName = String(getCell(row, colMap.doctorName) || '').trim();
        patient.data.shared.specialNotes = String(getCell(row, colMap.specialNotes) || '').trim();
        patient.data.shared.diagnoses = [];
        patient.data.shared.jobs = [];
        resultPatients.push(patient);
        stats.newPatients += 1;
      }

      const diagnosis = ensureDiagnosis(patient, diagCode, diagName, side);
      const job = ensureSharedJob(patient, row);
      applyReturnConsiderations(patient, String(getCell(row, colMap.returnConsiderations) || '').trim());

      updateKneeShoulderSpine(patient, row, diagnosis, job);
      updateElbowEvaluation(patient, row, diagnosis, job);
    }

    if (stats.newPatients === 0 && stats.newDiagnoses === 0 && stats.newJobs === 0) {
      await showAlert('가져올 데이터가 없습니다.');
      return;
    }

    onImport(resultPatients.map(patient => touchPatientRecord(patient, { session })), stats);
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal import-modal" onClick={e => e.stopPropagation()}>
        <div className="import-modal-header">
          <div>
            <h2>일괄 Import</h2>
            <p className="import-modal-description">
              엑셀 파일을 읽어 신규 환자를 만들거나 기존 환자 데이터에 병합합니다.
            </p>
          </div>
          <span className="modal-section-badge">지원 형식 .xlsx / .xls / .csv</span>
        </div>

        <section className="modal-section pattern-surface">
          <div className="modal-section-header">
            <div>
              <h3 className="modal-section-title">파일 업로드</h3>
              <p className="modal-section-description">첫 행은 컬럼명, 두 번째 행부터 실제 데이터로 해석합니다.</p>
            </div>
            {file && <span className="modal-section-badge">{file.name}</span>}
          </div>

          <div
            className={`import-zone ${dragover ? 'dragover' : ''}`}
            onClick={() => fileRef.current.click()}
            onDragOver={event => { event.preventDefault(); setDragover(true); }}
            onDragLeave={() => setDragover(false)}
            onDrop={event => {
              event.preventDefault();
              setDragover(false);
              handleFile(event.dataTransfer.files[0]);
            }}
          >
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              style={{ display: 'none' }}
              onChange={event => handleFile(event.target.files[0])}
            />
            <p>클릭하거나 파일을 드래그하세요</p>
            <p className="import-zone-note">현재 내보내기 템플릿과 호환되는 헤더를 우선 지원합니다.</p>
            {file && <p className="import-zone-file">선택됨: {file.name}</p>}
          </div>
        </section>

        <section className="modal-section pattern-surface">
          <div className="modal-section-header">
            <div>
              <h3 className="modal-section-title">지원 컬럼 그룹</h3>
              <p className="modal-section-description">현재 parser가 인식하는 대표 컬럼들입니다.</p>
            </div>
            <span className="modal-section-badge">{IMPORT_FIELD_COUNT}개</span>
          </div>

          <div className="import-reference-grid">
            {IMPORT_FIELD_GROUPS.map(group => (
              <div key={group.title} className="import-reference-card">
                <h4>{group.title}</h4>
                <p>{group.description}</p>
                <div className="import-reference-fields">
                  {group.fields.map(field => <span key={field} className="import-reference-field">{field}</span>)}
                </div>
              </div>
            ))}
          </div>
        </section>

        {preview && (
          <section className="modal-section pattern-surface">
            <div className="modal-section-header">
              <div>
                <h3 className="modal-section-title">미리보기</h3>
                <p className="modal-section-description">헤더 {columns.length}개, 데이터 {Math.max(0, preview.length - 1)}행</p>
              </div>
            </div>
            <div className="report-preview">
              <div className="preview-section">
                {columns.join(' | ')}
              </div>
            </div>
          </section>
        )}

        <div className="modal-actions">
          <button className="btn btn-primary" onClick={handleImport} disabled={!preview}>가져오기</button>
          <button className="btn btn-secondary" onClick={onClose}>취소</button>
        </div>
      </div>
    </div>
  );
}
