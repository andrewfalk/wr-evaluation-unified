// 신규 환자 등록 마법사의 단계별 필수값 검증. 이동을 막지 않고(안내만) 어떤 항목이 비었는지/잘못됐는지를
// 계산한다 — 호출부(IntakeWizard)는 현재 shared에서 매번 다시 계산하므로 값을 고치면 안내가 자동으로 사라진다.
import { validatePastDate, describeDateRejectReason } from '@contracts/patientDates';

export const INTAKE_STEP_INFO = 0;
export const INTAKE_STEP_DIAGNOSIS = 1;

const isBlank = (v) => typeof v !== 'string' || v.trim() === '';

function dateMessage(value) {
  const result = validatePastDate(value, { allowEmpty: false });
  if (result.valid) return null;
  return result.reason === 'empty' ? '필수 입력입니다' : describeDateRejectReason(result.reason);
}

/**
 * 단계별 오류 객체.
 *  - 0(기본정보): { name?, birthDate?, injuryDate? }
 *  - 1(상병): { diagnoses?: string(존재 검사, 목록 상단), diagnosisRows?: { [diag.id]: { code?, name? } } }
 *  - 그 외(모듈 선택 등): {}
 *
 * 상병 정책(원안 "코드 또는 이름이 있는 행 1건 이상"보다 엄격): ① 코드 또는 이름이 있는 행이 1건 이상이어야 하고,
 * ② 입력이 시작된 행은 `*` 표시가 있는 진단코드·진단명이 둘 다 있어야 한다. 완전히 빈 추가 행은 무시한다.
 */
export function validateIntakeStep(stepIndex, shared) {
  const s = shared || {};
  if (stepIndex === INTAKE_STEP_INFO) {
    const errors = {};
    if (isBlank(s.name)) errors.name = '이름을 입력해 주세요';
    const birth = dateMessage(s.birthDate);
    if (birth) errors.birthDate = birth;
    const injury = dateMessage(s.injuryDate);
    if (injury) errors.injuryDate = injury;
    return errors;
  }
  if (stepIndex === INTAKE_STEP_DIAGNOSIS) {
    const errors = {};
    const rows = Array.isArray(s.diagnoses) ? s.diagnoses : [];
    const started = rows.filter((d) => !isBlank(d?.code) || !isBlank(d?.name));
    if (started.length === 0) {
      errors.diagnoses = '상병이 입력되지 않았습니다';
      return errors;
    }
    const diagnosisRows = {};
    for (const d of started) {
      const rowErrors = {};
      if (isBlank(d.code)) rowErrors.code = '진단코드를 입력해 주세요';
      if (isBlank(d.name)) rowErrors.name = '진단명을 입력해 주세요';
      if (rowErrors.code || rowErrors.name) diagnosisRows[d.id] = rowErrors;
    }
    if (Object.keys(diagnosisRows).length > 0) errors.diagnosisRows = diagnosisRows;
    return errors;
  }
  return {};
}

const STEP_LABELS = { [INTAKE_STEP_INFO]: '기본정보', [INTAKE_STEP_DIAGNOSIS]: '상병' };
const INFO_FIELD_LABELS = { name: '이름', birthDate: '생년월일', injuryDate: '재해일자' };
const ROW_FIELD_LABELS = { code: '진단코드', name: '진단명' };

/**
 * 오류 객체를 요약 목록 항목으로 펼친다: [{ step, key, label, message, rowId? }].
 * 상병 행은 "상병 #N: 진단명" 형식으로 행 번호를 포함한다(행 삭제·재정렬 후에도 diag.id로 찾는다).
 */
export function listIntakeIssues(stepIndex, errors, shared) {
  const issues = [];
  if (!errors) return issues;
  if (stepIndex === INTAKE_STEP_INFO) {
    for (const key of ['name', 'birthDate', 'injuryDate']) {
      if (errors[key]) issues.push({ step: stepIndex, key, label: INFO_FIELD_LABELS[key], message: errors[key] });
    }
  } else if (stepIndex === INTAKE_STEP_DIAGNOSIS) {
    if (errors.diagnoses) issues.push({ step: stepIndex, key: 'diagnoses', label: STEP_LABELS[stepIndex], message: errors.diagnoses });
    const rows = Array.isArray(shared?.diagnoses) ? shared.diagnoses : [];
    rows.forEach((d, i) => {
      const rowErrors = errors.diagnosisRows?.[d.id];
      if (!rowErrors) return;
      for (const field of ['code', 'name']) {
        if (rowErrors[field]) {
          issues.push({
            step: stepIndex, key: `row:${d.id}:${field}`, rowId: d.id,
            label: `상병 #${i + 1}: ${ROW_FIELD_LABELS[field]}`, message: rowErrors[field],
          });
        }
      }
    });
  }
  return issues;
}
