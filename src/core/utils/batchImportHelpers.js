import * as XLSX from 'xlsx';
import { getModule } from '../moduleRegistry';
import { createDiagnosis, createSharedJob } from './data';
import { LOW_REASON_OPTIONS } from '../../modules/knee/utils/data';
import { validatePastDate, describeDateRejectReason } from '@contracts/patientDates';

// 구 export 라벨 → 현재 value 별칭. 'mild'(상병 미확인/연령대비 경미)는 7개 분할 후
// 체크리스트에서 제거됐지만, 기존 파일 라운드트립을 위해 레거시 'mild'로 복원한다.
const LEGACY_REASON_LABEL_ALIASES = {
  '상병 미확인/연령대비 경미': 'mild',
};

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

// 엑셀 셀 값(문자열 · 숫자 serial 모두)을 parseDate로 1차 정규화한 뒤 공통 달력 규칙으로
// 검증한다. 셀을 날짜가 아닌 텍스트 서식으로 붙여넣으면 `4110-02-12` 같은 값이 그대로
// 통과해 서버 patient_persons.birth_date에 고착되고, 이후 모든 저장이 409로 막힌다.
// 반환: { valid, normalized, reason, message } — 호출부는 normalized를 저장해야 한다.
export function checkImportDate(value, options = {}) {
  // 숫자(엑셀 serial)만 parseDate로 1차 변환하고, 문자열은 원본 그대로 넘긴다.
  // parseDate의 정규식은 anchor가 없어 'abc2020-01-02xyz'에서도 날짜를 뽑아내므로,
  // 그걸 거치면 anchor된 validatePastDate가 무력화된다. parseDate 자체는 직종 시작/종료일 등
  // 다른 호출부가 기대하는 느슨한 동작이라 그대로 두고, 여기서만 우회한다.
  const input = typeof value === 'number' ? parseDate(value) : value;
  const result = validatePastDate(input, options);
  return {
    valid: result.valid,
    normalized: result.normalized,
    reason: result.reason,
    message: result.valid ? '' : describeDateRejectReason(result.reason),
  };
}

/** 편의 boolean 래퍼. 세부 사유가 필요하면 checkImportDate를 쓸 것. */
export function isPlausibleBirthDate(value, now) {
  return checkImportDate(value, { now }).valid;
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
    if (option) {
      reasons.push(option.value);
    } else if (LEGACY_REASON_LABEL_ALIASES[line]) {
      reasons.push(LEGACY_REASON_LABEL_ALIASES[line]);
    } else {
      reasons.push(line);
    }
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

// 미리보기 단계에서 전 행의 날짜 컬럼을 사전검증한다.
// handleImport 안에서 검사하면 정상 행이 하나라도 있을 때 onImport() 직후 모달이 닫혀
// 사용자가 오류를 볼 수 없으므로, 파일 로딩 직후에 호출해야 한다.
// 반환: [{ rowIndex, rowLabel, name, field, rawValue, message }]
export function collectImportDateErrors(rows, options = {}) {
  if (!Array.isArray(rows) || rows.length < 2) return [];

  const headerRow = (rows[0] || []).map(normalizeHeader);
  const colMap = buildColMap(headerRow, [BASE_DATE_COLUMNS]);
  const errors = [];

  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (!row || row.length === 0) continue;

    const name = String(getCell(row, colMap.name) || '').trim();
    // 이름이 없는 행은 handleImport가 건너뛰므로 검증 대상에서도 제외한다.
    if (!name) continue;

    for (const field of DATE_FIELDS) {
      const raw = getCell(row, colMap[field.key]);
      if (raw === undefined || raw === null || String(raw).trim() === '') continue;

      const check = checkImportDate(raw, options);
      if (!check.valid) {
        errors.push({
          rowIndex,
          // 엑셀 행 번호는 1-based이고 헤더가 1행이므로 데이터 첫 행이 2행이다.
          rowLabel: rowIndex + 1,
          name,
          field: field.label,
          rawValue: String(raw).trim(),
          message: check.message,
        });
      }
    }
  }

  return errors;
}

const BASE_DATE_COLUMNS = {
  name: ['이름', 'name'],
  birthDate: ['생년월일', 'birth'],
  injuryDate: ['재해일자', 'injury'],
};

const DATE_FIELDS = [
  { key: 'birthDate', label: '생년월일' },
  { key: 'injuryDate', label: '재해일자' },
];

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
