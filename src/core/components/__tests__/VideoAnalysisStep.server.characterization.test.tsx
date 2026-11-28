// @vitest-environment jsdom
//
// 영상 분석 화면 특성화 ②(P2-75a, Phase 2 C9 구간 D) — **서버 경로**. 영상 서비스 모듈의 서버 호출 함수만 vi.mock으로 바꿔
// (영상 분석 클라이언트는 실제 모듈 위에 덮어써 공용 상수·판정 함수는 진짜 그대로, 분석 실행·서버 적용은 함수 하나씩)
// 상태별 화면 — 업로드 중·뒤·실패 · 탐지 중·뒤 · 대상자 선택 · 분석 중·뒤·실패 · 근거 · 골격 검수 열림·로딩·자료 없음·종료 실패·종료 ·
// 서버 적용 중·뒤·실패 · 원본 분석 정보 없음 · 미동기 환자(적용 막힘) · 시험 모드(파일명 탐지) — 에 도달시켜 DOM을 얼린다.
// 단계마다 그 사이에 화면이 부른 서비스 함수와 인자(세션·설정·환자는 표식으로), 콜백, 환자 상태에서 바뀐 부분을 적는다.
// 흐름의 옳고 그름은 판정하지 않고 **지금 화면만** 적는다. vi.mock 경로는 확장자 없이 적는다(서비스가 .ts가 된 뒤에도 듣게).
//
// 픽스처는 합성 이름·ID만 쓴다(주소는 .test).
// 규칙(의도한 출력 변경에서만 갱신, 리팩터링에서는 갱신 금지): src/core/fixtures/goldenEnv.js
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { act, cleanup, fireEvent } from '@testing-library/react';
import '../../../modules/index';
import { useGoldenEnvironment } from '../../fixtures/goldenEnv';
import { buttonByText, deferred, flush, goldenJson } from '../../../testing/adminConsoleHarness';
import {
  processCard, renderVideoStep, suggestCard,
} from '../../../testing/videoStepHarness';
import type { VideoPatient } from '../../../testing/videoStepHarness';
import { generateMockFeatures } from '../../services/videoMock';
import {
  closeReview, createClip, fetchOverlay, fetchSampleFrame, sampleDetectClip, selectTarget, uploadClip,
} from '../../services/videoAnalysisClient';
import { runServerAnalysis } from '../../services/videoAnalysisRun';
import { applyVideoFeatureViaServer } from '../../services/videoServerApply';
import { requestedFeaturesForModules } from '../VideoAnalysisStep';

vi.mock('../../services/videoAnalysisClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/videoAnalysisClient')>();
  return {
    ...actual,
    createClip: vi.fn(),
    uploadClip: vi.fn(),
    sampleDetectClip: vi.fn(),
    selectTarget: vi.fn(),
    fetchSampleFrame: vi.fn(),
    fetchOverlay: vi.fn(),
    fetchOverlayFrame: vi.fn(),
    closeReview: vi.fn(),
  };
});
vi.mock('../../services/videoAnalysisRun', () => ({ runServerAnalysis: vi.fn() }));
vi.mock('../../services/videoServerApply', () => ({ applyVideoFeatureViaServer: vi.fn() }));

const mocked = (fn: unknown) => fn as Mock<unknown[], unknown>;

const SESSION = { mode: 'intranet', apiBaseUrl: 'https://video.synthetic.test', user: { id: 'user-0001', name: '합성 의사' } };
const SETTINGS = { integrationMode: 'intranet' };
const ALL_MODULES = ['knee', 'shoulder', 'spine', 'cervical', 'elbow', 'wrist'];

const JOBS = [
  { id: 'job-a', jobName: '합성 조립원' },
  { id: 'job-b', jobName: '합성 운반원' },
];

let log: unknown[] = [];
let revoked: string[] = [];
let currentPatientId = '';
const originalRevoke = URL.revokeObjectURL;

/** 서비스 함수 인자를 골든에 적을 모양으로 — 세션·설정·환자는 표식, 함수는 이름만, 파일은 이름만. */
function sanitize(value: unknown): unknown {
  if (value === SESSION) return '<session>';
  if (value === SETTINGS) return '<settings>';
  if (typeof value === 'function') return '<function>';
  if (typeof File !== 'undefined' && value instanceof File) return `<File ${value.name}>`;
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.id === 'string' && obj.id === currentPatientId && 'data' in obj) return `<patient ${obj.id}>`;
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, sanitize(v)]));
  }
  return value;
}

function recordCalls() {
  const pairs: Array<[string, unknown]> = [
    ['createClip', createClip], ['uploadClip', uploadClip], ['sampleDetectClip', sampleDetectClip],
    ['selectTarget', selectTarget], ['fetchSampleFrame', fetchSampleFrame], ['fetchOverlay', fetchOverlay],
    ['closeReview', closeReview], ['runServerAnalysis', runServerAnalysis], ['applyVideoFeatureViaServer', applyVideoFeatureViaServer],
  ];
  for (const [name, fn] of pairs) {
    mocked(fn).mockImplementation((...args: unknown[]) => {
      log.push({ fn: name, args: sanitize(args) });
      const next = queue.get(name)?.shift();
      if (!next) throw new Error(`no response queued for ${name}`);
      return next(args);
    });
  }
}

const queue = new Map<string, Array<(args: unknown[]) => unknown>>();
function respond(name: string, fn: (args: unknown[]) => unknown) {
  const list = queue.get(name) || [];
  list.push(fn);
  queue.set(name, list);
}

function takeLog(): unknown[] {
  const out = log;
  log = [];
  return out;
}

function failure(message: string | null, data?: unknown): Error {
  const err = new Error(message || '') as Error & { data?: unknown };
  if (!message) err.message = '';
  if (data !== undefined) err.data = data;
  return err;
}

beforeEach(() => {
  useGoldenEnvironment();
  log = [];
  revoked = [];
  queue.clear();
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true, writable: true, value: (url: string) => { revoked.push(url); },
  });
  recordCalls();
});

afterEach(() => {
  cleanup();
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: originalRevoke });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function change(el: Element, value: string) {
  act(() => { fireEvent.change(el, { target: { value } }); });
}

function click(el: Element) {
  act(() => { fireEvent.click(el); });
}

function patientWith(videoAnalysis: unknown, { synced = true } = {}): VideoPatient {
  currentPatientId = 'pt-server-1';
  return {
    id: 'pt-server-1',
    ...(synced ? { sync: { serverId: 'srv-0001', syncStatus: 'synced' } } : { sync: { syncStatus: 'dirty' } }),
    data: {
      shared: { jobs: JOBS, doctorName: '합성 의사', videoAnalysis },
      modules: {
        spine: {
          tasks: [
            { id: 'sp-1', sharedJobId: 'job-a', name: '합성 들기' },
            { id: 'sp-u', name: '합성 미연결 작업' },
          ],
        },
        cervical: { tasks: [{ id: 'cv-1', sharedJobId: 'job-a', name: '합성 목 작업' }] },
      },
    },
  };
}

const PROCESSES = [
  { id: 'proc-1', sharedJobId: 'job-a', name: '합성 공정 가', shiftSharePercent: 100, activeMinutesPerDay: 240, analysisProfile: 'repetition-upper-limb' },
  { id: 'proc-2', sharedJobId: 'job-b', name: '합성 공정 나', shiftSharePercent: 100, activeMinutesPerDay: null, analysisProfile: 'posture-basic' },
];
const CLIPS = [
  { id: 'clip-1', processId: 'proc-1', viewpoint: 'sagittal', analysisProfile: 'posture-basic' },
  { id: 'clip-2', processId: 'proc-1', viewpoint: 'frontal', analysisProfile: 'posture-basic' },
  { id: 'clip-3', processId: 'proc-2', viewpoint: 'sagittal', analysisProfile: 'posture-basic' },
];
const EMPTY_VA = { processes: PROCESSES, clips: CLIPS, processFeatures: [], jobFeatures: [], candidateFeatures: [], appliedInputs: [] };

function fusionEvidence(extra: Record<string, unknown> = {}) {
  return {
    intrinsicMetric: 'posture_ratio',
    intrinsicValue: 0.25,
    intrinsicUnit: 'ratio',
    activeMinutesPerDay: 240,
    confidenceBreakdown: { keypoint: 0.91, visibility: 0.8, tracking: null, viewpoint: 0.7 },
    fusion: {
      adopted: { viewpoint: 'sagittal', jobId: 'aj-1' },
      candidates: [
        { jobId: 'aj-1', viewpoint: 'sagittal', adopted: true },
        { jobId: 'aj-2', viewpoint: 'frontal', adopted: false },
      ],
    },
    segments: [{ startMs: 0, endMs: 400 }],
    warnings: ['합성 경고'],
    ...extra,
  };
}

function withoutKeys(map: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(map).filter(([k]) => !keys.includes(k)));
}

/** 서버 분석 결과(합성) — 공정 1은 원본 job 둘과 근거, 공정 2는 원본 job 정보 없음. */
function serverResult() {
  const requested = requestedFeaturesForModules(ALL_MODULES);
  return {
    processFeatures: [
      { processId: 'proc-1', jobId: 'aj-1', analysisJobIds: ['aj-1', 'aj-2'], features: generateMockFeatures(requested, 'repetition-upper-limb') },
      // 공정 2는 척추 자동 제안 없이 관찰값만 — 작업 단위의 "관찰값" 머리 줄.
      { processId: 'proc-2', features: withoutKeys(generateMockFeatures(requested, 'posture-basic') as Record<string, unknown>, ['cyclesPerDay', 'cycleSeconds']) },
    ],
    processEvidence: [
      {
        processId: 'proc-1',
        analysisJobIds: ['aj-1', 'aj-2'],
        evidenceByFeatureKey: {
          squatDuration: fusionEvidence(),
          cyclesPerDay: { intrinsicMetric: 'cycle_count', intrinsicValue: 300, analysisJobIds: ['aj-1'] },
          trunkFlexionOver45Duration: fusionEvidence({ intrinsicValue: 0.32 }),
          shoulderRepetitionRate: { intrinsicMetric: 'cycles_per_minute', intrinsicValue: 14 },
          repetitiveMediumHoursLeft: fusionEvidence({ intrinsicValue: 0.12, segments: [] }),
        },
        suppressedCandidates: [{ featureKey: 'wristDeviationPeakAngle', reason: 'viewpoint' }],
        inferenceDevice: { used: 'cpu', fallback: true, reason: '합성 폴백 사유' },
      },
      { processId: 'proc-2', analysisJobIds: [], evidenceByFeatureKey: {}, inferenceDevice: { used: 'cuda' } },
    ],
    missingActiveTime: { 'proc-2': ['squatDuration'], 'proc-1': [] },
    bundleVersion: 'bundle-synthetic-1',
    recipesByJobId: { 'aj-1': { synthetic: 'recipe-1' } },
    errors: [{ processId: 'proc-2', message: '합성 공정 나: 합성 부분 실패' }],
  };
}

function overlayPayload(jobId: string) {
  const keypoints = Array.from({ length: 17 }, (_, i) => [100 + i * 10, 80 + i * 12, 0.9]);
  return {
    jobId,
    framesAvailable: false,
    targetTrackId: 1,
    keypoints: {
      frameWidth: 640, frameHeight: 480, coordinateSpace: 'pixel',
      frames: [
        { frameIndex: 0, timestampMs: 0, persons: [{ trackId: 1, keypoints }, { trackId: 2, keypoints }] },
        { frameIndex: 5, timestampMs: 500, persons: [{ trackId: 2, keypoints }] },
      ],
    },
  };
}

function fileInput(root: ParentNode, processIndex: number, clipIndex: number): HTMLInputElement {
  const row = processCard(root, processIndex).querySelectorAll('.va-clip-row')[clipIndex];
  const input = row?.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error(`file input not found: ${processIndex}/${clipIndex}`);
  return input;
}

function chooseFile(input: HTMLInputElement, name: string) {
  const file = new File(['synthetic'], name, { type: 'video/mp4' });
  act(() => { fireEvent.change(input, { target: { files: [file] } }); });
}

describe('VideoAnalysisStep 특성화 — 서버 경로', () => {
  it('업로드 · 탐지 · 대상자 선택 · 분석 · 근거 · 골격 검수 · 서버 적용 · 실패', async () => {
    const h = renderVideoStep({ patient: patientWith(EMPTY_VA), activeModules: ALL_MODULES, session: SESSION, settings: SETTINGS });
    const root = h.view.container;
    const snap = (step: string) => h.snap(step, [...takeLog(), ...(revoked.length ? [{ revoked: revoked.splice(0) }] : [])]);
    snap('처음(서버 모드 · 동기화된 환자)');

    // ── 업로드 ──
    const upload = deferred();
    respond('createClip', () => Promise.resolve({ clipId: 'srv-clip-1' }));
    respond('uploadClip', (args) => {
      const opts = args[2] as { onProgress: (p: { loaded: number; total: number }) => void };
      opts.onProgress({ loaded: 50, total: 100 });
      return upload.promise;
    });
    chooseFile(fileInput(root, 0, 0), 'synthetic-clip-1.mp4');
    await flush();
    snap('업로드 중(50%)');
    upload.release();
    await flush();
    snap('업로드 완료');

    respond('createClip', () => Promise.reject(failure('합성 업로드 오류')));
    chooseFile(fileInput(root, 1, 0), 'synthetic-clip-3.mp4');
    await flush();
    snap('업로드 실패(다른 클립)');

    respond('createClip', () => Promise.resolve({ clipId: 'srv-clip-2' }));
    respond('uploadClip', () => Promise.reject(failure(null)));
    chooseFile(fileInput(root, 0, 1), 'synthetic-clip-2.mp4');
    await flush();
    snap('업로드 실패(문구 없는 오류)');

    // ── 탐지 · 대상자 선택 ──
    const detect = deferred();
    respond('sampleDetectClip', () => detect.promise.then(() => ({
      frameWidth: 640, frameHeight: 480,
      persons: [{ id: 'P1', bbox: [10, 20, 100, 200] }, { id: 'P2', bbox: [300, 40, 120, 220] }],
    })));
    respond('fetchSampleFrame', () => Promise.resolve('blob:synthetic-frame-1'));
    click(buttonByText(processCard(root, 0), '대상자 탐지'));
    await flush();
    snap('탐지 중');
    detect.release();
    await flush();
    snap('탐지 뒤(후보 2명 · 썸네일)');

    respond('selectTarget', () => Promise.reject(failure('합성 선택 오류')));
    const boxes = () => Array.from(processCard(root, 0).querySelectorAll('svg g'));
    click(boxes()[0]);
    await flush();
    snap('대상자 선택 실패');
    respond('selectTarget', () => Promise.resolve({ ok: true }));
    click(boxes()[1]);
    await flush();
    snap('대상자 선택(P2)');

    respond('sampleDetectClip', () => Promise.resolve({ frameWidth: 640, frameHeight: 480, persons: [{ id: 'P1', bbox: [10, 20, 100, 200] }] }));
    respond('fetchSampleFrame', () => Promise.resolve('blob:synthetic-frame-2'));
    click(buttonByText(processCard(root, 0), '재탐지'));
    await flush();
    snap('재탐지(이전 썸네일 해제 · 선택 비움)');
    respond('selectTarget', () => Promise.resolve({ ok: true }));
    click(boxes()[0]);
    await flush();
    snap('대상자 다시 선택(P1)');

    // ── 분석 ──
    const run = deferred();
    respond('runServerAnalysis', () => run.promise.then(() => serverResult()));
    click(buttonByText(root, '영상 분석 실행'));
    await flush();
    snap('분석 중');
    run.release();
    await flush();
    snap('분석 뒤(부분 실패 · 활동시간 누락 · 디바이스 표시)');

    // ── 근거 ──
    click(buttonByText(suggestCard(root, 'squatDuration'), '왜 이 값?'));
    snap('직업 단위 근거 펼침(squatDuration)');
    click(buttonByText(suggestCard(root, 'trunkFlexionOver45Duration'), '왜 이 값?'));
    snap('작업 단위 후보 근거 펼침(trunkFlexionOver45Duration)');
    click(buttonByText(suggestCard(root, 'cyclesPerDay'), '왜 이 값?'));
    snap('작업 단위 제안 근거 펼침(cyclesPerDay · 융합 정보 없음)');
    const flatButtons = () => Array.from(root.querySelectorAll<HTMLButtonElement>('.va-subrow-btn'));
    click(flatButtons()[0]);
    snap('flat 후보 서브행 근거 펼침(첫 번째)');
    const ratioRow = flatButtons().find((b) => (b.closest('li.va-suggest-card')?.textContent || '').includes('중간속도, 좌측'));
    if (!ratioRow) throw new Error('ratio flat row not found');
    click(ratioRow);
    snap('flat 후보 서브행 근거 펼침(좌측 중간속도 — 시간 환산 보정)');

    // ── 골격 검수 ──
    const squatCard = () => suggestCard(root, 'squatDuration');
    const overlay = deferred();
    respond('fetchOverlay', () => overlay.promise.then(() => overlayPayload('aj-1')));
    click(buttonByText(squatCard(), '골격 검수: 합성 공정 가 측면 (채택)'));
    await flush();
    snap('골격 불러오는 중');
    overlay.release();
    await flush();
    snap('골격 검수 열림(aj-1)');
    change(squatCard().querySelector('input[type="range"]') as Element, '1');
    snap('골격 프레임 이동(대상자 없음 프레임)');

    respond('fetchOverlay', () => Promise.resolve(null));
    click(buttonByText(squatCard(), '골격 검수: 합성 공정 가 정면 (비교 시점)'));
    await flush();
    snap('비교 시점 골격 — 자료 없음');

    click(buttonByText(squatCard(), '골격 검수: 합성 공정 가 측면 (채택)'));
    await flush();
    snap('채택 골격 다시 열기(캐시 — 요청 없음)');

    respond('closeReview', () => Promise.reject(failure('x', { code: 'JOB_NOT_READY' })));
    click(buttonByText(squatCard(), '이 분석 검수 종료(자료 회수)'));
    await flush();
    snap('검수 종료 실패(분석 진행 중)');
    respond('closeReview', () => Promise.reject(failure('x', { error: { code: 'OTHER' } })));
    click(buttonByText(squatCard(), '이 분석 검수 종료(자료 회수)'));
    await flush();
    snap('검수 종료 실패(그 밖)');
    respond('closeReview', () => Promise.resolve({ ok: true }));
    click(buttonByText(squatCard(), '이 분석 검수 종료(자료 회수)'));
    await flush();
    snap('검수 종료(회수됨 · 패널 닫힘)');

    respond('fetchOverlay', () => Promise.reject(failure(null)));
    click(buttonByText(suggestCard(root, 'trunkFlexionOver45Duration'), '골격 검수: 합성 공정 가 정면 (비교 시점)'));
    await flush();
    snap('다른 행에서 비교 시점 골격 다시 요청 — 실패(문구 없는 오류)');

    // ── 서버 적용 ──
    const apply = deferred();
    respond('applyVideoFeatureViaServer', () => apply.promise.then(() => ({ id: 'pt-server-1', marker: 'server-patient-1' })));
    change(squatCard().querySelector('.va-note-input') as Element, '합성 서버 메모');
    click(buttonByText(squatCard(), '적용'));
    await flush();
    snap('서버 적용 중');
    apply.release();
    await flush();
    snap('서버 적용 뒤');

    respond('applyVideoFeatureViaServer', () => Promise.reject(failure('합성 적용 오류')));
    click(buttonByText(suggestCard(root, 'overheadHours'), '적용'));
    await flush();
    snap('서버 적용 실패');

    click(buttonByText(suggestCard(root, 'squatDuration', 1), '적용'));
    await flush();
    snap('원본 분석 정보 없는 직업의 적용(막힘 — 공정 2만 있는 직력)');

    // ── 분석 실패 · 클립 삭제 ──
    respond('runServerAnalysis', () => Promise.reject(failure('합성 분석 실패')));
    click(buttonByText(root, '영상 분석 실행'));
    await flush();
    snap('분석 실패');

    click(buttonByText(processCard(root, 0), '×', 0));
    await flush();
    snap('탐지한 클립 삭제');

    cleanup();
    snap('언마운트(남은 썸네일 해제)');

    await expect(goldenJson(h.steps)).toMatchFileSnapshot('./__goldens__/video-server-flow.json');
  });

  it('미동기 환자 · 시험 모드 · 탐지 실패', async () => {
    const out: Record<string, unknown> = {};

    // ① 인트라넷인데 동기화 안 된 환자 — 적용 막힘(분석은 예시 경로로).
    {
      const h = renderVideoStep({ patient: patientWith(EMPTY_VA, { synced: false }), activeModules: ['knee', 'spine'], session: SESSION, settings: SETTINGS, fixtureMode: true });
      const root = h.view.container;
      h.snap('미동기 환자(시험 모드)', takeLog());
      click(buttonByText(root, '예시 분석 실행'));
      h.snap('미동기 환자 — 예시 분석', takeLog());
      click(buttonByText(suggestCard(root, 'squatDuration'), '적용'));
      await flush();
      // 적용 버튼이 잠겨 있어(disabled) 누름이 닿지 않는다 — 막힘 문구('서버에 저장·동기화된 환자만…')는 이 화면에서 도달하지 않는다.
      h.snap('미동기 환자 — 적용 누름(버튼 잠김 · 변화 없음)', takeLog());
      cleanup();
      out.unsynced = h.steps;
    }

    // ② 시험 모드 + 동기화 — 시험용 파일명으로 탐지(새 clip 생성), 파일명을 바꾸면 탐지 결과가 무효.
    {
      const h = renderVideoStep({ patient: patientWith(EMPTY_VA), activeModules: ['knee'], session: SESSION, settings: SETTINGS, fixtureMode: true });
      const root = h.view.container;
      h.snap('시험 모드(파일명 칸)', takeLog());
      const nameInput = () => processCard(root, 0).querySelector<HTMLInputElement>('input[placeholder="시험용 영상 파일명"]') as HTMLInputElement;
      change(nameInput(), 'synthetic_fixture_a.mp4');
      h.snap('시험용 파일명 입력', takeLog());
      respond('createClip', () => Promise.resolve({ clipId: 'srv-fixture-1' }));
      respond('sampleDetectClip', () => Promise.resolve({ frameWidth: 320, frameHeight: 0, persons: [] }));
      respond('fetchSampleFrame', () => Promise.reject(failure('썸네일 없음')));
      click(buttonByText(processCard(root, 0), '대상자 탐지'));
      await flush();
      h.snap('시험 클립 탐지(사람 없음 · 썸네일 실패)', takeLog());
      change(nameInput(), 'synthetic_fixture_b.mp4');
      h.snap('파일명 변경(탐지 결과 무효)', takeLog());
      respond('createClip', () => Promise.reject(failure(null)));
      click(buttonByText(processCard(root, 0), '대상자 탐지'));
      await flush();
      h.snap('탐지 실패(문구 없는 오류)', takeLog());
      respond('runServerAnalysis', () => Promise.resolve({
        processFeatures: [], processEvidence: [], missingActiveTime: {}, bundleVersion: null, recipesByJobId: null, errors: [],
      }));
      click(buttonByText(root, '영상 분석 실행'));
      await flush();
      h.snap('분석 결과 비어 있음', takeLog());
      cleanup();
      out.fixture = h.steps;
    }

    await expect(goldenJson(out)).toMatchFileSnapshot('./__goldens__/video-server-variants.json');
  });
});
