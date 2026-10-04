import { describe, expect, it } from 'vitest';
import { validateIntakeStep, listIntakeIssues, INTAKE_STEP_INFO, INTAKE_STEP_DIAGNOSIS } from '../intakeValidation.js';

const diag = (id, code = '', name = '') => ({ id, code, name, moduleId: null, side: '' });

describe('validateIntakeStep — 기본정보', () => {
  it('빈 상태에서는 이름·생년월일·재해일자 모두 안내한다', () => {
    const errors = validateIntakeStep(INTAKE_STEP_INFO, { name: '', birthDate: '', injuryDate: '' });
    expect(errors).toEqual({
      name: '이름을 입력해 주세요',
      birthDate: '필수 입력입니다',
      injuryDate: '필수 입력입니다',
    });
  });

  it('이름은 trim 후 검사한다(공백만 있으면 비어 있는 것)', () => {
    expect(validateIntakeStep(INTAKE_STEP_INFO, { name: '   ', birthDate: '1980-01-01', injuryDate: '2020-01-01' }).name)
      .toBe('이름을 입력해 주세요');
    expect(validateIntakeStep(INTAKE_STEP_INFO, { name: ' 홍길동 ', birthDate: '1980-01-01', injuryDate: '2020-01-01' })).toEqual({});
  });

  it('값이 있어도 미래 날짜·존재하지 않는 날짜는 사유를 안내한다', () => {
    const errors = validateIntakeStep(INTAKE_STEP_INFO, { name: '홍', birthDate: '2999-01-01', injuryDate: '2021-02-31' });
    expect(errors.birthDate).toBe('오늘 이후의 날짜는 사용할 수 없습니다');
    expect(errors.injuryDate).toBe('실제로 존재하지 않는 날짜입니다');
    expect(errors.name).toBeUndefined();
  });

  it('모두 정상이면 오류가 없다', () => {
    expect(validateIntakeStep(INTAKE_STEP_INFO, { name: '홍길동', birthDate: '1980-01-01', injuryDate: '2020-05-05' })).toEqual({});
  });
});

describe('validateIntakeStep — 상병', () => {
  it('상병이 하나도 없거나 전부 빈 행이면 존재 검사 안내(목록 상단 문자열)', () => {
    expect(validateIntakeStep(INTAKE_STEP_DIAGNOSIS, { diagnoses: [] })).toEqual({ diagnoses: '상병이 입력되지 않았습니다' });
    expect(validateIntakeStep(INTAKE_STEP_DIAGNOSIS, { diagnoses: [diag('a'), diag('b', '  ', ' ')] }))
      .toEqual({ diagnoses: '상병이 입력되지 않았습니다' });
    expect(validateIntakeStep(INTAKE_STEP_DIAGNOSIS, {})).toEqual({ diagnoses: '상병이 입력되지 않았습니다' });
  });

  it('코드만/이름만 입력한 행에는 빈 쪽 필드 안내(행 id 키)', () => {
    const errors = validateIntakeStep(INTAKE_STEP_DIAGNOSIS, {
      diagnoses: [diag('a', 'M17.0', ''), diag('b', '', '무릎 관절증'), diag('c', 'M54.5', '요통')],
    });
    expect(errors.diagnoses).toBeUndefined();
    expect(errors.diagnosisRows).toEqual({
      a: { name: '진단명을 입력해 주세요' },
      b: { code: '진단코드를 입력해 주세요' },
    });
  });

  it('정상 상병 1건 + 완전히 빈 추가 행은 안내가 없다', () => {
    expect(validateIntakeStep(INTAKE_STEP_DIAGNOSIS, { diagnoses: [diag('a', 'M17.0', '무릎'), diag('b')] })).toEqual({});
  });

  it('공백만 있는 코드/이름은 입력되지 않은 것으로 본다', () => {
    const errors = validateIntakeStep(INTAKE_STEP_DIAGNOSIS, { diagnoses: [diag('a', 'M17.0', '   ')] });
    expect(errors.diagnosisRows).toEqual({ a: { name: '진단명을 입력해 주세요' } });
  });

  it('알 수 없는 단계(모듈 선택)는 오류 없음', () => {
    expect(validateIntakeStep(2, { name: '' })).toEqual({});
  });
});

describe('listIntakeIssues', () => {
  it('기본정보 항목을 이름·생년월일·재해일자 순으로 펼친다', () => {
    const errors = validateIntakeStep(INTAKE_STEP_INFO, { name: '', birthDate: '', injuryDate: '' });
    const issues = listIntakeIssues(INTAKE_STEP_INFO, errors, {});
    expect(issues.map((i) => i.label)).toEqual(['이름', '생년월일', '재해일자']);
    expect(issues.every((i) => i.step === INTAKE_STEP_INFO)).toBe(true);
  });

  it('상병 행 항목은 "상병 #N: 필드"로 현재 행 번호를 포함하고 diag.id로 식별한다(재정렬되어도 id 기준)', () => {
    const rows = [diag('x', 'M54.5', '요통'), diag('a', 'M17.0', ''), diag('b', '', '무릎')];
    const shared = { diagnoses: rows };
    const issues = listIntakeIssues(INTAKE_STEP_DIAGNOSIS, validateIntakeStep(INTAKE_STEP_DIAGNOSIS, shared), shared);
    expect(issues.map((i) => [i.label, i.rowId])).toEqual([
      ['상병 #2: 진단명', 'a'],
      ['상병 #3: 진단코드', 'b'],
    ]);
    // 첫 행을 삭제하면 번호가 당겨지고 같은 행(id)을 가리킨다.
    const shared2 = { diagnoses: rows.slice(1) };
    const issues2 = listIntakeIssues(INTAKE_STEP_DIAGNOSIS, validateIntakeStep(INTAKE_STEP_DIAGNOSIS, shared2), shared2);
    expect(issues2.map((i) => [i.label, i.rowId])).toEqual([
      ['상병 #1: 진단명', 'a'],
      ['상병 #2: 진단코드', 'b'],
    ]);
  });

  it('존재 검사 안내는 "상병" 라벨 하나로 나온다', () => {
    const issues = listIntakeIssues(INTAKE_STEP_DIAGNOSIS, { diagnoses: '상병이 입력되지 않았습니다' }, { diagnoses: [] });
    expect(issues).toEqual([expect.objectContaining({ label: '상병', message: '상병이 입력되지 않았습니다', step: INTAKE_STEP_DIAGNOSIS })]);
  });

  it('errors가 없으면 빈 목록', () => {
    expect(listIntakeIssues(INTAKE_STEP_INFO, null, {})).toEqual([]);
  });
});
