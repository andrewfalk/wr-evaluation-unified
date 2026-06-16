import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../videoAnalysisClient', () => ({ createClip: vi.fn(), createJob: vi.fn() }));
vi.mock('../patientServerRepository', () => ({ applyVideoAnalysisJob: vi.fn() }));
vi.mock('../videoProvenance', () => ({ applyFeatureToModule: vi.fn() }));

import { createClip, createJob } from '../videoAnalysisClient';
import { applyVideoAnalysisJob } from '../patientServerRepository';
import { applyFeatureToModule } from '../videoProvenance';
import { applyVideoFeatureViaServer, computeAppliedInputsHash } from '../videoServerApply.js';

const patient = { id: 'local-1', sync: { serverId: 'srv-1', revision: 2, syncStatus: 'synced' } };
const env = { session: { mode: 'intranet' }, settings: {}, appliedBy: 'doc1' };
const opts = {
  moduleId: 'shoulder', ctx: { sharedJobId: 'job-1' }, featureKey: 'overheadHours',
  suggestedValue: 1.8, confidence: 0.82, processIds: ['pr1'], processId: 'pr1', analysisProfile: 'posture-basic',
};

beforeEach(() => { vi.clearAllMocks(); });

describe('computeAppliedInputsHash', () => {
  it('is deterministic and excludes previousValue', () => {
    const a = computeAppliedInputsHash('j1', { targetPath: 'tp', appliedValue: '1.8', previousValue: '0.5' });
    const b = computeAppliedInputsHash('j1', { targetPath: 'tp', appliedValue: '1.8', previousValue: 'WHATEVER' });
    expect(a).toBe(b); // previousValue 변경에도 동일
    expect(a).not.toContain('previousValue');
  });

  it('differs by jobId / value', () => {
    const base = computeAppliedInputsHash('j1', { targetPath: 'tp', appliedValue: '1.8' });
    expect(computeAppliedInputsHash('j2', { targetPath: 'tp', appliedValue: '1.8' })).not.toBe(base);
    expect(computeAppliedInputsHash('j1', { targetPath: 'tp', appliedValue: '2.0' })).not.toBe(base);
  });
});

describe('applyVideoFeatureViaServer', () => {
  it('orchestrates clip → job → apply and returns the server patient', async () => {
    createClip.mockResolvedValueOnce({ clipId: 'c1' });
    createJob.mockResolvedValueOnce({ jobId: 'j1', status: 'review_pending' });
    const appliedInput = { targetPath: 'modules.shoulder.jobExtras[sharedJobId=job-1].overheadHours', appliedValue: '1.8' };
    applyFeatureToModule.mockReturnValueOnce({ patient: { data: { computed: true } }, appliedInput });
    const serverPatient = { id: 'local-1', sync: { serverId: 'srv-1', revision: 3, syncStatus: 'synced' } };
    applyVideoAnalysisJob.mockResolvedValueOnce(serverPatient);

    const out = await applyVideoFeatureViaServer(patient, opts, env);

    expect(createClip).toHaveBeenCalledWith(patient, { session: env.session, settings: env.settings });
    expect(createJob).toHaveBeenCalledWith(
      { clipId: 'c1', processId: 'pr1', analysisProfile: 'posture-basic', requestedFeatures: ['overheadHours'] },
      { session: env.session, settings: env.settings }
    );
    // 환자 data는 로컬에서 계산되어 apply로 전달된다.
    expect(applyVideoAnalysisJob).toHaveBeenCalledWith(
      'j1', patient, { computed: true },
      expect.objectContaining({
        appliedInputsHash: computeAppliedInputsHash('j1', appliedInput),
        appliedInputsCount: 1,
      })
    );
    expect(out).toBe(serverPatient);
  });

  it('threads analysisJobIds → provenance + sourceAnalysisJobIds (consumed source jobs)', async () => {
    createClip.mockResolvedValueOnce({ clipId: 'c1' });
    createJob.mockResolvedValueOnce({ jobId: 'shell-1', status: 'review_pending' });
    const appliedInput = { targetPath: 'tp', appliedValue: '1.8' };
    applyFeatureToModule.mockReturnValueOnce({ patient: { data: { computed: true } }, appliedInput });
    applyVideoAnalysisJob.mockResolvedValueOnce({ id: 'local-1' });

    await applyVideoFeatureViaServer(patient, { ...opts, analysisJobIds: ['ja', 'jb'], analysisBundleVersion: 'recipe-1' }, env);

    expect(applyFeatureToModule).toHaveBeenCalledWith(patient, expect.objectContaining({
      analysisJobIds: ['ja', 'jb'], analysisBundleVersion: 'recipe-1',
    }));
    expect(applyVideoAnalysisJob).toHaveBeenCalledWith(
      'shell-1', patient, { computed: true },
      expect.objectContaining({ sourceAnalysisJobIds: ['ja', 'jb'] })
    );
  });

  it('blocks apply when the job is not review_pending (defensive guard)', async () => {
    createClip.mockResolvedValueOnce({ clipId: 'c1' });
    createJob.mockResolvedValueOnce({ jobId: 'j1', status: 'error' });
    await expect(applyVideoFeatureViaServer(patient, opts, env)).rejects.toMatchObject({ code: 'JOB_NOT_READY' });
    expect(applyFeatureToModule).not.toHaveBeenCalled();
    expect(applyVideoAnalysisJob).not.toHaveBeenCalled();
  });

  it('propagates a synced-gate error from createClip (no job/apply)', async () => {
    createClip.mockRejectedValueOnce(Object.assign(new Error('not synced'), { code: 'PATIENT_NOT_SYNCED' }));
    await expect(applyVideoFeatureViaServer(patient, opts, env)).rejects.toMatchObject({ code: 'PATIENT_NOT_SYNCED' });
    expect(createJob).not.toHaveBeenCalled();
    expect(applyVideoAnalysisJob).not.toHaveBeenCalled();
  });
});
