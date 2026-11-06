// Golden (characterization) tests — G1: every module's computeCalc and isComplete on the frozen
// golden patients; G1b: every module's batchImportConfig.applyRow, driven the same way
// BatchImportModal does, on rows produced by generateBatchRows. REFACTORING_ROADMAP P0-9.
// Rules (update only for intended output changes, never in a refactor): src/core/fixtures/goldenEnv.js
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { useGoldenEnvironment } from '../../fixtures/goldenEnv';
import { loadGoldenPatients } from '../../fixtures/goldenPatients';

const MODULE_IDS = ['knee', 'shoulder', 'elbow', 'wrist', 'spine', 'cervical'];

// Stable, readable JSON: keep NaN/±Infinity distinguishable (plain JSON would turn them into null).
function goldenJson(value) {
  return JSON.stringify(value, (_key, v) => (typeof v === 'number' && !Number.isFinite(v) ? `__${v}__` : v), 2) + '\n';
}

let registry;
let batch;
let helpers;
let patientRecords;
let diagnosisMapping;

beforeEach(async () => {
  useGoldenEnvironment();
  for (const id of MODULE_IDS) await import(`../../../modules/${id}/index.js`);
  registry = await import('../../moduleRegistry');
  batch = await import('../exportService');
  helpers = await import('../batchImportHelpers');
  patientRecords = await import('../../services/patientRecords');
  diagnosisMapping = await import('../diagnosisMapping');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('G1 — computeCalc and isComplete per module', () => {
  it.each(MODULE_IDS)('%s', async (moduleId) => {
    const mod = registry.getModule(moduleId);
    const result = {};
    for (const patient of loadGoldenPatients()) {
      const { shared, modules, activeModules } = patient.data;
      if (!activeModules.includes(moduleId)) continue;
      const ctx = { shared, module: modules[moduleId], activeModules };
      result[patient.id] = {
        name: shared.name,
        activeModules,
        isComplete: mod.isComplete(ctx),
        calc: mod.computeCalc(ctx),
      };
    }
    expect(Object.keys(result).length, `golden patients must cover ${moduleId}`).toBeGreaterThan(0);
    await expect(goldenJson(result)).toMatchFileSnapshot(`./__goldens__/calc-${moduleId}.json`);
  });
});

// Mirrors BatchImportModal.handleImport (src/core/components/BatchImportModal.jsx) with the same
// helpers and each module's real applyRow — the per-row logic lives in those functions.
function importRows(rows) {
  const { getAllModules, getModule } = registry;
  const { normalizeHeader, parseDate, parseGender, parseSide, getCell, buildColMap,
    ensureDiagnosis, ensureSharedJob, applyReturnConsiderations, applyDiagnosisAssessment, BASE_COLUMNS } = helpers;
  const headerRow = rows[0].map(normalizeHeader);
  const moduleConfigs = getAllModules()
    .map((mod) => ({ id: mod.id, batchImportConfig: mod.batchImportConfig }))
    .filter((mod) => mod.batchImportConfig);
  const colMap = buildColMap(headerRow, [BASE_COLUMNS, ...moduleConfigs.map((mod) => mod.batchImportConfig.columns || {})]);
  const patients = [];
  const stats = { newPatients: 0, newDiagnoses: 0, newJobs: 0, updatedAssessments: 0, skipped: 0, withDoctorName: 0 };
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (!row || row.length === 0) continue;
    const name = String(getCell(row, colMap.name) || '').trim();
    if (!name) continue;
    const birthDate = parseDate(getCell(row, colMap.birthDate));
    const injuryDate = parseDate(getCell(row, colMap.injuryDate));
    const diagCode = String(getCell(row, colMap.diagCode) || '').trim();
    const diagName = String(getCell(row, colMap.diagName) || '').trim();
    const side = parseSide(getCell(row, colMap.side));
    let patient = patients.find((p) => p.data.shared?.name === name && p.data.shared?.birthDate === birthDate && p.data.shared?.injuryDate === injuryDate);
    if (!patient) {
      const suggested = diagnosisMapping.suggestModules([{ code: diagCode, name: diagName, side }]);
      const modulesData = {};
      suggested.forEach((id) => { const mod = getModule(id); if (mod?.createModuleData) modulesData[id] = mod.createModuleData(); });
      patient = patientRecords.createManagedPatient(suggested, modulesData, { session: null });
      Object.assign(patient.data.shared, {
        name,
        patientNo: String(getCell(row, colMap.patientNo) || '').trim(),
        birthDate, injuryDate,
        height: String(getCell(row, colMap.height) || ''),
        weight: String(getCell(row, colMap.weight) || ''),
        gender: parseGender(getCell(row, colMap.gender)),
        hospitalName: String(getCell(row, colMap.hospitalName) || '').trim(),
        department: String(getCell(row, colMap.department) || '').trim(),
        doctorName: String(getCell(row, colMap.doctorName) || '').trim(),
        specialNotes: String(getCell(row, colMap.specialNotes) || '').trim(),
        diagnoses: [], jobs: [],
      });
      if (patient.data.shared.doctorName) stats.withDoctorName += 1;
      patients.push(patient);
      stats.newPatients += 1;
    }
    const diagnosis = ensureDiagnosis(patient, diagCode, diagName, side, stats);
    if (diagnosis) {
      const diagModuleId = diagnosisMapping.resolveDiagnosisModule(diagnosis, patient.data.activeModules)?.moduleId;
      if (applyDiagnosisAssessment(diagnosis, row, colMap, getCell, diagModuleId)) stats.updatedAssessments += 1;
    }
    const job = ensureSharedJob(patient, row, colMap, getCell, stats);
    moduleConfigs.forEach((mod) => mod.batchImportConfig.applyRow({ patient, row, diagnosis, job, colMap, getCell, rowIndex }));
    applyReturnConsiderations(patient, String(getCell(row, colMap.returnConsiderations) || '').trim(), moduleConfigs.map((mod) => mod.id));
  }
  return { patients, stats };
}

describe('G1b — batch import applyRow (all modules)', () => {
  it('rows from generateBatchRows(golden patients) imported through every module applyRow', async () => {
    const rows = [batch.BATCH_HEADERS, ...batch.generateBatchRows(loadGoldenPatients())];
    const { patients, stats } = importRows(rows);
    await expect(goldenJson({ stats, patients: patients.map((p) => ({ id: p.id, data: p.data })) }))
      .toMatchFileSnapshot('./__goldens__/batch-import-applyRow.json');
  });
});
