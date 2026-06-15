import * as XLSX from 'xlsx';
import { getModule } from '../moduleRegistry';
import { createDiagnosis, createSharedJob } from './data';
import { LOW_REASON_OPTIONS } from '../../modules/knee/utils/data';

export function normalizeHeader(value) {
  return String(value || '').trim().toLowerCase();
}

export function parseDate(value) {
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

export function parseBool(value) {
  if (!value) return false;
  const str = String(value).trim().toLowerCase();
  return ['o', '1', 'true', 'yes', 'y', '예'].includes(str);
}

export function parseYesNo(value, fallback = '') {
  if (value === undefined || value === null || value === '') return fallback;
  const str = String(value).trim().toLowerCase();
  if (['o', '1', 'true', 'yes', 'y', '예'].includes(str)) return 'yes';
  if (['x', '0', 'false', 'no', 'n', '아니오'].includes(str)) return 'no';
  return String(value).trim();
}

export function parseGender(value) {
  const str = String(value || '').trim().toLowerCase();
  if (['남', '남자', 'male', 'm'].includes(str)) return 'male';
  if (['여', '여자', 'female', 'f'].includes(str)) return 'female';
  return '';
}

export function parseSide(value) {
  const str = String(value || '').trim().toLowerCase();
  if (['우측', 'right'].includes(str)) return 'right';
  if (['좌측', 'left'].includes(str)) return 'left';
  if (['양측', 'both'].includes(str)) return 'both';
  return '';
}

export function parseKlg(value) {
  if (!value) return '';
  const str = String(value).trim();
  if (str === 'N/A' || str === '해당없음') return 'N/A';
  const match = str.match(/(\d)/);
  return match ? match[1] : '';
}

export function splitList(value) {
  if (!value) return [];
  return String(value).split('|').map(item => item.trim()).filter(Boolean);
}

const OTHER_REASON_PATTERN = /^기타\s*\((.*)\)$/;

export function parseConfirmedStatus(value) {
  const str = String(value || '').trim();
  if (str === '확인') return 'confirmed';
  if (str === '미확인') return 'unconfirmed';
  return '';
}

export function parseAssessmentLevel(value) {
  const str = String(value || '').trim();
  if (str === '높음') return 'high';
  if (str === '낮음') return 'low';
  return '';
}

export function parseReasonText(value) {
  const str = String(value || '').trim();
  if (!str || str === '-') return { reasons: [], other: '' };

  const reasons = [];
  let other = '';
  for (const rawLine of str.split(/\r\n|\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const otherMatch = line.match(OTHER_REASON_PATTERN);
    if (otherMatch) {
      reasons.push('other');
      other = otherMatch[1].trim();
      continue;
    }
    const option = LOW_REASON_OPTIONS.find(opt => opt.label === line);
    reasons.push(option ? option.value : line);
  }
  return { reasons, other };
}

export function getCell(row, index) {
  return index >= 0 ? row[index] : undefined;
}

export function buildColMap(headerRow, columnGroups) {
  const findCol = (...names) => headerRow.findIndex(header => names.some(name => header.includes(name)));
  const colMap = {};
  for (const group of columnGroups) {
    for (const [key, candidates] of Object.entries(group)) {
      colMap[key] = findCol(...candidates);
    }
  }
  return colMap;
}

export function ensureModule(patient, moduleId) {
  if (!patient.data.activeModules.includes(moduleId)) {
    patient.data.activeModules.push(moduleId);
  }
  if (!patient.data.modules[moduleId]) {
    const mod = getModule(moduleId);
    if (mod?.createModuleData) patient.data.modules[moduleId] = mod.createModuleData();
  }
  return patient.data.modules[moduleId];
}

export function ensureDiagnosis(patient, diagCode, diagName, side, stats) {
  let diagnosis = (patient.data.shared.diagnoses || []).find(item =>
    item.code === diagCode && item.name === diagName && item.side === side
  );
  if (!diagnosis && (diagCode || diagName)) {
    diagnosis = { ...createDiagnosis(), code: diagCode, name: diagName, side };
    patient.data.shared.diagnoses.push(diagnosis);
    stats.newDiagnoses += 1;
  }
  return diagnosis;
}

export function ensureSharedJob(patient, row, colMap, getCellFn, stats) {
  const jobName = String(getCellFn(row, colMap.jobName) || '').trim();
  if (!jobName) return null;
  let job = (patient.data.shared.jobs || []).find(item => item.jobName === jobName);
  if (!job) {
    job = createSharedJob();
    job.jobName = jobName;
    job.startDate = parseDate(getCellFn(row, colMap.jobStart));
    job.endDate = parseDate(getCellFn(row, colMap.jobEnd));
    const years = parseInt(getCellFn(row, colMap.jobPeriodY), 10) || 0;
    const months = parseInt(getCellFn(row, colMap.jobPeriodM), 10) || 0;
    job.workPeriodOverride = years || months ? `${years}년 ${months}개월` : '';
    patient.data.shared.jobs.push(job);
    stats.newJobs += 1;
  }
  return job;
}

export function applyReturnConsiderations(patient, value, moduleIds) {
  if (!value) return;
  moduleIds.forEach(moduleId => {
    if (patient.data.modules[moduleId]) {
      patient.data.modules[moduleId].returnConsiderations = value;
    }
  });
}

function arraysEqual(a, b) {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

// 진단에 종합소견(상병 상태/업무관련성) 값을 반영하고, 기존 값과 달라진 값이 있으면 true 반환
export function applyDiagnosisAssessment(diagnosis, row, colMap, getCellFn, moduleId) {
  if (!diagnosis) return false;

  let changed = false;

  const confirmedRight = parseConfirmedStatus(getCellFn(row, colMap.diagConfirmedRight));
  if (confirmedRight && confirmedRight !== diagnosis.confirmedRight) { diagnosis.confirmedRight = confirmedRight; changed = true; }

  const confirmedLeft = parseConfirmedStatus(getCellFn(row, colMap.diagConfirmedLeft));
  if (confirmedLeft && confirmedLeft !== diagnosis.confirmedLeft) { diagnosis.confirmedLeft = confirmedLeft; changed = true; }

  const assessmentRight = parseAssessmentLevel(getCellFn(row, colMap.diagAssessmentRight));
  if (assessmentRight && assessmentRight !== diagnosis.assessmentRight) { diagnosis.assessmentRight = assessmentRight; changed = true; }

  const assessmentLeft = parseAssessmentLevel(getCellFn(row, colMap.diagAssessmentLeft));
  if (assessmentLeft && assessmentLeft !== diagnosis.assessmentLeft) { diagnosis.assessmentLeft = assessmentLeft; changed = true; }

  const reasonRightCell = String(getCellFn(row, colMap.diagReasonRight) || '').trim();
  if (reasonRightCell && reasonRightCell !== '-') {
    const { reasons, other } = parseReasonText(reasonRightCell);
    if (!arraysEqual(diagnosis.reasonRight || [], reasons) || (diagnosis.reasonRightOther || '') !== other) {
      diagnosis.reasonRight = reasons;
      diagnosis.reasonRightOther = other;
      changed = true;
    }
  }

  const reasonLeftCell = String(getCellFn(row, colMap.diagReasonLeft) || '').trim();
  if (reasonLeftCell && reasonLeftCell !== '-') {
    const { reasons, other } = parseReasonText(reasonLeftCell);
    if (!arraysEqual(diagnosis.reasonLeft || [], reasons) || (diagnosis.reasonLeftOther || '') !== other) {
      diagnosis.reasonLeft = reasons;
      diagnosis.reasonLeftOther = other;
      changed = true;
    }
  }

  if (moduleId === 'spine') {
    const verticalDistribution = parseConfirmedStatus(getCellFn(row, colMap.diagVerticalDistribution));
    if (verticalDistribution && verticalDistribution !== diagnosis.verticalDistribution) { diagnosis.verticalDistribution = verticalDistribution; changed = true; }

    const concomitantSpondylosis = parseConfirmedStatus(getCellFn(row, colMap.diagConcomitantSpondylosis));
    if (concomitantSpondylosis && concomitantSpondylosis !== diagnosis.concomitantSpondylosis) { diagnosis.concomitantSpondylosis = concomitantSpondylosis; changed = true; }
  }

  return changed;
}
