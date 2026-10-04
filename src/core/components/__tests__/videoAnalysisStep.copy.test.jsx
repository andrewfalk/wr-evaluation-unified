// @vitest-environment jsdom
// 영상 분석 단계에 개발 용어(mock·audit·6.0-B2·fixture·provenance·M3)가 사용자 문구로 노출되지 않는지,
// 그리고 실제 분석/예시 분석의 구분이 화면에 남아 있는지 렌더로 확인한다.
// 금칙어 검사는 "제품이 제공하는 문구"(텍스트 노드 + placeholder/title/aria-label 속성)만 대상으로 한다 —
// innerHTML 전체나 사용자 입력값(value)은 검사하지 않는다.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { VideoAnalysisStep } from '../VideoAnalysisStep.jsx';
import { CANDIDATE_REASONS, displayCandidateReason } from '../../services/videoMock.js';

afterEach(cleanup);

const FORBIDDEN = /mock|audit|6\.0-|fixture|provenance|\(M3\)/i;

function productStrings(root) {
  const out = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n.nodeValue.trim();
    if (t) out.push(t);
  }
  root.querySelectorAll('[placeholder],[title],[aria-label]').forEach((el) => {
    for (const attr of ['placeholder', 'title', 'aria-label']) {
      const v = el.getAttribute(attr);
      if (v) out.push(v);
    }
  });
  return out;
}

function baseShared(overrides = {}) {
  return {
    jobs: [{ id: 'job-1', jobName: '용접공' }],
    doctorName: '김의사',
    videoAnalysis: {
      processes: [{ id: 'p1', sharedJobId: 'job-1', name: '공정 1', shiftSharePercent: 100, activeMinutesPerDay: 120, analysisProfile: 'posture-basic' }],
      clips: [{ id: 'c1', processId: 'p1', viewpoint: 'sagittal', analysisProfile: 'posture-basic', fixtureClipName: 'fixture_test.mp4' }],
      processFeatures: [], jobFeatures: [], candidateFeatures: [],
      appliedInputs: [{ targetPath: 'modules.knee.jobExtras.job-1.squatMinutes', appliedValue: 30, previousValue: 10 }],
      ...overrides,
    },
  };
}

function renderStep({ session = null, fixtureMode = false, shared = baseShared(), synced = false } = {}) {
  return render(
    <VideoAnalysisStep
      shared={shared}
      updateShared={() => {}}
      updatePatient={() => {}}
      activePatient={synced ? { id: 'pt', sync: { serverId: 'srv-1', syncStatus: 'synced' }, data: { modules: {} } } : { id: 'pt', data: { modules: {} } }}
      activeModules={['knee']}
      session={session}
      settings={{}}
      fixtureMode={fixtureMode}
    />,
  );
}

describe('VideoAnalysisStep — 사용자 문구', () => {
  it('로컬(예시) 경로: 예시 분석임을 밝히고 개발 용어를 노출하지 않는다', () => {
    const { container } = renderStep();
    expect(screen.getByRole('button', { name: '예시 분석 실행' })).toBeTruthy();
    expect(screen.getByText(/예시 데이터로 생성한 결과이며 실제 영상에서 산출한 값이 아닙니다/)).toBeTruthy();
    expect(screen.getByText(/\(예시\)/)).toBeTruthy();
    const bad = productStrings(container).filter((s) => FORBIDDEN.test(s));
    expect(bad).toEqual([]);
  });

  it('서버 경로: 영상 분석 실행 버튼이 있고 예시 안내는 없으며, 적용 이력 문구도 개발 용어가 없다', () => {
    const { container } = renderStep({ session: { mode: 'intranet', user: { name: '김의사' } }, synced: true });
    expect(screen.getByRole('button', { name: '영상 분석 실행' })).toBeTruthy();
    expect(screen.queryByText(/예시 데이터로 생성한 결과/)).toBeNull();
    expect(screen.queryByRole('button', { name: '예시 분석 실행' })).toBeNull();
    expect(screen.getByText('적용 이력')).toBeTruthy();
    expect(screen.getByText(/서버에 적용한 항목의 되돌리기는 아직 지원되지 않습니다/)).toBeTruthy();
    expect(screen.getByText(/적용 내역은 서버에 기록됩니다/)).toBeTruthy();
    const bad = productStrings(container).filter((s) => FORBIDDEN.test(s));
    expect(bad).toEqual([]);
  });

  it('시험(fixture) 모드: 제목 접미사 (시험)과 시험용 영상 파일명 placeholder가 보이고, 입력값(fixture_test.mp4)은 금칙어 검사에서 제외된다', () => {
    const { container } = renderStep({ session: { mode: 'intranet', user: { name: '김의사' } }, fixtureMode: true, synced: true });
    expect(screen.getByText(/\(시험\)/)).toBeTruthy();
    const input = container.querySelector('input[placeholder="시험용 영상 파일명"]');
    expect(input).toBeTruthy();
    expect(input.value).toBe('fixture_test.mp4'); // 사용자 입력값은 그대로 — 문구 검사 대상이 아님
    const bad = productStrings(container).filter((s) => FORBIDDEN.test(s));
    expect(bad).toEqual([]);
  });

  it('시범 운영 배너에 내부 검증 코드(6.0-B2)가 없다', () => {
    renderStep();
    const note = screen.getByRole('note');
    expect(note.textContent).toMatch(/정확도 검증 전/);
    expect(note.textContent).not.toMatch(/6\.0-/);
  });
});

describe('후보 이유 문구', () => {
  it('새 CANDIDATE_REASONS에는 개발 용어가 없다', () => {
    for (const [key, reason] of Object.entries(CANDIDATE_REASONS)) {
      expect(reason, `key=${key}`).not.toMatch(/6\.0-|mock|fixture/i);
    }
  });

  it('displayCandidateReason: 이전에 저장된 "임계 6.0-B2 미검증"을 화면에서만 새 문구로 바꾸고, 그 외 값은 그대로 둔다', () => {
    const stored = '어깨 상완거상 반복 추정(참고용) — 자동입력 금지, 임계 6.0-B2 미검증';
    expect(displayCandidateReason(stored)).toBe('어깨 상완거상 반복 추정(참고용) — 자동입력 금지, 정확도 검증 전');
    expect(displayCandidateReason('무릎 비틀림은 2D 영상에서 저신뢰 — 수기 확인 필요')).toBe('무릎 비틀림은 2D 영상에서 저신뢰 — 수기 확인 필요');
    expect(displayCandidateReason(undefined)).toBeUndefined();
    expect(displayCandidateReason(null)).toBeNull();
  });
});
