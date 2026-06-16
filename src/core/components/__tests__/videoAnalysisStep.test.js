import { describe, it, expect } from 'vitest';
import {
  requestedFeaturesForModules,
  buildJobFeatures,
  shareTotalsByJob,
  clearDerived,
  editProcessVA,
  removeProcessVA,
  addClipVA,
  resolveApplyMode,
} from '../VideoAnalysisStep.jsx';

describe('requestedFeaturesForModules', () => {
  it('returns only featureKeys that map to active modules (incl. candidates)', () => {
    const knee = requestedFeaturesForModules(['knee']).sort();
    expect(knee).toEqual(['squatDuration', 'suspectedKneeTwist'].sort());
  });

  it('unions across multiple active modules', () => {
    const keys = requestedFeaturesForModules(['shoulder', 'cervical']);
    expect(keys).toContain('overheadHours');
    expect(keys).toContain('neckFlexionOver20HoursPerDay');
    expect(keys).not.toContain('squatDuration'); // knee 미활성
  });

  it('returns nothing for no active modules', () => {
    expect(requestedFeaturesForModules([])).toEqual([]);
  });
});

describe('buildJobFeatures', () => {
  const num = (value) => ({
    kind: 'numeric', value, unit: 'hours_per_day', confidence: 0.8,
    autoSuggestAllowed: true, requiresManualReview: false, warnings: [],
  });

  it('groups process features by sharedJobId and aggregates (weighted sum)', () => {
    const processes = [
      { id: 'p1', sharedJobId: 'jobA', shiftSharePercent: 60 },
      { id: 'p2', sharedJobId: 'jobA', shiftSharePercent: 40 },
      { id: 'p3', sharedJobId: 'jobB', shiftSharePercent: 100 },
    ];
    const processFeatures = [
      { processId: 'p1', features: { overheadHours: num(2.0) } },
      { processId: 'p2', features: { overheadHours: num(1.0) } },
      { processId: 'p3', features: { overheadHours: num(3.0) } },
    ];
    const jobFeatures = buildJobFeatures(processes, processFeatures);
    const jobA = jobFeatures.find((j) => j.sharedJobId === 'jobA');
    const jobB = jobFeatures.find((j) => j.sharedJobId === 'jobB');
    expect(jobA.features.overheadHours.value).toBeCloseTo(1.6, 5); // 2*0.6 + 1*0.4
    expect(jobB.features.overheadHours.value).toBeCloseTo(3.0, 5); // 3*1.0
  });

  it('ignores process features with no matching process', () => {
    const out = buildJobFeatures([], [{ processId: 'ghost', features: { overheadHours: num(1) } }]);
    expect(out).toEqual([]);
  });

  it('absolutePerDay=true sums per-day values without re-discounting by shiftSharePercent (서버 실분석)', () => {
    // 서버 경로: value=ratio×activeMinutesPerDay로 이미 절대 per-day → share로 또 깎으면 안 된다.
    const processes = [
      { id: 'p1', sharedJobId: 'jobA', shiftSharePercent: 50 },
      { id: 'p2', sharedJobId: 'jobA', shiftSharePercent: 50 },
    ];
    const processFeatures = [
      { processId: 'p1', features: { overheadHours: num(2.0) } },
      { processId: 'p2', features: { overheadHours: num(1.0) } },
    ];
    // 기본(mock): 2*0.5 + 1*0.5 = 1.5
    expect(buildJobFeatures(processes, processFeatures).find((j) => j.sharedJobId === 'jobA').features.overheadHours.value).toBeCloseTo(1.5, 5);
    // absolutePerDay: 2 + 1 = 3.0 (이중 차감 없음)
    expect(buildJobFeatures(processes, processFeatures, { absolutePerDay: true }).find((j) => j.sharedJobId === 'jobA').features.overheadHours.value).toBeCloseTo(3.0, 5);
  });
});

describe('shareTotalsByJob', () => {
  it('sums shiftSharePercent per job', () => {
    const totals = shareTotalsByJob([
      { sharedJobId: 'a', shiftSharePercent: 60 },
      { sharedJobId: 'a', shiftSharePercent: 30 },
      { sharedJobId: 'b', shiftSharePercent: 100 },
    ]);
    expect(totals).toEqual({ a: 90, b: 100 });
  });
});

describe('resolveApplyMode (server vs local vs blocked)', () => {
  it('intranet + synced → server', () => {
    expect(resolveApplyMode(true, true)).toBe('server');
  });
  it('intranet + not synced → blocked', () => {
    expect(resolveApplyMode(true, false)).toBe('blocked');
  });
  it('non-intranet → local (regardless of sync)', () => {
    expect(resolveApplyMode(false, true)).toBe('local');
    expect(resolveApplyMode(false, false)).toBe('local');
  });
});

describe('input edits invalidate stale analysis results (Codex finding)', () => {
  const analyzed = () => ({
    processes: [{ id: 'p1', sharedJobId: 'jobA', name: '공정', shiftSharePercent: 60, analysisProfile: 'posture-basic' }],
    clips: [{ id: 'c1', processId: 'p1', viewpoint: 'sagittal' }],
    processFeatures: [{ processId: 'p1', features: { overheadHours: { kind: 'numeric', value: 2 } } }],
    jobFeatures: [{ sharedJobId: 'jobA', features: { overheadHours: { kind: 'numeric', value: 1.2 } } }],
    candidateFeatures: [{ featureKey: 'suspectedKneeTwist', value: true }],
    appliedInputs: [{ moduleId: 'shoulder', targetPath: 'x', appliedValue: '1.8' }],
  });

  it('clearDerived empties derived features but keeps processes/clips/appliedInputs', () => {
    const out = clearDerived(analyzed());
    expect(out.processFeatures).toEqual([]);
    expect(out.jobFeatures).toEqual([]);
    expect(out.candidateFeatures).toEqual([]);
    expect(out.processes).toHaveLength(1);
    expect(out.appliedInputs).toHaveLength(1); // 적용 이력 보존
  });

  it('editing a process share% invalidates job/process/candidate features (no stale apply)', () => {
    const out = editProcessVA(analyzed(), 'p1', { shiftSharePercent: 40 });
    expect(out.processes[0].shiftSharePercent).toBe(40);
    expect(out.jobFeatures).toEqual([]); // 추천 사라짐 → 재분석 필요
    expect(out.processFeatures).toEqual([]);
    expect(out.appliedInputs).toHaveLength(1);
  });

  it('removing a process drops its clips and invalidates results', () => {
    const out = removeProcessVA(analyzed(), 'p1');
    expect(out.processes).toEqual([]);
    expect(out.clips).toEqual([]);
    expect(out.jobFeatures).toEqual([]);
  });

  it('adding a clip invalidates results', () => {
    const out = addClipVA(analyzed(), 'p1');
    expect(out.clips).toHaveLength(2);
    expect(out.jobFeatures).toEqual([]);
  });
});
