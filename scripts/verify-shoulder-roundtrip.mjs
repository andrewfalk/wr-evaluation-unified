import fs from 'node:fs';
import * as XLSX from 'xlsx';
import { registerModule } from '../src/core/moduleRegistry.js';
import { createManagedPatient } from '../src/core/services/patientRecords.js';
import { createDiagnosis } from '../src/core/utils/data.js';
import { suggestModules } from '../src/core/utils/diagnosisMapping.js';
import { exportBatchFormatSingle } from '../src/core/utils/exportService.js';
import { createShoulderJobExtras, createShoulderModuleData } from '../src/modules/shoulder/utils/data.js';

function registerTestModules() {
  registerModule({
    id: 'knee',
    createModuleData: () => ({ jobExtras: [], returnConsiderations: '' }),
  });
  registerModule({
    id: 'shoulder',
    createModuleData: createShoulderModuleData,
  });
  registerModule({
    id: 'spine',
    createModuleData: () => ({ tasks: [] }),
  });
}

function assert(condition, message, details) {
  if (!condition) {
    const error = new Error(message);
    error.details = details;
    throw error;
  }
}

function createSamplePatient() {
  const modulesData = { shoulder: createShoulderModuleData() };
  const patient = createManagedPatient(['shoulder'], modulesData, {});
  const jobId = crypto.randomUUID();

  patient.data.shared.name = '어깨 라운드트립';
  patient.data.shared.birthDate = '1980-01-02';
  patient.data.shared.injuryDate = '2025-03-01';
  patient.data.shared.gender = 'male';
  patient.data.shared.height = '172';
  patient.data.shared.weight = '71';
  patient.data.shared.hospitalName = '테스트병원';
  patient.data.shared.department = '직업환경의학과';
  patient.data.shared.doctorName = '테스트의';
  patient.data.shared.specialNotes = '어깨 위 작업이 많은 직무';
  patient.data.shared.diagnoses = [{
    ...createDiagnosis(),
    code: 'M75.1',
    name: '회전근개 파열',
    side: 'both',
    ellmanRight: 'Grade 2',
    ellmanLeft: 'Grade 3',
  }];
  patient.data.shared.jobs = [{
    id: jobId,
    jobName: '용접공',
    presetId: null,
    startDate: '2010-01-01',
    endDate: '2025-03-01',
    workPeriodOverride: '',
    workDaysPerYear: 250,
  }];
  patient.data.modules.shoulder.jobExtras = [{
    ...createShoulderJobExtras(jobId),
    overheadHours: '2',
    repetitiveMediumHours: '1.5',
    repetitiveFastHours: '0.5',
    heavyLoadCount: '30',
    heavyLoadSeconds: '12',
    vibrationHours: '1.25',
  }];
  patient.data.modules.shoulder.returnConsiderations = '어깨 위 작업 제한';

  return patient;
}

function captureBatchWorkbook(patient) {
  const before = new Set(fs.readdirSync(process.cwd()));
  exportBatchFormatSingle(patient);

  const createdFiles = fs.readdirSync(process.cwd()).filter(fileName => (
    fileName.endsWith('.xlsx') &&
    !before.has(fileName) &&
    fileName.includes(patient.data.shared.name)
  ));

  assert(createdFiles.length === 1, '배치 export 파일을 정확히 찾지 못했습니다.', createdFiles);
  const fileName = createdFiles[0];
  const wb = XLSX.readFile(fileName);
  fs.unlinkSync(fileName);

  return { wb, fileName };
}

function importRowsFromWorkbook(rows) {
  const headers = rows[0].map(value => String(value || ''));
  const lowerHeaders = headers.map(value => value.toLowerCase());
  const findCol = (keywords) => lowerHeaders.findIndex(header => keywords.some(keyword => header.includes(keyword)));
  const colMap = {
    name: findCol(['이름', 'name']),
    birthDate: findCol(['생년월일', 'birth']),
    injuryDate: findCol(['재해', 'injury']),
    height: findCol(['키', 'height']),
    weight: findCol(['몸무게', 'weight']),
    gender: findCol(['성별', 'gender', 'sex']),
    hospitalName: findCol(['병원', 'hospital']),
    department: findCol(['진료과', 'department', 'dept']),
    doctorName: findCol(['담당의', 'doctor']),
    specialNotes: findCol(['특이사항', 'special', 'note']),
    returnConsiderations: findCol(['복귀', 'return', 'consideration']),
    diagCode: findCol(['진단코드', 'code']),
    diagName: findCol(['진단명', 'diag']),
    side: findCol(['방향', 'side']),
    klgRight: findCol(['klg(우측)', 'klg우측', 'klg_right', 'klg(right)']),
    klgLeft: findCol(['klg(좌측)', 'klg좌측', 'klg_left', 'klg(left)']),
    ellmanRight: findCol(['ellman(우측)', 'ellman우측', 'ellman_right', 'ellman(right)']),
    ellmanLeft: findCol(['ellman(좌측)', 'ellman좌측', 'ellman_left', 'ellman(left)']),
    jobName: findCol(['직종명', 'job']),
    jobStart: findCol(['시작', 'start']),
    jobEnd: findCol(['종료', 'end']),
    shoulderOverhead: findCol(['오버헤드', 'overhead']),
    shoulderRepetitiveMedium: findCol(['반복중간', 'repetitivemedium', 'repetitive_medium']),
    shoulderRepetitiveFast: findCol(['반복빠른', 'repetitivefast', 'repetitive_fast']),
    shoulderHeavyLoadCount: findCol(['중량물횟수', 'heavyloadcount', 'heavy_load_count']),
    shoulderHeavyLoadSeconds: findCol(['중량물시간', 'heavyloadseconds', 'heavy_load_seconds']),
    shoulderVibration: findCol(['진동', 'vibration']),
  };

  const getVal = (row, key) => {
    const idx = colMap[key];
    return idx >= 0 ? row[idx] : undefined;
  };

  const sideMap = {
    우측: 'right',
    좌측: 'left',
    양측: 'both',
    right: 'right',
    left: 'left',
    both: 'both',
  };

  const applyKlg = (diag, side, klgRight, klgLeft) => {
    if (side === 'right' || side === 'both') diag.klgRight = klgRight;
    if (side === 'left' || side === 'both') diag.klgLeft = klgLeft;
  };

  const applyEllman = (diag, side, ellmanRight, ellmanLeft) => {
    if (side === 'right' || side === 'both') diag.ellmanRight = ellmanRight;
    if (side === 'left' || side === 'both') diag.ellmanLeft = ellmanLeft;
  };

  const hasKneeData = (row) => !!(
    getVal(row, 'klgRight') ||
    getVal(row, 'klgLeft')
  );

  const hasShoulderData = (row) => !!(
    getVal(row, 'ellmanRight') ||
    getVal(row, 'ellmanLeft') ||
    getVal(row, 'shoulderOverhead') ||
    getVal(row, 'shoulderRepetitiveMedium') ||
    getVal(row, 'shoulderRepetitiveFast') ||
    getVal(row, 'shoulderHeavyLoadCount') ||
    getVal(row, 'shoulderHeavyLoadSeconds') ||
    getVal(row, 'shoulderVibration')
  );

  const row = rows[1];
  const rowDiagCode = String(getVal(row, 'diagCode') || '').trim();
  const rowDiagName = String(getVal(row, 'diagName') || '').trim();
  const rowSide = sideMap[String(getVal(row, 'side') || '').trim().toLowerCase()] || '';
  const rowKlgRight = String(getVal(row, 'klgRight') || '').trim();
  const rowKlgLeft = String(getVal(row, 'klgLeft') || '').trim();
  const rowEllmanRight = String(getVal(row, 'ellmanRight') || '').trim();
  const rowEllmanLeft = String(getVal(row, 'ellmanLeft') || '').trim();
  const rowReturnConsiderations = String(getVal(row, 'returnConsiderations') || '').trim();

  const diagList = [];
  if (rowDiagCode || rowDiagName) {
    const diag = { ...createDiagnosis(), code: rowDiagCode, name: rowDiagName, side: rowSide };
    applyKlg(diag, rowSide, rowKlgRight, rowKlgLeft);
    applyEllman(diag, rowSide, rowEllmanRight, rowEllmanLeft);
    diagList.push(diag);
  }

  const suggestedMods = suggestModules(diagList);
  if (hasKneeData(row) && !suggestedMods.includes('knee')) suggestedMods.push('knee');
  if (hasShoulderData(row) && !suggestedMods.includes('shoulder')) suggestedMods.push('shoulder');

  const modulesData = {};
  for (const moduleId of suggestedMods) {
    const module = globalThis.__TEST_MODULES__[moduleId];
    if (module?.createModuleData) modulesData[moduleId] = module.createModuleData();
  }

  const patient = createManagedPatient(suggestedMods, modulesData, {});
  patient.data.shared.name = String(getVal(row, 'name') || '').trim();
  patient.data.shared.birthDate = String(getVal(row, 'birthDate') || '').trim();
  patient.data.shared.injuryDate = String(getVal(row, 'injuryDate') || '').trim();
  patient.data.shared.height = String(getVal(row, 'height') || '').trim();
  patient.data.shared.weight = String(getVal(row, 'weight') || '').trim();
  patient.data.shared.hospitalName = String(getVal(row, 'hospitalName') || '').trim();
  patient.data.shared.department = String(getVal(row, 'department') || '').trim();
  patient.data.shared.doctorName = String(getVal(row, 'doctorName') || '').trim();
  patient.data.shared.specialNotes = String(getVal(row, 'specialNotes') || '').trim();
  patient.data.shared.diagnoses = diagList;

  const rowJobName = String(getVal(row, 'jobName') || '').trim();
  if (rowJobName) {
    const sharedJob = patient.data.shared.jobs[0];
    sharedJob.jobName = rowJobName;
    sharedJob.startDate = String(getVal(row, 'jobStart') || '').trim();
    sharedJob.endDate = String(getVal(row, 'jobEnd') || '').trim();

    if (modulesData.shoulder) {
      modulesData.shoulder.jobExtras = [{
        ...createShoulderJobExtras(sharedJob.id),
        overheadHours: String(getVal(row, 'shoulderOverhead') || '').trim(),
        repetitiveMediumHours: String(getVal(row, 'shoulderRepetitiveMedium') || '').trim(),
        repetitiveFastHours: String(getVal(row, 'shoulderRepetitiveFast') || '').trim(),
        heavyLoadCount: String(getVal(row, 'shoulderHeavyLoadCount') || '').trim(),
        heavyLoadSeconds: String(getVal(row, 'shoulderHeavyLoadSeconds') || '').trim(),
        vibrationHours: String(getVal(row, 'shoulderVibration') || '').trim(),
      }];
    }
  }

  if (modulesData.shoulder) {
    modulesData.shoulder.returnConsiderations = rowReturnConsiderations;
  }

  return patient;
}

function main() {
  registerTestModules();
  globalThis.__TEST_MODULES__ = {
    knee: { createModuleData: () => ({ jobExtras: [], returnConsiderations: '' }) },
    shoulder: { createModuleData: createShoulderModuleData },
    spine: { createModuleData: () => ({ tasks: [] }) },
  };

  const sourcePatient = createSamplePatient();
  const { wb, fileName } = captureBatchWorkbook(sourcePatient);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false });
  const importedPatient = importRowsFromWorkbook(rows);

  const diag = importedPatient.data.shared.diagnoses[0];
  const shoulderJob = importedPatient.data.modules.shoulder?.jobExtras?.[0];

  assert(rows[0].includes('Ellman(우측)'), 'export 헤더에 Ellman(우측) 컬럼이 없습니다.', rows[0]);
  assert(rows[0].includes('오버헤드(시간/일)'), 'export 헤더에 오버헤드(시간/일) 컬럼이 없습니다.', rows[0]);
  assert(importedPatient.data.activeModules.length === 1 && importedPatient.data.activeModules[0] === 'shoulder', 'import 후 활성 모듈이 shoulder 단독이 아닙니다.', importedPatient.data.activeModules);
  assert(diag.ellmanRight === 'Grade 2', '우측 Ellman 값이 보존되지 않았습니다.', diag);
  assert(diag.ellmanLeft === 'Grade 3', '좌측 Ellman 값이 보존되지 않았습니다.', diag);
  assert(shoulderJob?.overheadHours === '2', '오버헤드 시간이 보존되지 않았습니다.', shoulderJob);
  assert(shoulderJob?.repetitiveMediumHours === '1.5', '반복중간 시간이 보존되지 않았습니다.', shoulderJob);
  assert(shoulderJob?.heavyLoadCount === '30', '중량물 횟수가 보존되지 않았습니다.', shoulderJob);
  assert(shoulderJob?.vibrationHours === '1.25', '진동 시간이 보존되지 않았습니다.', shoulderJob);
  assert(importedPatient.data.modules.shoulder?.returnConsiderations === '어깨 위 작업 제한', '복귀 고려사항이 어깨 모듈에 보존되지 않았습니다.', importedPatient.data.modules.shoulder);

  console.log(JSON.stringify({
    ok: true,
    fileName,
    activeModules: importedPatient.data.activeModules,
    ellmanRight: diag.ellmanRight,
    ellmanLeft: diag.ellmanLeft,
    overheadHours: shoulderJob.overheadHours,
    repetitiveMediumHours: shoulderJob.repetitiveMediumHours,
    heavyLoadCount: shoulderJob.heavyLoadCount,
    vibrationHours: shoulderJob.vibrationHours,
    returnConsiderations: importedPatient.data.modules.shoulder.returnConsiderations,
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    message: error.message,
    details: error.details ?? null,
  }, null, 2));
  process.exit(1);
}
