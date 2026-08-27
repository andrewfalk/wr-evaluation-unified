// @vitest-environment jsdom
// 6.0-18: flat "참고 후보" 골격 검수·근거 배선 — 렌더 회귀 테스트.
// 이번 버그의 본체는 데이터 계산이 아니라 JSX에서 renderSkeletonReview/renderEvidencePanel 호출을
// 빠뜨린 것이었다(videoAnalysisStep.test.js의 순수 함수 테스트는 이런 배선 누락을 원리적으로 못 잡는다).
// 그래서 여기서는 render prop(renderEvidencePanel/renderSkeletonReview)을 vi.fn() stub으로 주입하고
// 실제로 호출됐는지·어떤 인자로 호출됐는지까지 검증한다.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FlatCandidateList } from '../VideoAnalysisStep.jsx';

afterEach(cleanup);

const processes = [
  { id: 'p1', name: '조립', activeMinutesPerDay: 300 },
  { id: 'p2', name: '포장', activeMinutesPerDay: 180 },
];
const candidateP1 = {
  featureKey: 'wristFlexionPeakAngle', value: 42,
  reason: '손목 굴곡 peak 추정(참고용·측면 클립)', processIds: ['p1'], clipIds: [],
};
const candidateP2 = {
  featureKey: 'wristFlexionPeakAngle', value: 38,
  reason: '손목 굴곡 peak 추정(참고용·측면 클립)', processIds: ['p2'], clipIds: [],
};
const FAKE_JOB_EV = { contributions: [{ processName: '조립', evidence: {} }] };
const evidenceMap = { p1: { wristFlexionPeakAngle: FAKE_JOB_EV } };

function makeStubs() {
  return {
    // jobEv가 있을 때만 마커 렌더 — 실제 renderSkeletonReview의 "골격 없으면 null" 계약을 흉내.
    skeletonStub: vi.fn((rowKey, jobEv) => (jobEv ? <div>골격:{rowKey}</div> : null)),
    panelStub: vi.fn((jobEv, unit) => <div>근거:{String(unit)}</div>),
  };
}

describe('FlatCandidateList (6.0-18 — flat 참고 후보 골격 검수·근거 렌더 배선)', () => {
  it('① 서버 모드 + evidence 있음 — "왜 이 값?" 노출, skeletonStub이 정확한 rowKey·jobEv로 호출된다', () => {
    const { skeletonStub, panelStub } = makeStubs();
    render(
      <FlatCandidateList
        candidates={[candidateP1]}
        processes={processes}
        processEvidenceByProcessId={evidenceMap}
        suppressedCandidates={[]}
        serverMode
        expandedEvidence={null}
        onToggleEvidence={vi.fn()}
        renderEvidencePanel={panelStub}
        renderSkeletonReview={skeletonStub}
      />
    );
    expect(screen.getByRole('button', { name: '왜 이 값?' })).toBeTruthy();
    expect(skeletonStub).toHaveBeenCalledWith('flat:p1:wristFlexionPeakAngle', FAKE_JOB_EV);
    expect(screen.getByText('골격:flat:p1:wristFlexionPeakAngle')).toBeTruthy();
  });

  it('② mock 모드 — "왜 이 값?"·세션 안내·골격 전부 미노출, skeletonStub 미호출', () => {
    const { skeletonStub, panelStub } = makeStubs();
    render(
      <FlatCandidateList
        candidates={[candidateP1]}
        processes={processes}
        processEvidenceByProcessId={evidenceMap}
        suppressedCandidates={[]}
        serverMode={false}
        expandedEvidence={null}
        onToggleEvidence={vi.fn()}
        renderEvidencePanel={panelStub}
        renderSkeletonReview={skeletonStub}
      />
    );
    expect(screen.queryByRole('button', { name: '왜 이 값?' })).toBeNull();
    expect(screen.queryByText(/골격 검수·근거는 현재 분석 세션에서만/)).toBeNull();
    expect(skeletonStub).not.toHaveBeenCalled();
  });

  it('②b mock 모드 + expandedEvidence가 그 rowKey(모드 전환 후 stale) — panelStub 미호출(상세 영역 자체가 안 열림)', () => {
    const { skeletonStub, panelStub } = makeStubs();
    render(
      <FlatCandidateList
        candidates={[candidateP1]}
        processes={processes}
        processEvidenceByProcessId={evidenceMap}
        suppressedCandidates={[]}
        serverMode={false}
        expandedEvidence="flat:p1:wristFlexionPeakAngle"
        onToggleEvidence={vi.fn()}
        renderEvidencePanel={panelStub}
        renderSkeletonReview={skeletonStub}
      />
    );
    expect(panelStub).not.toHaveBeenCalled();
    expect(screen.queryByText(/^근거:/)).toBeNull();
  });

  it('③ 서버 모드 + evidence 없음(새로고침·재진입) — "왜 이 값?" 있음, 골격 없음, 세션 안내 정확히 1회', () => {
    const { skeletonStub, panelStub } = makeStubs();
    render(
      <FlatCandidateList
        candidates={[candidateP1, candidateP2]}
        processes={processes}
        processEvidenceByProcessId={{}}
        suppressedCandidates={[]}
        serverMode
        expandedEvidence={null}
        onToggleEvidence={vi.fn()}
        renderEvidencePanel={panelStub}
        renderSkeletonReview={skeletonStub}
      />
    );
    expect(screen.getAllByRole('button', { name: '왜 이 값?' })).toHaveLength(2);
    expect(skeletonStub).toHaveBeenCalledTimes(2);
    expect(skeletonStub).toHaveBeenNthCalledWith(1, 'flat:p1:wristFlexionPeakAngle', null);
    expect(skeletonStub).toHaveBeenNthCalledWith(2, 'flat:p2:wristFlexionPeakAngle', null);
    // 정확히 1회(getByText는 0건/2건 이상이면 throw — "정확히 1회"를 그대로 강제)
    expect(screen.getByText(/골격 검수·근거는 현재 분석 세션에서만/)).toBeTruthy();
  });

  it('④ 동일 featureKey × 2공정 — 각 서브행이 자기 공정 라벨·rowKey·jobEv를 갖는다', () => {
    const { skeletonStub, panelStub } = makeStubs();
    const evidenceMap2 = {
      p1: { wristFlexionPeakAngle: { tag: 'p1-ev' } },
      p2: { wristFlexionPeakAngle: { tag: 'p2-ev' } },
    };
    render(
      <FlatCandidateList
        candidates={[candidateP1, candidateP2]}
        processes={processes}
        processEvidenceByProcessId={evidenceMap2}
        suppressedCandidates={[]}
        serverMode
        expandedEvidence={null}
        onToggleEvidence={vi.fn()}
        renderEvidencePanel={panelStub}
        renderSkeletonReview={skeletonStub}
      />
    );
    expect(screen.getByText(/조립: 약 42°/)).toBeTruthy();
    expect(screen.getByText(/포장: 약 38°/)).toBeTruthy();
    expect(skeletonStub).toHaveBeenCalledWith('flat:p1:wristFlexionPeakAngle', { tag: 'p1-ev' });
    expect(skeletonStub).toHaveBeenCalledWith('flat:p2:wristFlexionPeakAngle', { tag: 'p2-ev' });
  });

  it('⑤a expandedEvidence=null + 클릭 → onToggleEvidence가 그 rowKey로 호출된다', async () => {
    const { skeletonStub, panelStub } = makeStubs();
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(
      <FlatCandidateList
        candidates={[candidateP1]}
        processes={processes}
        processEvidenceByProcessId={evidenceMap}
        suppressedCandidates={[]}
        serverMode
        expandedEvidence={null}
        onToggleEvidence={onToggle}
        renderEvidencePanel={panelStub}
        renderSkeletonReview={skeletonStub}
      />
    );
    await user.click(screen.getByRole('button', { name: '왜 이 값?' }));
    expect(onToggle).toHaveBeenCalledWith('flat:p1:wristFlexionPeakAngle');
  });

  it('⑤b expandedEvidence가 이미 그 rowKey — 라벨이 "근거 닫기", 클릭 시 onToggleEvidence(null)', async () => {
    const { skeletonStub, panelStub } = makeStubs();
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(
      <FlatCandidateList
        candidates={[candidateP1]}
        processes={processes}
        processEvidenceByProcessId={evidenceMap}
        suppressedCandidates={[]}
        serverMode
        expandedEvidence="flat:p1:wristFlexionPeakAngle"
        onToggleEvidence={onToggle}
        renderEvidencePanel={panelStub}
        renderSkeletonReview={skeletonStub}
      />
    );
    const btn = screen.getByRole('button', { name: '근거 닫기' });
    await user.click(btn);
    expect(onToggle).toHaveBeenCalledWith(null);
  });

  it('⑥ expandedEvidence가 해당 rowKey(서버) — panelStub이 (jobEv, unit)으로 호출되고 패널이 렌더된다', () => {
    const { skeletonStub, panelStub } = makeStubs();
    render(
      <FlatCandidateList
        candidates={[candidateP1]}
        processes={processes}
        processEvidenceByProcessId={evidenceMap}
        suppressedCandidates={[]}
        serverMode
        expandedEvidence="flat:p1:wristFlexionPeakAngle"
        onToggleEvidence={vi.fn()}
        renderEvidencePanel={panelStub}
        renderSkeletonReview={skeletonStub}
      />
    );
    expect(panelStub).toHaveBeenCalledWith(FAKE_JOB_EV, 'degrees');
    expect(screen.getByText('근거:degrees')).toBeTruthy();
  });

  it('⑥b Left/Right 반복시간 후보(raw ratio) — 근거 패널엔 candidateHoursPerDay로 보정된 perDayValue를 넘기고, 골격 검수엔 원본 jobEv를 그대로 넘긴다', () => {
    const { skeletonStub, panelStub } = makeStubs();
    // 비율 0.2, 활동시간 200분/일 → 서브행 표시는 약 0.7 시간/일(candidateHoursPerDay). buildProcessEvidence가
    // 실제로 만드는 jobEv.contributions[].perDayValue는 candidate value(raw ratio 0.2) 그대로다 —
    // 그걸 그대로 근거 패널에 넘기면 "0.2 시간/일 = 자세비율 0.2 × 활동 200분/일 ÷ 60"로 오표시된다.
    const bandProcesses = [{ id: 'p1', name: '조립', activeMinutesPerDay: 200 }];
    const bandCandidate = {
      featureKey: 'repetitiveMediumHoursLeft', value: 0.2,
      reason: '어깨 반복(중간속도, 좌측) 관찰 비율(참고용)', processIds: ['p1'], clipIds: [],
    };
    const rawJobEv = {
      contributions: [{
        processName: '조립', sharePercent: 100, perDayValue: 0.2, // buildProcessEvidence 산출물 그대로(raw ratio)
        evidence: { intrinsicMetric: 'posture_ratio', intrinsicValue: 0.2, activeMinutesPerDay: 200 },
      }],
    };
    const bandEvidenceMap = { p1: { repetitiveMediumHoursLeft: rawJobEv } };
    render(
      <FlatCandidateList
        candidates={[bandCandidate]}
        processes={bandProcesses}
        processEvidenceByProcessId={bandEvidenceMap}
        suppressedCandidates={[]}
        serverMode
        expandedEvidence="flat:p1:repetitiveMediumHoursLeft"
        onToggleEvidence={vi.fn()}
        renderEvidencePanel={panelStub}
        renderSkeletonReview={skeletonStub}
      />
    );
    // 서브행(formatCandidateSubValue)은 원래도 정상 환산이었음 — 회귀 아님, 대조군으로 유지.
    expect(screen.getByText(/조립: 약 0.7 시간\/일/)).toBeTruthy();
    // 근거 패널: perDayValue가 0.2(raw)가 아니라 0.7(환산 완료)로 보정돼 전달돼야 한다.
    expect(panelStub).toHaveBeenCalledTimes(1);
    const [passedJobEv, passedUnit] = panelStub.mock.calls[0];
    expect(passedUnit).toBe('hours_per_day');
    expect(passedJobEv.contributions[0].perDayValue).toBe(0.7);
    expect(passedJobEv.contributions[0].evidence).toBe(rawJobEv.contributions[0].evidence); // 얕은 복제 — evidence 참조 보존
    expect(passedJobEv).not.toBe(rawJobEv); // 원본 transient state는 변형하지 않음(clone)
    // 골격 검수엔 원본(미보정) jobEv가 그대로 전달된다 — segments/fusion 조회엔 perDayValue가 무관.
    expect(skeletonStub).toHaveBeenCalledWith('flat:p1:repetitiveMediumHoursLeft', rawJobEv);
  });

  it('⑦ 6.0-17 표시 회귀 — 그룹 헤더 라벨 1개 + 공정별 값 문자열이 변경 전과 동일', () => {
    const { skeletonStub, panelStub } = makeStubs();
    render(
      <FlatCandidateList
        candidates={[candidateP1, candidateP2]}
        processes={processes}
        processEvidenceByProcessId={{}}
        suppressedCandidates={[]}
        serverMode={false}
        expandedEvidence={null}
        onToggleEvidence={vi.fn()}
        renderEvidencePanel={panelStub}
        renderSkeletonReview={skeletonStub}
      />
    );
    expect(screen.getAllByText(/손목 굴곡\(최대\)/)).toHaveLength(1); // 그룹 헤더 1개(공정마다 중복 X)
    expect(screen.getByText(/조립: 약 42°/)).toBeTruthy();
    expect(screen.getByText(/포장: 약 38°/)).toBeTruthy();
  });

  it('후보·suppressed 모두 없으면 아무것도 렌더하지 않는다', () => {
    const { skeletonStub, panelStub } = makeStubs();
    const { container } = render(
      <FlatCandidateList
        candidates={[]}
        processes={processes}
        processEvidenceByProcessId={{}}
        suppressedCandidates={[]}
        serverMode
        expandedEvidence={null}
        onToggleEvidence={vi.fn()}
        renderEvidencePanel={panelStub}
        renderSkeletonReview={skeletonStub}
      />
    );
    expect(container.textContent).toBe('');
  });

  it('시점 하드 게이트 안내(suppressedCandidates) — 후보 0건이어도 안내 문구는 노출', () => {
    const { skeletonStub, panelStub } = makeStubs();
    render(
      <FlatCandidateList
        candidates={[]}
        processes={processes}
        processEvidenceByProcessId={{}}
        suppressedCandidates={[{ featureKey: 'wristDeviationPeakAngle', reason: 'NON_PREFERRED_VIEWPOINT', preferred: 'frontal' }]}
        serverMode
        expandedEvidence={null}
        onToggleEvidence={vi.fn()}
        renderEvidencePanel={panelStub}
        renderSkeletonReview={skeletonStub}
      />
    );
    expect(screen.getByText(/해당 시점 클립이 없어 일부 후보는 숨겨졌습니다/)).toBeTruthy();
  });
});
