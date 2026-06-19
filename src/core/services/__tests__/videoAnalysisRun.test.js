import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../videoAnalysisClient', () => ({
  createClip: vi.fn(),
  createJob: vi.fn(),
  pollJob: vi.fn(),
}));

import { createClip, createJob, pollJob } from '../videoAnalysisClient';
import { runServerAnalysis } from '../videoAnalysisRun.js';

const patient = { id: 'l1', sync: { serverId: 'srv-1', revision: 2, syncStatus: 'synced' } };
const env = { activeModules: ['knee'], session: { mode: 'intranet' }, settings: {} };

// squatDuration(posture_ratio) intrinsic clip feature를 담은 유효 ClipFeatureSet.
const clipSet = (ratio = 0.5) => ({
  schemaVersion: 1, featureConfigVersion: 'fc-1', clipRef: 'c.mp4', clipDurationMs: 1000, analyzedFrames: 10,
  features: { squatDuration: { kind: 'numeric', metric: 'posture_ratio', value: ratio, unit: 'ratio', confidence: 0.8, segments: [], warnings: [] } },
});

const vaWith = (procOver = {}, clipOver = {}) => ({
  processes: [{ id: 'p1', sharedJobId: 'j1', name: '공정1', shiftSharePercent: 100, activeMinutesPerDay: 200, analysisProfile: 'posture-basic', ...procOver }],
  clips: [{ id: 'c1', processId: 'p1', viewpoint: 'sagittal', fixtureClipName: 'good.mp4', ...clipOver }],
});

beforeEach(() => {
  vi.clearAllMocks();
  createClip.mockResolvedValue({ clipId: 'srv-clip-1' });
  createJob.mockResolvedValue({ jobId: 'job-1', status: 'queued' });
  pollJob.mockResolvedValue({ jobId: 'job-1', status: 'review_pending', resultFeatures: clipSet() });
});

describe('runServerAnalysis', () => {
  it('선택 없음: createClip(processId,fixtureClipName)→createJob(clipId,no fixtureClipName)→poll→환산', async () => {
    const r = await runServerAnalysis(patient, vaWith(), env);
    // fixtureClipName은 createClip에만(큐 결정은 서버 upload_path).
    expect(createClip).toHaveBeenCalledWith(patient, expect.objectContaining({ processId: 'p1', fixtureClipName: 'good.mp4' }));
    const jobArg = createJob.mock.calls[0][0];
    expect(jobArg).toMatchObject({ clipId: 'srv-clip-1', processId: 'p1' });
    expect(jobArg).not.toHaveProperty('fixtureClipName');
    expect(r.errors).toEqual([]);
    expect(r.processFeatures).toHaveLength(1);
    expect(r.processFeatures[0]).toMatchObject({ processId: 'p1', jobId: 'job-1' });
    // ratio 0.5 × 200분 = 100 minutes_per_day
    expect(r.processFeatures[0].features.squatDuration).toMatchObject({ value: 100, unit: 'minutes_per_day' });
    expect(r.bundleVersion).toContain('fc-1');
  });

  it('detection 있으면 serverClipId 재사용(새 clip 미생성 — 서버 보존 target)', async () => {
    const va = vaWith();
    const detections = { [va.clips[0].id]: { serverClipId: 'picked-clip', selectedId: 'p2' } };
    await runServerAnalysis(patient, va, { ...env, detections });
    expect(createClip).not.toHaveBeenCalled();
    expect(createJob).toHaveBeenCalledWith(expect.objectContaining({ clipId: 'picked-clip' }), expect.anything());
  });

  it('job error(TARGET_TRACK_MAP_FAILED) → error 기록(적용 차단), processFeatures 없음', async () => {
    pollJob.mockResolvedValue({ jobId: 'job-1', status: 'error', errorCode: 'TARGET_TRACK_MAP_FAILED' });
    const r = await runServerAnalysis(patient, vaWith(), env);
    expect(r.processFeatures).toEqual([]);
    expect(r.errors[0].message).toContain('TARGET_TRACK_MAP_FAILED');
  });

  it('fixture 클립 없는 공정 → 추론 미실행 + error 기록', async () => {
    const r = await runServerAnalysis(patient, vaWith({}, { fixtureClipName: '' }), env);
    expect(createJob).not.toHaveBeenCalled();
    expect(r.processFeatures).toEqual([]);
    expect(r.errors[0].processId).toBe('p1');
  });

  it('job 상태가 review_pending이 아니면 error 기록(예: error)', async () => {
    pollJob.mockResolvedValue({ jobId: 'job-1', status: 'error', errorCode: 'INFERENCE_ERROR' });
    const r = await runServerAnalysis(patient, vaWith(), env);
    expect(r.processFeatures).toEqual([]);
    expect(r.errors[0].message).toContain('INFERENCE_ERROR');
  });

  it('활성 모듈과 무관한 feature는 제외(무릎만 활성 → spine trunkPostureG 제거)', async () => {
    pollJob.mockResolvedValue({
      jobId: 'job-1', status: 'review_pending',
      resultFeatures: {
        schemaVersion: 1, featureConfigVersion: 'fc-1', clipRef: 'c.mp4', clipDurationMs: 1000, analyzedFrames: 10,
        features: {
          squatDuration: { kind: 'numeric', metric: 'posture_ratio', value: 0.5, unit: 'ratio', confidence: 0.8, segments: [], warnings: [] },
          trunkPostureG: { kind: 'numeric', metric: 'peak_angle', value: 40, unit: 'degrees', confidence: 0.6, segments: [], warnings: [] },
        },
      },
    });
    const r = await runServerAnalysis(patient, vaWith(), env); // env.activeModules = ['knee']
    expect(r.processFeatures[0].features.squatDuration).toBeDefined();
    expect(r.processFeatures[0].features.trunkPostureG).toBeUndefined();
  });

  it('activeMinutesPerDay null → per-day feature 누락 + missingActiveTime 기록', async () => {
    const r = await runServerAnalysis(patient, vaWith({ activeMinutesPerDay: null }), env);
    expect(r.processFeatures[0].features.squatDuration).toBeUndefined();
    expect(r.missingActiveTime.p1).toEqual(['squatDuration']);
  });

  it('공정당 다중 시점 클립 → 각 클립 추론·시점 융합·analysisJobIds[] 복수 (D3b)', async () => {
    createJob.mockResolvedValueOnce({ jobId: 'job-a', status: 'queued' })
             .mockResolvedValueOnce({ jobId: 'job-b', status: 'queued' });
    pollJob.mockResolvedValueOnce({ jobId: 'job-a', status: 'review_pending', resultFeatures: clipSet(0.5) })
           .mockResolvedValueOnce({ jobId: 'job-b', status: 'review_pending', resultFeatures: clipSet(0.5) });
    const va = vaWith();
    va.clips = [
      { id: 'c1', processId: 'p1', viewpoint: 'sagittal', fixtureClipName: 'a.mp4' },
      { id: 'c2', processId: 'p1', viewpoint: 'frontal', fixtureClipName: 'b.mp4' },
    ];
    const r = await runServerAnalysis(patient, va, env);
    expect(r.errors).toEqual([]);
    expect(createJob).toHaveBeenCalledTimes(2);
    expect(r.processFeatures).toHaveLength(1);
    expect(r.processFeatures[0].analysisJobIds).toEqual(['job-a', 'job-b']); // 융합 → 복수 job provenance
    expect(r.processFeatures[0].features.squatDuration).toMatchObject({ value: 100, unit: 'minutes_per_day' });
  });

  it('다중 시점 중 하나라도 실패 → 공정 전체 실패(error) + processFeatures 없음', async () => {
    pollJob.mockResolvedValueOnce({ jobId: 'job-a', status: 'review_pending', resultFeatures: clipSet(0.5) })
           .mockResolvedValueOnce({ jobId: 'job-b', status: 'error', errorCode: 'INFERENCE_ERROR' });
    const va = vaWith();
    va.clips = [
      { id: 'c1', processId: 'p1', viewpoint: 'sagittal', fixtureClipName: 'a.mp4' },
      { id: 'c2', processId: 'p1', viewpoint: 'frontal', fixtureClipName: 'b.mp4' },
    ];
    const r = await runServerAnalysis(patient, va, env);
    expect(r.processFeatures).toEqual([]);
    expect(r.errors[0].message).toContain('INFERENCE_ERROR');
  });

  it('processEvidence 반환: 환산 evidence(intrinsicValue·activeMinutesPerDay) + 융합 adopted 클립', async () => {
    const r = await runServerAnalysis(patient, vaWith(), env);
    expect(r.processEvidence).toHaveLength(1);
    const pe = r.processEvidence[0];
    expect(pe).toMatchObject({ processId: 'p1', analysisJobIds: ['job-1'] });
    const ev = pe.evidenceByFeatureKey.squatDuration;
    expect(ev).toMatchObject({ intrinsicValue: 0.5, intrinsicMetric: 'posture_ratio', activeMinutesPerDay: 200 });
    // 단일 클립 융합 → adopted 클립 식별자(serverClipId·jobId) 운반
    expect(ev.fusion.adopted).toMatchObject({ viewpoint: 'sagittal', serverClipId: 'srv-clip-1', jobId: 'job-1' });
  });

  it('다중 시점: processEvidence.fusion.candidates 복수(채택/탈락 추적)', async () => {
    createJob.mockResolvedValueOnce({ jobId: 'job-a', status: 'queued' })
             .mockResolvedValueOnce({ jobId: 'job-b', status: 'queued' });
    pollJob.mockResolvedValueOnce({ jobId: 'job-a', status: 'review_pending', resultFeatures: clipSet(0.5) })
           .mockResolvedValueOnce({ jobId: 'job-b', status: 'review_pending', resultFeatures: clipSet(0.5) });
    const va = vaWith();
    va.clips = [
      { id: 'c1', processId: 'p1', viewpoint: 'sagittal', fixtureClipName: 'a.mp4' },
      { id: 'c2', processId: 'p1', viewpoint: 'frontal', fixtureClipName: 'b.mp4' },
    ];
    const r = await runServerAnalysis(patient, va, env);
    const ev = r.processEvidence[0].evidenceByFeatureKey.squatDuration;
    expect(ev.fusion.candidates).toHaveLength(2);
  });
});
