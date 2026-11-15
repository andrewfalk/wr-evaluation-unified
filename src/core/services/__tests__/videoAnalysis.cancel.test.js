// 영상 분석 취소(계정 전환 수정 AS-4) — 호출한 화면이 내려가면(shouldContinue false) 폴링·분석 실행·서버 적용이 이전 세션으로
// 서버 요청을 이어 가지 않는다. shouldContinue를 주지 않으면 예전과 같다.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../httpClient', () => ({ requestJson: vi.fn(), requestBlob: vi.fn() }));

import { requestJson } from '../httpClient';
import { pollJob } from '../videoAnalysisClient.js';
import { runServerAnalysis } from '../videoAnalysisRun.js';

const intranet = { session: { mode: 'intranet', apiBaseUrl: 'https://srv' }, settings: {} };

beforeEach(() => { vi.clearAllMocks(); });

describe('pollJob — shouldContinue', () => {
  it('false가 되면 다음 조회를 보내지 않고 ANALYSIS_CANCELLED로 멈춘다', async () => {
    let alive = true;
    requestJson.mockImplementation(async () => { alive = false; return { status: 'processing' }; });
    await expect(pollJob('j1', intranet, { intervalMs: 0, shouldContinue: () => alive }))
      .rejects.toMatchObject({ code: 'ANALYSIS_CANCELLED' });
    expect(requestJson).toHaveBeenCalledTimes(1);
  });

  it('주지 않으면 예전처럼 종료 상태까지 조회한다', async () => {
    requestJson.mockResolvedValueOnce({ status: 'queued' }).mockResolvedValueOnce({ status: 'review_pending', jobId: 'j1' });
    await expect(pollJob('j1', intranet, { intervalMs: 0 })).resolves.toMatchObject({ status: 'review_pending' });
    expect(requestJson).toHaveBeenCalledTimes(2);
  });
});

describe('runServerAnalysis — shouldContinue', () => {
  it('시작 전에 이미 false면 서버 요청 0건으로 멈춘다', async () => {
    const patient = { id: 'p1', sync: { serverId: 's1', revision: 1, syncStatus: 'synced' } };
    const va = { processes: [{ id: 'pr1', name: '공정', analysisProfile: 'posture-basic' }], clips: [{ id: 'c1', processId: 'pr1', fixtureClipName: 'x.mp4' }] };
    await expect(runServerAnalysis(patient, va, { ...intranet, activeModules: ['knee'], shouldContinue: () => false }))
      .rejects.toMatchObject({ code: 'ANALYSIS_CANCELLED' });
    expect(requestJson).not.toHaveBeenCalled();
  });
});
