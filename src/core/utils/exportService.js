import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import { resolveMddmStatus } from '../../modules/spine/utils/calculations';
import { generateUnifiedEMR, resolveAssessment } from './emrReport';
import { BATCH_COLUMNS } from '../export/batchColumns';

export { generateEMRFieldData, generateConsultReplyFieldData } from './emrReport';

function buildUnifiedWorkbook(patient) {
  const shared = patient.data.shared || {};
  const { b5, b6, b7, b8, b9, consultReplySummary } = generateUnifiedEMR(patient);
  // 직접 편집 오버라이드가 있으면 그 본문을 6.종합소견에 반영한다 — 다학제 회신 append는
  // 오버라이드와 무관하게 유지(미리보기에 보인 적 없는 별도 데이터라 편집 대상이 아니다).
  const effectiveB8 = resolveAssessment(patient, b8).text;
  const b8Full = consultReplySummary ? effectiveB8 + '\n\n' + consultReplySummary : effectiveB8;
  const wb = XLSX.utils.book_new();
  const wsData = [
    ['업무관련성특별진찰소견서(근골격계질병)', ''],
    ['항목', '내용'],
    ['1.신청상병명', ''],
    ['2.진료기록 및 의학적 소견', ''],
    ['3.최종 확인 상병명', b5],
    ['4.직업적 요인', b6],
    ['5.개인적 요인', b7],
    ['6.종합소견', b8Full],
    ['7.특이 사항 메모', b9]
  ];
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  ws['!cols'] = [{ wch: 25 }, { wch: 90 }];
  XLSX.utils.book_append_sheet(wb, ws, '업무관련성평가');
  const name = (shared.name || '미입력').replace(/[\\/:*?"<>|]/g, '_');
  const date = (shared.injuryDate || new Date().toISOString().split('T')[0]).replace(/[\\/:*?"<>|]/g, '-');
  return { wb, fileName: `업무관련성평가_${name}_${date}.xlsx` };
}

export function exportSingle(patient) {
  const { wb, fileName } = buildUnifiedWorkbook(patient);
  XLSX.writeFile(wb, fileName);
}

async function exportAsZip(patientList, zipName) {
  const zip = new JSZip();
  const usedNames = {};

  for (const patient of patientList) {
    try {
      const { wb, fileName } = buildUnifiedWorkbook(patient);
      let finalName = fileName;
      if (usedNames[fileName]) {
        usedNames[fileName] += 1;
        finalName = fileName.replace('.xlsx', `_${usedNames[fileName]}.xlsx`);
      } else {
        usedNames[fileName] = 1;
      }

      const xlsxBuffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
      zip.file(finalName, xlsxBuffer);
    } catch (error) {
      console.error(`Export failed: ${patient.data.shared?.name || 'unknown'}`, error);
    }
  }

  const blob = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = zipName;
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function exportSelected(patients, selectedIds) {
  const selected = patients.filter(patient => selectedIds.has(patient.id) && patient.data.shared?.name);
  if (selected.length === 0) return;
  const date = new Date().toISOString().split('T')[0];
  await exportAsZip(selected, `업무관련성평가_선택${selected.length}명_${date}.zip`);
}

export async function exportBatch(patients) {
  const valid = patients.filter(patient => patient.data.shared?.name);
  if (valid.length === 0) return;
  const date = new Date().toISOString().split('T')[0];
  await exportAsZip(valid, `업무관련성평가_${valid.length}명_${date}.zip`);
}

// 열 머리글·셀은 열 표(src/core/export/batchColumns.ts, P2-54b)가 정한다 — 구간 order 순.
export const BATCH_HEADERS = BATCH_COLUMNS.map(column => column.header);

export function generateBatchRows(patientList) {
  const rows = [];

  for (const patient of patientList) {
    const shared = patient.data.shared || {};
    const modules = patient.data.modules || {};
    const diagnoses = (shared.diagnoses || []).filter(diag => diag.code || diag.name);
    const jobs = shared.jobs || [];
    const kneeExtras = modules.knee?.jobExtras || [];
    const shoulderExtras = modules.shoulder?.jobExtras || [];
    const cervicalTasks = modules.cervical?.tasks || [];
    // MDDM이 '평가함'(present)일 때만 작업 행을 만든다. unknown(WBV-only)·none(해당없음)은 빈 배열.
    const spineModule = modules.spine || {};
    const spineTasks = resolveMddmStatus(spineModule) === 'present' ? (spineModule.tasks || []) : [];
    const elbowTemporal = modules.elbow?.temporalSequence || modules.elbow?.temporalRelation || {};
    const elbowJobEvaluations = modules.elbow?.jobEvaluations || [];
    const wristTemporal = modules.wrist?.temporalSequence || modules.wrist?.temporalRelation || {};
    const wristJobEvaluations = modules.wrist?.jobEvaluations || [];

    const firstJobId = jobs[0]?.id || '';
    const jobTaskPairs = [];
    const elbowPairs = [];
    const wristPairs = [];

    if (jobs.length > 0) {
      for (const job of jobs) {
        const jobSpineTasks = spineTasks.filter(task => (task.sharedJobId || firstJobId) === job.id);
        const jobCervicalTasks = cervicalTasks.filter(task => (task.sharedJobId || firstJobId) === job.id);
        const kneeExtra = kneeExtras.find(extra => extra.sharedJobId === job.id) || null;
        const elbowJobEvaluation = elbowJobEvaluations.find(item => item.sharedJobId === job.id);
        const wristJobEvaluation = wristJobEvaluations.find(item => item.sharedJobId === job.id);

        (elbowJobEvaluation?.diagnosisEntries || []).forEach(entry => {
          const diagnosis = diagnoses.find(item => item.id === entry.diagnosisId);
          if (diagnosis) {
            elbowPairs.push({ job, diagnosis, entry });
          }
        });

        (wristJobEvaluation?.diagnosisEntries || []).forEach(entry => {
          const diagnosis = diagnoses.find(item => item.id === entry.diagnosisId);
          if (diagnosis) {
            wristPairs.push({ job, diagnosis, entry });
          }
        });

        const pairCount = Math.max(jobSpineTasks.length, jobCervicalTasks.length, 1);
        for (let pairIndex = 0; pairIndex < pairCount; pairIndex += 1) {
          jobTaskPairs.push({
            job,
            task: jobSpineTasks[pairIndex] || null,
            cervicalTask: jobCervicalTasks[pairIndex] || null,
            kneeExtra,
          });
        }
      }
    } else {
      const pairCount = Math.max(spineTasks.length, cervicalTasks.length, 1);
      for (let pairIndex = 0; pairIndex < pairCount; pairIndex += 1) {
        jobTaskPairs.push({
          job: null,
          task: spineTasks[pairIndex] || null,
          cervicalTask: cervicalTasks[pairIndex] || null,
          kneeExtra: null,
        });
      }
    }

    const rowCount = Math.max(1, diagnoses.length, jobTaskPairs.length, elbowPairs.length, wristPairs.length);

    for (let index = 0; index < rowCount; index += 1) {
      const isFirst = index === 0;
      const elbowPair = elbowPairs[index] || null;
      const wristPair = wristPairs[index] || null;
      const pair = jobTaskPairs[index];
      const diag = elbowPair?.diagnosis || wristPair?.diagnosis || diagnoses[index];
      const job = elbowPair?.job || wristPair?.job || pair?.job;
      // 한 행의 재료 — 셀 값은 열 표(BATCH_COLUMNS)가 만든다.
      const ctx = {
        shared,
        modules,
        activeModules: patient.data.activeModules || [],
        isFirst,
        diag,
        job,
        task: pair?.task,
        cervicalTask: pair?.cervicalTask,
        kneeExtra: job ? (pair?.kneeExtra || kneeExtras.find(extra => extra.sharedJobId === job.id) || null) : pair?.kneeExtra,
        shoulderExtra: job ? shoulderExtras.find(extra => extra.sharedJobId === job.id) : null,
        elbowEntry: elbowPair?.entry || null,
        wristEntry: wristPair?.entry || null,
        elbowTemporal,
        wristTemporal,
      };
      rows.push(BATCH_COLUMNS.map(column => column.cell(ctx)));
    }
  }

  return rows;
}

function buildBatchWorkbook(patientList) {
  const dataRows = generateBatchRows(patientList);
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([BATCH_HEADERS, ...dataRows]);
  ws['!cols'] = BATCH_HEADERS.map(() => ({ wch: 18 }));
  XLSX.utils.book_append_sheet(wb, ws, '일괄입력');
  return wb;
}

export function exportBatchFormatSingle(patient) {
  const name = (patient.data.shared?.name || '미입력').replace(/[\\/:*?"<>|]/g, '_');
  const date = new Date().toISOString().split('T')[0];
  XLSX.writeFile(buildBatchWorkbook([patient]), `일괄입력_${name}_${date}.xlsx`);
}

export function exportBatchFormatSelected(patients, selectedIds) {
  const selected = patients.filter(patient => selectedIds.has(patient.id) && patient.data.shared?.name);
  if (selected.length === 0) return;
  const date = new Date().toISOString().split('T')[0];
  XLSX.writeFile(buildBatchWorkbook(selected), `일괄입력_${selected.length}명_${date}.xlsx`);
}

export function exportBatchFormatAll(patients) {
  const valid = patients.filter(patient => patient.data.shared?.name);
  if (valid.length === 0) return;
  const date = new Date().toISOString().split('T')[0];
  XLSX.writeFile(buildBatchWorkbook(valid), `일괄입력_${valid.length}명_${date}.xlsx`);
}

// 헤더만 있는 빈 일괄입력 양식 — 환자가 없어도 처음 사용자가 받아 작성할 수 있도록 항상 제공.
export function exportBatchTemplate() {
  const date = new Date().toISOString().split('T')[0];
  XLSX.writeFile(buildBatchWorkbook([]), `일괄입력_양식_${date}.xlsx`);
}
