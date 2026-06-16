import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../httpClient', () => ({ requestJson: vi.fn() }));

import { requestJson } from '../httpClient';
import {
  createClip,
  createJob,
  getJob,
  pollJob,
  isVideoAnalysisSupported,
} from '../videoAnalysisClient.js';
import { applyVideoAnalysisJob } from '../patientServerRepository.js';

const intranet = { session: { mode: 'intranet', apiBaseUrl: 'https://srv' }, settings: {} };
const syncedPatient = { id: 'local-1', sync: { serverId: 'srv-9', revision: 2, syncStatus: 'synced' } };

beforeEach(() => { vi.clearAllMocks(); });

describe('videoAnalysisClient — platform gating', () => {
  it('reports support only for intranet', () => {
    expect(isVideoAnalysisSupported({ mode: 'intranet' })).toBe(true);
    expect(isVideoAnalysisSupported({ mode: 'standalone' })).toBe(false);
    expect(isVideoAnalysisSupported(undefined)).toBe(false);
  });

  it('rejects calls outside intranet mode (stub)', async () => {
    await expect(createClip(syncedPatient, { session: { mode: 'standalone' } }))
      .rejects.toMatchObject({ code: 'VIDEO_UNSUPPORTED_MODE' });
    expect(requestJson).not.toHaveBeenCalled();
  });

  it('createClip sends the server patient id (sync.serverId), not the local id', async () => {
    requestJson.mockResolvedValueOnce({ clipId: 'c1' });
    const res = await createClip(syncedPatient, intranet);
    expect(res.clipId).toBe('c1');
    expect(requestJson).toHaveBeenCalledWith('/api/video-analysis/clips', expect.objectContaining({
      method: 'POST', body: { patientId: 'srv-9', processId: null }, baseUrl: 'https://srv',
    }));
  });

  it('createClip forwards processId for per-process analysis jobs', async () => {
    requestJson.mockResolvedValueOnce({ clipId: 'c2' });
    await createClip(syncedPatient, { ...intranet, processId: 'pr-7' });
    expect(requestJson).toHaveBeenCalledWith('/api/video-analysis/clips', expect.objectContaining({
      body: { patientId: 'srv-9', processId: 'pr-7' },
    }));
  });

  it.each([
    ['dirty', { serverId: 'srv-9', revision: 2, syncStatus: 'dirty' }],
    ['conflict', { serverId: 'srv-9', revision: 2, syncStatus: 'conflict' }],
    ['local-only (no serverId)', { serverId: null, syncStatus: 'local-only' }],
  ])('createClip blocks non-synced patient: %s', async (_label, sync) => {
    await expect(createClip({ id: 'l', sync }, intranet))
      .rejects.toMatchObject({ code: 'PATIENT_NOT_SYNCED' });
    expect(requestJson).not.toHaveBeenCalled();
  });

  it('createJob posts the job request contract', async () => {
    requestJson.mockResolvedValueOnce({ jobId: 'j1', status: 'review_pending' });
    await createJob({ clipId: 'c1', processId: 'pr1', analysisProfile: 'posture-basic', requestedFeatures: ['overheadHours'] }, intranet);
    expect(requestJson).toHaveBeenCalledWith('/api/video-analysis/jobs', expect.objectContaining({
      method: 'POST',
      body: { clipId: 'c1', processId: 'pr1', analysisProfile: 'posture-basic', requestedFeatures: ['overheadHours'] },
    }));
  });

  it('getJob fetches by id', async () => {
    requestJson.mockResolvedValueOnce({ jobId: 'j1', status: 'review_pending' });
    await getJob('j1', intranet);
    expect(requestJson).toHaveBeenCalledWith('/api/video-analysis/jobs/j1', expect.objectContaining({ baseUrl: 'https://srv' }));
  });

  it('pollJob loops getJob until a terminal status (queued→processing→review_pending)', async () => {
    requestJson
      .mockResolvedValueOnce({ jobId: 'j1', status: 'queued' })
      .mockResolvedValueOnce({ jobId: 'j1', status: 'processing' })
      .mockResolvedValueOnce({ jobId: 'j1', status: 'review_pending', resultFeatures: { features: {} } });
    const out = await pollJob('j1', intranet, { intervalMs: 0, maxAttempts: 10 });
    expect(out.status).toBe('review_pending');
    expect(requestJson).toHaveBeenCalledTimes(3);
  });

  it('pollJob stops on error status', async () => {
    requestJson.mockResolvedValueOnce({ jobId: 'j1', status: 'error', errorCode: 'INFERENCE_ERROR' });
    const out = await pollJob('j1', intranet, { intervalMs: 0, maxAttempts: 5 });
    expect(out.status).toBe('error');
    expect(requestJson).toHaveBeenCalledTimes(1);
  });
});

describe('applyVideoAnalysisJob', () => {
  const patient = { id: 'local-1', meta: { source: 'x' }, sync: { serverId: 'srv-1', revision: 3, syncStatus: 'synced' } };
  const computedData = { shared: { name: 'Kim' }, modules: {}, activeModules: [] };

  it.each([
    ['dirty', { serverId: 'srv-1', revision: 3, syncStatus: 'dirty' }],
    ['conflict', { serverId: 'srv-1', revision: 3, syncStatus: 'conflict' }],
    ['local-only', { serverId: null, syncStatus: 'local-only' }],
  ])('blocks non-synced patient: %s', async (_label, sync) => {
    await expect(applyVideoAnalysisJob('j1', { id: 'l', sync }, computedData, intranet))
      .rejects.toMatchObject({ code: 'PATIENT_NOT_SYNCED' });
    expect(requestJson).not.toHaveBeenCalled();
  });

  it('sends If-Match revision + body, maps response.patient preserving local id', async () => {
    requestJson.mockResolvedValueOnce({
      patient: { id: 'srv-1', sync: { serverId: 'srv-1', revision: 4, syncStatus: 'synced' }, data: {} },
    });
    const out = await applyVideoAnalysisJob('j1', patient, computedData, {
      ...intranet, appliedInputsHash: 'h1', appliedInputsCount: 2,
    });
    expect(requestJson).toHaveBeenCalledWith('/api/video-analysis/jobs/j1/apply', expect.objectContaining({
      method: 'POST',
      headers: { 'If-Match': '3' },
      body: { data: computedData, appliedInputsHash: 'h1', appliedInputsCount: 2, sourceAnalysisJobIds: [] },
    }));
    // applyServerSync는 로컬 id/meta를 보존하고 서버 revision을 반영한다.
    expect(out.id).toBe('local-1');
    expect(out.meta).toEqual({ source: 'x' });
    expect(out.sync.revision).toBe(4);
  });
});
