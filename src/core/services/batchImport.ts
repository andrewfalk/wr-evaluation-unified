// 일괄 가져오기 — 엑셀 행을 새 환자·기존 환자 변경으로 바꾼다(REFACTORING_ROADMAP Phase 2 C6, P2-56).
// 옛 BatchImportModal.handleImport의 계산 부분을 그대로 옮겼다(모달에는 알림·onImport·onClose만 남는다). 골든 테스트(G1b)도 이 함수를
// 부른다. 모듈 순서는 지금처럼 getAllModules() 순서(열 배정 우선순위·applyRow 순서·activeModules 순서). xlsx를 import하지 않는다
// (파일 읽기는 모달이 한다 — 이 함수는 이미 읽은 행을 받는다).
import { getAllModules, getModule } from '../moduleRegistry';
import { createManagedPatient } from './patientRecords';
import { resolveDiagnosisModule, suggestModules } from '../utils/diagnosisMapping';
import {
  normalizeHeader, parseDate, parseGender, parseSide, getCell, buildColMap,
  ensureDiagnosis, ensureSharedJob, applyReturnConsiderations, applyDiagnosisAssessment, BASE_COLUMNS,
} from '../utils/batchImportHelpers';
import type { ModuleManifest } from '../modules/manifest';

type Fields = { [field: string]: unknown };

export interface ImportPatient extends Fields {
  data: Fields & {
    shared: Fields;
    activeModules: string[];
  };
}

export interface BatchImportStats {
  newPatients: number;
  newDiagnoses: number;
  newJobs: number;
  updatedAssessments: number;
  skipped: number;
  withDoctorName: number;
}

export interface BatchImportInput {
  /** 첫 행은 머리글. */
  rows: unknown[][];
  existingPatients: readonly ImportPatient[];
  /** 미리보기에서 날짜 오류로 표시돼 건너뛸 행 번호(0 = 머리글). */
  errorRowIndexes: ReadonlySet<number>;
  session: unknown;
}

export interface BatchImportChange {
  patient: ImportPatient;
  base: { patient: ImportPatient };
}

export interface BatchImportResult {
  newPatients: ImportPatient[];
  /** 행이 실제로 바꾼 기존 환자 — base는 넘겨받은 기존 환자 객체 그대로(P2-43b). */
  changed: BatchImportChange[];
  stats: BatchImportStats;
  /** 가져올 것이 없다(행이 머리글뿐이거나, 새 환자·상병·직업·평가 변경이 0). */
  empty: boolean;
}

function emptyStats(): BatchImportStats {
  return { newPatients: 0, newDiagnoses: 0, newJobs: 0, updatedAssessments: 0, skipped: 0, withDoctorName: 0 };
}

function clonePatients(existingPatients: readonly ImportPatient[] = []): ImportPatient[] {
  return JSON.parse(JSON.stringify(existingPatients || [])) as ImportPatient[];
}

export function runBatchImport({ rows, existingPatients, errorRowIndexes, session }: BatchImportInput): BatchImportResult {
  if (!rows || rows.length < 2) return { newPatients: [], changed: [], stats: emptyStats(), empty: true };

  const headerRow = rows[0].map(normalizeHeader);
  const moduleConfigs = (getAllModules() as ModuleManifest[])
    .map(mod => ({ id: mod.id, batchImportConfig: mod.batchImportConfig }))
    .filter(mod => mod.batchImportConfig);

  // buildColMap(JS)은 열 키 → 머리글 위치(없으면 -1)를 돌려준다.
  const colMap = buildColMap(headerRow, [
    BASE_COLUMNS,
    ...moduleConfigs.map(mod => mod.batchImportConfig?.columns || {}),
  ]) as Record<string, number>;

  const resultPatients = clonePatients(existingPatients);
  // (P2-43b) 기존 환자 사본의 원래 모습 — 행이 실제로 바꾼 환자만 넘기려고 비교한다(손대지 않은 환자는 touch되지 않게).
  const existingCount = resultPatients.length;
  const beforeJson = resultPatients.map(patient => JSON.stringify(patient));
  const stats = emptyStats();

  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (!row || row.length === 0) continue;

    const name = String(getCell(row, colMap.name) || '').trim();
    if (!name) continue;

    // 사전검증에서 날짜 오류로 표시된 행은 건너뛴다(allowPartialImport 확인을 거친 경우).
    if (errorRowIndexes.has(rowIndex)) {
      stats.skipped += 1;
      continue;
    }

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
      const diagnosisHint = { code: diagCode, name: diagName, side };
      const suggestedModules: string[] = suggestModules([diagnosisHint]);
      const modulesData: Fields = {};
      suggestedModules.forEach(moduleId => {
        const mod = getModule(moduleId) as ModuleManifest | undefined;
        if (mod?.createModuleData) modulesData[moduleId] = mod.createModuleData();
      });

      const created = createManagedPatient(suggestedModules, modulesData, { session }) as ImportPatient;
      const shared = created.data.shared;
      shared.name = name;
      shared.patientNo = String(getCell(row, colMap.patientNo) || '').trim();
      shared.birthDate = birthDate;
      shared.injuryDate = injuryDate;
      shared.height = String(getCell(row, colMap.height) || '');
      shared.weight = String(getCell(row, colMap.weight) || '');
      shared.gender = parseGender(getCell(row, colMap.gender));
      shared.hospitalName = String(getCell(row, colMap.hospitalName) || '').trim();
      shared.department = String(getCell(row, colMap.department) || '').trim();
      shared.doctorName = String(getCell(row, colMap.doctorName) || '').trim();
      shared.specialNotes = String(getCell(row, colMap.specialNotes) || '').trim();
      shared.diagnoses = [];
      shared.jobs = [];
      if (shared.doctorName) stats.withDoctorName += 1;
      resultPatients.push(created);
      stats.newPatients += 1;
      patient = created;
    }

    const diagnosis = ensureDiagnosis(patient, diagCode, diagName, side, stats);
    if (diagnosis) {
      const diagModuleId = resolveDiagnosisModule(diagnosis, patient.data.activeModules)?.moduleId;
      if (applyDiagnosisAssessment(diagnosis, row, colMap, getCell, diagModuleId)) {
        stats.updatedAssessments += 1;
      }
    }
    const job = ensureSharedJob(patient, row, colMap, getCell, stats);

    moduleConfigs.forEach(mod => {
      mod.batchImportConfig?.applyRow({ patient, row, diagnosis, job, colMap, getCell, rowIndex });
    });

    applyReturnConsiderations(
      patient,
      String(getCell(row, colMap.returnConsiderations) || '').trim(),
      moduleConfigs.map(mod => mod.id),
    );
  }

  const empty = stats.newPatients === 0 && stats.newDiagnoses === 0 && stats.newJobs === 0 && stats.updatedAssessments === 0;

  // 편집 표시(touch)·최신 목록 병합은 환자 상태 전이 patients/batchImportApplied가 한다(P2-43·P2-43b). 새 환자와 행이 바꾼 기존
  // 환자만 넘기고, 기존 환자에는 사본을 뜬 시점의 원래 객체를 붙인다(그사이 다른 전이로 바뀌었으면 전이가 건너뛴다).
  const changed: BatchImportChange[] = [];
  for (let i = 0; i < existingCount; i += 1) {
    if (JSON.stringify(resultPatients[i]) === beforeJson[i]) continue;
    changed.push({ patient: resultPatients[i], base: { patient: existingPatients[i] } });
  }
  return { newPatients: resultPatients.slice(existingCount), changed, stats, empty };
}
