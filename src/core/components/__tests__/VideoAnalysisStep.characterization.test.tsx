// @vitest-environment jsdom
//
// 영상 분석 화면 특성화 ①(P2-75a, Phase 2 C9 구간 D) — **예시 분석 경로**(서버 모드가 아닐 때)를 모킹 없이 그려 지금 화면을 얼린다.
// 실제 모듈 등록(`modules/index`)과 실제 예시 분석(generateMockFeatures · 시점 게이트 · 집계)을 쓴다. 단계마다 화면이 부른 콜백
// (updateShared에 넘긴 videoAnalysis · updatePatient), 환자 상태에서 바뀐 부분(shared.videoAnalysis · modules), DOM·폼 상태를 적는다.
// 공정·클립 입력 → 예시 분석 → 직업 단위·작업 단위 검토 · flat 후보 · 근거 패널 펼침 · 대상 작업 선택 · 제안 적용 · 적용 이력 ·
// 되돌리기 · 입력을 바꾸면 분석 결과를 비우는 것까지. 흐름의 옳고 그름은 판정하지 않고 **지금 화면만** 적는다.
// 뒤따르는 이동·분할 PR(P2-75b-ts ~ P2-75h)의 안전망이다 — 이 구간에서는 골든을 갱신하지 않는다.
//
// 픽스처는 합성 이름·ID만 쓴다.
// 규칙(의도한 출력 변경에서만 갱신, 리팩터링에서는 갱신 금지): src/core/fixtures/goldenEnv.js
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent } from '@testing-library/react';
import '../../../modules/index';
import { useGoldenEnvironment } from '../../fixtures/goldenEnv';
import { buttonByText, goldenJson } from '../../../testing/adminConsoleHarness';
import {
  processCard, processField, renderVideoStep, suggestCard, suggestCards,
} from '../../../testing/videoStepHarness';
import type { VideoPatient } from '../../../testing/videoStepHarness';
import { generateMockFeatures } from '../../services/videoMock';
import { createVideoAnalysisData } from '../../utils/data';
import { buildJobFeatures, requestedFeaturesForModules } from '../VideoAnalysisStep';

beforeEach(() => {
  useGoldenEnvironment();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const ALL_MODULES = ['knee', 'shoulder', 'spine', 'cervical', 'elbow', 'wrist'];

const JOBS = [
  { id: 'job-a', jobName: '합성 조립원' },
  { id: 'job-b', jobName: '합성 포장원', excludeFromAnalysis: true },
];

function basePatient(videoAnalysis?: unknown): VideoPatient {
  return {
    id: 'pt-local-1',
    data: {
      shared: {
        jobs: JOBS,
        doctorName: '합성 의사',
        // 앱은 환자를 불러올 때 videoAnalysis 기본값을 항상 채운다(utils/data.js 정규화) — 같은 모양으로 넘긴다.
        videoAnalysis: videoAnalysis ?? createVideoAnalysisData(),
      },
      modules: {
        spine: {
          tasks: [
            { id: 'sp-1', sharedJobId: 'job-a', name: '합성 들기 A' },
            { id: 'sp-2', sharedJobId: 'job-a', name: '합성 들기 B' },
          ],
        },
        cervical: { tasks: [{ id: 'cv-1', sharedJobId: 'job-a', name: '합성 목 작업' }] },
      },
    },
  };
}

function change(el: Element, value: string) {
  act(() => { fireEvent.change(el, { target: { value } }); });
}

function click(el: Element) {
  act(() => { fireEvent.click(el); });
}

describe('VideoAnalysisStep 특성화 — 예시 분석 경로', () => {
  it('공정·클립 입력 → 예시 분석 → 검토 · 근거 · 대상 작업 · 적용 · 되돌리기 · 입력 변경', async () => {
    const h = renderVideoStep({ patient: basePatient(), activeModules: ALL_MODULES, session: null });
    const root = h.view.container;
    h.snap('처음(빈 영상 분석 기본값)');

    click(buttonByText(root, '+ 공정 추가'));
    h.snap('공정 추가 1');
    const p1 = processCard(root, 0);
    change(processField(p1, 'name'), '합성 공정 가');
    change(processField(p1, 'share'), '60');
    change(processField(p1, 'active'), '240');
    change(processField(p1, 'profile'), 'repetition-upper-limb');
    h.snap('공정 1 입력(이름·점유율 60·활동 240·상지반복)');

    click(buttonByText(root, '+ 공정 추가'));
    const p2 = processCard(root, 1);
    change(processField(p2, 'name'), '합성 공정 나');
    change(processField(p2, 'share'), '40');
    change(processField(p2, 'profile'), 'hand-wrist');
    h.snap('공정 2 입력(점유율 40·활동시간 빈칸·손목)');

    click(buttonByText(root, '+ 공정 추가'));
    const p3 = processCard(root, 2);
    change(processField(p3, 'job'), 'job-b');
    change(processField(p3, 'name'), '합성 공정 다');
    change(processField(p3, 'share'), '100');
    change(processField(p3, 'active'), '120');
    h.snap('공정 3 입력(미포함 직력·점유율 100)');

    click(buttonByText(processCard(root, 0), '+ 클립'));
    click(buttonByText(processCard(root, 0), '+ 클립'));
    change(processCard(root, 0).querySelectorAll('.va-clip-row select')[1], 'frontal');
    click(buttonByText(processCard(root, 1), '+ 클립'));
    change(processCard(root, 1).querySelector('.va-clip-row select') as Element, 'frontal');
    click(buttonByText(processCard(root, 2), '+ 클립'));
    h.snap('클립 추가(공정 1 측면·정면, 공정 2 정면, 공정 3 측면)');

    click(buttonByText(processCard(root, 2), '+ 클립'));
    change(processCard(root, 2).querySelectorAll('.va-clip-row select')[1], 'other');
    click(buttonByText(processCard(root, 2), '×', 1));
    h.snap('공정 3 두 번째 클립 추가 뒤 삭제');

    click(buttonByText(root, '예시 분석 실행'));
    h.snap('예시 분석 실행');

    click(buttonByText(suggestCard(root, 'squatDuration'), '왜 이 값?'));
    h.snap('직업 단위 제안 근거 펼침(squatDuration)');
    click(buttonByText(suggestCard(root, 'squatDuration'), '근거 닫기'));
    click(buttonByText(suggestCard(root, 'trunkFlexionOver45Duration'), '왜 이 값?'));
    h.snap('작업 단위 후보 근거 펼침(trunkFlexionOver45Duration)');
    click(buttonByText(suggestCard(root, 'trunkPostureG'), '왜 이 값?'));
    h.snap('다른 후보 근거로 바꿈(trunkPostureG)');

    const squat = suggestCard(root, 'squatDuration');
    change(squat.querySelector('.va-note-input') as Element, '  합성 메모  ');
    h.snap('수정 사유 입력(squatDuration)');
    click(buttonByText(squat, '적용'));
    h.snap('적용 — 무릎 squatDuration(메모 있음)');

    click(buttonByText(suggestCard(root, 'overheadHours'), '적용'));
    h.snap('적용 — 어깨 overheadHours');

    const spinePick = Array.from(root.querySelectorAll('.va-target-pick select'))[0];
    change(spinePick, 'sp-2');
    h.snap('대상 작업 선택(척추 sp-2)');
    click(buttonByText(suggestCard(root, 'cyclesPerDay'), '적용'));
    h.snap('적용 — 척추 cyclesPerDay');

    click(buttonByText(suggestCard(root, 'neckFlexionOver20HoursPerDay'), '적용'));
    h.snap('적용 — 경추 neckFlexionOver20HoursPerDay(작업 하나 → 자동 대상)');

    click(buttonByText(suggestCards(root, 'squatDuration')[0], '적용'));
    h.snap('적용 — 무릎 squatDuration 다시(이전 값이 남은 채)');

    click(buttonByText(root, '되돌리기', 0));
    h.snap('되돌리기 — 첫 번째 이력');
    click(buttonByText(root, '되돌리기', 1));
    h.snap('되돌리기 — 남은 이력의 두 번째');

    change(processField(processCard(root, 0), 'share'), '50');
    h.snap('분석 뒤 공정 점유율 변경(분석 결과 비움)');

    click(buttonByText(processCard(root, 2), '공정 삭제'));
    h.snap('공정 3 삭제');

    await expect(goldenJson(h.steps)).toMatchFileSnapshot('./__goldens__/video-example-flow.json');
  });

  it('저장된 분석 결과로 다시 열기 · 모듈 조합 · 빈 대상 작업', async () => {
    const out: Record<string, unknown> = {};

    // ① 저장된 결과(processFeatureAggregationMode 없음 — 이전 분석)로 다시 연 화면.
    const processes = [
      { id: 'proc-1', sharedJobId: 'job-a', name: '합성 공정 하나', shiftSharePercent: 70, activeMinutesPerDay: 200, analysisProfile: 'posture-basic' },
      { id: 'proc-2', sharedJobId: 'job-a', name: '합성 공정 둘', shiftSharePercent: 30, activeMinutesPerDay: null, analysisProfile: 'repetition-upper-limb' },
    ];
    const requested = requestedFeaturesForModules(['knee', 'shoulder']);
    const processFeatures = processes.map((p) => ({ processId: p.id, features: generateMockFeatures(requested, p.analysisProfile) }));
    const legacy = {
      processes,
      clips: [{ id: 'clip-1', processId: 'proc-1', viewpoint: 'sagittal', analysisProfile: 'posture-basic' }],
      processFeatures,
      // 본체가 JS든 TS든 같은 줄로 붙도록 인자 모양은 본체의 매개변수 타입으로 단언한다(예시 분석 값은 JS에서 Object로 추론된다).
      jobFeatures: buildJobFeatures(
        processes as Parameters<typeof buildJobFeatures>[0],
        processFeatures as Parameters<typeof buildJobFeatures>[1],
      ),
      candidateFeatures: [],
      appliedInputs: [],
    };
    {
      const h = renderVideoStep({ patient: basePatient(legacy), activeModules: ['knee', 'shoulder'] });
      h.snap('이전 분석(기여값 정보 없음)으로 다시 열기');
      cleanup();
      out.legacy = h.steps;
    }

    // ② 같은 결과에 집계 방식이 적힌 경우(공정별 기여값 표시).
    {
      const h = renderVideoStep({ patient: basePatient({ ...legacy, processFeatureAggregationMode: 'shareWeighted' }), activeModules: ['knee', 'shoulder'] });
      h.snap('집계 방식 shareWeighted로 다시 열기');
      cleanup();
      out.shareWeighted = h.steps;
    }

    // ③ 직업 단위 모듈 없이 척추만 — 직업에 척추 작업이 없는 환자(대상 작업 없음 → 적용 잠김).
    {
      const patient = basePatient();
      patient.data.modules = {};
      const h = renderVideoStep({ patient, activeModules: ['spine'] });
      const root = h.view.container;
      click(buttonByText(root, '+ 공정 추가'));
      change(processField(processCard(root, 0), 'active'), '300');
      click(buttonByText(processCard(root, 0), '+ 클립'));
      click(buttonByText(root, '예시 분석 실행'));
      h.snap('척추만 · 대상 작업 없음');
      cleanup();
      out.spineOnlyNoTask = h.steps;
    }

    // ④ 손목 모듈이 꺼져 있으면 손목 프로필이 목록에 없다 — 이미 손목으로 저장된 공정은 그 선택지를 남긴다.
    {
      const h = renderVideoStep({
        patient: basePatient({
          processes: [
            { id: 'proc-w', sharedJobId: 'job-a', name: '합성 손목 공정', shiftSharePercent: 100, activeMinutesPerDay: 60, analysisProfile: 'hand-wrist' },
            { id: 'proc-x', sharedJobId: 'job-a', name: '합성 일반 공정', shiftSharePercent: 0, activeMinutesPerDay: 60, analysisProfile: 'posture-basic' },
          ],
          clips: [],
          processFeatures: [], jobFeatures: [], candidateFeatures: [],
          appliedInputs: [],
        }),
        activeModules: ['knee'],
      });
      h.snap('손목 모듈 꺼짐 · 저장된 손목 프로필');
      cleanup();
      out.wristProfileFallback = h.steps;
    }

    await expect(goldenJson(out)).toMatchFileSnapshot('./__goldens__/video-example-variants.json');
  });
});
