// 척추 출력의 빈 직종명(P2-72h, 결정 5) — 실제 계산(computeSpineCalc)을 거쳐 [직력N: …] 머리줄에 출력 낱말이 나오는지 고정한다.
// 계산은 빈 직종명을 화면 낱말 `(미입력)`으로 채우고 sectionText가 그것을 출력 낱말로 바꿔 쓴다 — 계산 쪽 낱말이 바뀌면
// 이 테스트가 실패해 둘의 연결이 끊긴 것을 알린다.
import { describe, expect, it } from 'vitest';
import { computeSpineCalc } from '@wr/analytics-core/modules/spine/index';
import type { SpineModuleShape } from '@wr/analytics-core/modules/spine/index';
import { buildSpineSectionText } from '../sectionText';
import { OUTPUT_EMPTY_JOB_NAME } from '../../../../core/narrative/phrases';
import { EMPTY_JOB_NAME_LABEL } from '../../../../core/utils/jobLabels';

const jobs = [
  { id: 'job-a', jobName: '', startDate: '2001-01-01', endDate: '2010-01-01', workPeriodOverride: '', workDaysPerYear: 250 },
  { id: 'job-b', jobName: '합성 운반원', startDate: '2010-01-01', endDate: '2020-01-01', workPeriodOverride: '', workDaysPerYear: 250 },
];

const module = {
  mddmStatus: 'present',
  vibrationExposureStatus: 'present',
  tasks: [
    { id: 't1', name: '작업 t1', posture: 'G1', weight: 40, frequency: 200, timeValue: 5, timeUnit: 'sec', correctionFactor: 1.0, force: 0, sharedJobId: 'job-a' },
    { id: 't2', name: '작업 t2', posture: 'G1', weight: 40, frequency: 200, timeValue: 5, timeUnit: 'sec', correctionFactor: 1.0, force: 0, sharedJobId: 'job-b' },
  ],
  vibrationIntervals: [
    { id: 'v1', name: '진동 v1', awMin: 0.5, awMax: 0.8, timeValue: 4, timeUnit: 'hr', sharedJobId: 'job-a' },
    { id: 'v2', name: '진동 v2', awMin: 0.5, awMax: 0.8, timeValue: 4, timeUnit: 'hr', sharedJobId: 'job-b' },
  ],
  formulaVersion: 'v5.1.3',
} as SpineModuleShape;

describe('척추 섹션 — 빈 직종명 출력(결정 5)', () => {
  const calc = computeSpineCalc({ shared: { jobs, gender: 'male' }, module });

  it('계산은 빈 직종명을 화면 낱말로 채운다(이 연결의 전제)', () => {
    expect(calc.jobResults.map(jr => jr.jobName)).toEqual([EMPTY_JOB_NAME_LABEL, '합성 운반원']);
    expect(calc.vibration.jobResults.map(jr => jr.jobName)).toEqual([EMPTY_JOB_NAME_LABEL, '합성 운반원']);
  });

  it('MDDM·전신진동 작업별 분석의 직력 머리줄은 출력 낱말', () => {
    const text = buildSpineSectionText(calc);
    const heads = text.split('\n').filter(line => line.startsWith('[직력'));
    expect(heads).toEqual([
      `[직력1: ${OUTPUT_EMPTY_JOB_NAME}]`,
      '[직력2: 합성 운반원]',
      `[직력1: ${OUTPUT_EMPTY_JOB_NAME}]`,
      '[직력2: 합성 운반원]',
    ]);
    expect(OUTPUT_EMPTY_JOB_NAME).toBe('직업 미입력');
    expect(text).not.toContain(EMPTY_JOB_NAME_LABEL);
  });
});
