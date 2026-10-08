// @vitest-environment jsdom
//
// 직력 카드의 "신체부담평가 포함/미포함" 라디오 — 기본값, 토글, 카드 표시, 다른 필드 보존, 레거시 혼재 시 비활성화.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { BasicInfoForm } from '../BasicInfoForm.jsx';

afterEach(cleanup);

const baseShared = (jobs) => ({
  patientNo: '', name: '', gender: '', height: '', weight: '', birthDate: '', injuryDate: '', evaluationDate: '',
  hospitalName: '', department: '', doctorName: '', specialNotes: '', diagnoses: [], jobs,
  medicalRecord: '', highBloodPressure: '', diabetes: '', visitHistory: '',
});
const job = (id, jobName, extra = {}) => ({ id, jobName, presetId: null, startDate: '2010-01-01', endDate: '2015-01-01', workPeriodOverride: '', workDaysPerYear: 250, ...extra });

function Harness({ initialJobs, legacyExclusionBlocked = false, spy }) {
  const [shared, setShared] = useState(baseShared(initialJobs));
  return (
    <BasicInfoForm
      shared={shared}
      onChange={(next) => { spy?.(next); setShared(next); }}
      errors={{}}
      legacyExclusionBlocked={legacyExclusionBlocked}
    />
  );
}

function cards() {
  return Array.from(document.querySelectorAll('.job-card'));
}

describe('BasicInfoForm — 신체부담평가 포함/미포함 라디오', () => {
  it('기본값은 모든 직력이 "포함"이고 카드에 미포함 표시가 없다', () => {
    render(<Harness initialJobs={[job('a', '철근공'), job('b', '사무직')]} />);
    cards().forEach((card) => {
      const [incl, excl] = within(card).getAllByRole('radio');
      expect(incl.checked).toBe(true);
      expect(excl.checked).toBe(false);
      expect(card.classList.contains('is-excluded')).toBe(false);
      expect(card.querySelector('.job-excluded-badge')).toBeNull();
    });
  });

  it('구데이터(excludeFromAnalysis 필드 없음)도 "포함"으로 보인다', () => {
    render(<Harness initialJobs={[job('a', '철근공')]} />);
    const [incl] = within(cards()[0]).getAllByRole('radio');
    expect(incl.checked).toBe(true);
  });

  it('"미포함"을 고르면 해당 직력만 true로 저장되고 다른 필드·다른 직력은 그대로다', () => {
    const calls = [];
    render(<Harness initialJobs={[job('a', '철근공'), job('b', '사무직')]} spy={(s) => calls.push(s)} />);
    const [, excl] = within(cards()[1]).getAllByRole('radio');
    fireEvent.click(excl);

    const saved = calls[calls.length - 1].jobs;
    expect(saved[0].excludeFromAnalysis).toBeUndefined();
    expect(saved[1]).toMatchObject({ id: 'b', jobName: '사무직', startDate: '2010-01-01', endDate: '2015-01-01', workDaysPerYear: 250, excludeFromAnalysis: true });
  });

  it('미포함 직력 카드에는 is-excluded 클래스와 배지가 붙고, 입력 필드는 비활성화되지 않는다', () => {
    render(<Harness initialJobs={[job('a', '철근공'), job('b', '사무직')]} />);
    fireEvent.click(within(cards()[1]).getAllByRole('radio')[1]);

    const [first, second] = cards();
    expect(first.classList.contains('is-excluded')).toBe(false);
    expect(second.classList.contains('is-excluded')).toBe(true);
    expect(second.querySelector('.job-excluded-badge').textContent).toContain('신체부담평가 미포함');
    second.querySelectorAll('input[type="date"], input[type="number"], input:not([type])').forEach((input) => {
      expect(input.disabled).toBe(false);
    });
  });

  it('"포함"으로 되돌리면 false가 저장되고 표시가 사라진다', () => {
    const calls = [];
    render(<Harness initialJobs={[job('a', '철근공', { excludeFromAnalysis: true })]} spy={(s) => calls.push(s)} />);
    expect(cards()[0].classList.contains('is-excluded')).toBe(true);

    fireEvent.click(within(cards()[0]).getAllByRole('radio')[0]);
    expect(calls[calls.length - 1].jobs[0].excludeFromAnalysis).toBe(false);
    expect(cards()[0].classList.contains('is-excluded')).toBe(false);
    expect(cards()[0].querySelector('.job-excluded-badge')).toBeNull();
  });

  it('직력마다 별도 라디오 그룹이다 (한 카드의 선택이 다른 카드를 바꾸지 않는다)', () => {
    render(<Harness initialJobs={[job('a', 'A'), job('b', 'B')]} />);
    const names = cards().map((card) => within(card).getAllByRole('radio')[0].name);
    expect(new Set(names).size).toBe(2);
    fireEvent.click(within(cards()[0]).getAllByRole('radio')[1]);
    expect(within(cards()[1]).getAllByRole('radio')[0].checked).toBe(true);
  });

  it('레거시 혼재 환자: "미포함"이 비활성화되고 사유 문구가 보인다', () => {
    render(<Harness initialJobs={[job('a', '철근공')]} legacyExclusionBlocked />);
    const [incl, excl] = within(cards()[0]).getAllByRole('radio');
    expect(excl.disabled).toBe(true);
    expect(incl.disabled).toBe(false);
    expect(screen.getByText(/구형 직력 입력 데이터가 있어 미포함을 설정할 수 없습니다/)).toBeTruthy();
  });

  it('레거시 혼재여도 이미 미포함으로 저장된 직력은 "포함"으로 되돌릴 수 있다', () => {
    render(<Harness initialJobs={[job('a', '철근공', { excludeFromAnalysis: true })]} legacyExclusionBlocked />);
    const [incl, excl] = within(cards()[0]).getAllByRole('radio');
    expect(excl.disabled).toBe(false);
    fireEvent.click(incl);
    expect(within(cards()[0]).getAllByRole('radio')[0].checked).toBe(true);
  });

  it('직력 추가 시 새 직력은 "포함"이다', () => {
    render(<Harness initialJobs={[job('a', '철근공')]} />);
    fireEvent.click(screen.getByText('+ 직종 추가'));
    expect(cards()).toHaveLength(2);
    expect(within(cards()[1]).getAllByRole('radio')[0].checked).toBe(true);
  });
});
