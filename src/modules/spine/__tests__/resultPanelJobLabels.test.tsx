// @vitest-environment jsdom
//
// 척추·전신진동 결과 패널의 직력 카드 제목(P2-72f, 결정 4) — 근무 기간이 0이면 `-`, 빈 직종명은 `(미입력)`.
// 골든 환자에는 직력이 여럿이면서 기간이 0인 척추 사례가 없어 합성 환자로 실제 계산(computeSpineCalc)을 거쳐 그린다.
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { computeSpineCalc } from '@wr/analytics-core/modules/spine/index';
import type { SpineModuleShape } from '@wr/analytics-core/modules/spine/index';
import { SpineResultPanel } from '../components/SpineResultPanel';
import { VibrationResultPanel } from '../components/VibrationResultPanel';

const jobs = [
  { id: 'job-a', jobName: '', startDate: '', endDate: '', workPeriodOverride: '', workDaysPerYear: 250 },
  { id: 'job-b', jobName: '합성 운반원', startDate: '2010-01-01', endDate: '2020-01-01', workPeriodOverride: '', workDaysPerYear: 250 },
];

const task = (id: string, sharedJobId: string) => ({
  id, name: `작업 ${id}`, posture: 'G1', weight: 40, frequency: 200, timeValue: 5, timeUnit: 'sec', correctionFactor: 1.0, force: 0, sharedJobId,
});

const interval = (id: string, sharedJobId: string) => ({
  id, name: `진동 ${id}`, awMin: 0.5, awMax: 0.8, timeValue: 4, timeUnit: 'hr', sharedJobId,
});

const module = {
  mddmStatus: 'present',
  vibrationExposureStatus: 'present',
  tasks: [task('t1', 'job-a'), task('t2', 'job-b')],
  vibrationIntervals: [interval('v1', 'job-a'), interval('v2', 'job-b')],
  formulaVersion: 'v5.1.3',
} as SpineModuleShape;

function cardTitles(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.result-card-title'))
    .map(el => (el.textContent || '').replace(/\s+/g, ' ').trim())
    .filter(text => text.startsWith('직력'));
}

describe('척추·전신진동 결과 패널 — 직력 카드 제목(결정 4)', () => {
  const calc = computeSpineCalc({ shared: { jobs, gender: 'male' }, module });

  it('MDDM 직업별 누적선량 내역', () => {
    const { container, unmount } = render(<SpineResultPanel calc={calc} />);
    expect(cardTitles(container)).toEqual(['직력1: (미입력) (-)', '직력2: 합성 운반원 (10.0년)']);
    unmount();
  });

  it('전신진동 직업별 노출 내역', () => {
    const { container, unmount } = render(<VibrationResultPanel calc={calc.vibration} />);
    expect(cardTitles(container)).toEqual(['직력1: (미입력) (-)', '직력2: 합성 운반원 (10.0년)']);
    unmount();
  });
});
