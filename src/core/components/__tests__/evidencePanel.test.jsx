// @vitest-environment jsdom
// "왜 이 값?" 근거 패널(EvidencePanel) 렌더 테스트 — 공정별 블록 + dl 키-값 구조.
// flatCandidateList.test.jsx는 근거 렌더러를 stub으로 주입하므로 실제 키-값 배치는 여기서만 검증된다.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { EvidencePanel } from '../VideoAnalysisStep.jsx';

afterEach(cleanup);

const LONG_JOB_ID = '6fd458da-9ed2-4f0f-ab04-a51e41c2aeb8-with-a-very-long-suffix-0123456789';

const makeContribution = (name, share, extra = {}) => ({
  processName: name,
  sharePercent: share,
  perDayValue: 2.8,
  evidence: {
    intrinsicMetric: 'posture_ratio',
    intrinsicValue: 0.4,
    activeMinutesPerDay: 420,
    fusion: { adopted: { viewpoint: 'sagittal', jobId: LONG_JOB_ID }, candidates: [{}, {}] },
    confidenceBreakdown: { keypoint: 0.75, visibility: 1, tracking: 0.96 },
    segments: [{}, {}, {}],
    ...extra,
  },
});

const jobEv = {
  aggregationMethod: 'weightedSum',
  analysisJobIds: [LONG_JOB_ID],
  contributions: [
    makeContribution('조립', 60),
    makeContribution('포장', 40, { warnings: ['NON_PREFERRED_VIEWPOINT'] }),
  ],
};

describe('EvidencePanel', () => {
  it('공정별 블록을 유지하고 각 블록 안에 dt/dd 키-값 행을 둔다', () => {
    const { container } = render(<EvidencePanel jobEv={jobEv} unit="hours_per_day" />);
    const procs = container.querySelectorAll('.va-evidence-proc');
    expect(procs).toHaveLength(2);
    expect(procs[0].textContent).toContain('조립');
    expect(procs[0].textContent).toContain('공정 점유율 60%');
    expect(procs[1].textContent).toContain('포장');
    // 각 공정 블록은 환산식·채택 시점·신뢰도 성분·근거 구간 4행
    for (const proc of procs) {
      const labels = [...proc.querySelectorAll('dt')].map((n) => n.textContent);
      expect(labels).toEqual(['환산식', '채택 시점', '신뢰도 성분', '근거 구간']);
      expect(proc.querySelectorAll('dd')).toHaveLength(4);
    }
    // 공통 행(집계 방식·분석 job)은 공정 블록 밖
    const topLabels = [...container.querySelector('.va-evidence > dl').querySelectorAll('dt')].map((n) => n.textContent);
    expect(topLabels).toEqual(['집계 방식', '분석 job']);
  });

  it('환산식·채택 시점·신뢰도 chips 값을 표시하고 긴 job ID를 그대로 포함한다', () => {
    const { container } = render(<EvidencePanel jobEv={jobEv} unit="hours_per_day" />);
    const first = container.querySelector('.va-evidence-proc');
    expect(first.textContent).toContain('2.8 시간/일 = 자세비율 0.4 × 활동 420분/일 ÷ 60');
    expect(first.textContent).toContain(`sagittal (job ${LONG_JOB_ID}) / 후보 2개`);
    expect(first.textContent).toContain('3개');
    const chips = [...first.querySelectorAll('.va-evidence-chips .va-flag-pill')].map((n) => n.textContent);
    expect(chips).toEqual(['keypoint 75%', 'visibility 100%', 'tracking 96%']);
    expect(container.querySelector('.va-evidence > dl').textContent).toContain(LONG_JOB_ID);
  });

  it('경고는 해당 공정 블록에만 callout으로 표시한다', () => {
    const { container } = render(<EvidencePanel jobEv={jobEv} unit="hours_per_day" />);
    const procs = container.querySelectorAll('.va-evidence-proc');
    expect(procs[0].querySelector('.va-evidence-warn')).toBeNull();
    expect(procs[1].querySelector('.va-evidence-warn').textContent).toContain('NON_PREFERRED_VIEWPOINT');
  });

  it('실험값 안내 문구를 항상 표시한다', () => {
    const { container } = render(<EvidencePanel jobEv={jobEv} unit="hours_per_day" />);
    expect(container.textContent).toContain('신뢰도·경고는 실험값입니다');
  });

  it('jobEv 없음(재진입·mock) → fallback 안내만 표시', () => {
    const { container } = render(<EvidencePanel jobEv={undefined} unit="hours_per_day" />);
    expect(container.textContent).toContain('근거 정보는 현재 분석 세션에서만 표시됩니다');
    expect(container.querySelector('dl')).toBeNull();
  });

  it('분석 job·신뢰도·구간·환산식 정보가 없으면 해당 행은 그리지 않는다', () => {
    const sparse = {
      aggregationMethod: 'task(1:1)',
      contributions: [{ processName: '조립', sharePercent: 100, evidence: {} }],
    };
    const { container } = render(<EvidencePanel jobEv={sparse} unit="hours_per_day" />);
    const topLabels = [...container.querySelector('.va-evidence > dl').querySelectorAll('dt')].map((n) => n.textContent);
    expect(topLabels).toEqual(['집계 방식']);
    expect(container.querySelector('.va-evidence-proc dl').children).toHaveLength(0);
  });
});
