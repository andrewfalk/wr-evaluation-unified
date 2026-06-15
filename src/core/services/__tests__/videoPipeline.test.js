import { describe, it, expect, beforeEach, vi } from 'vitest';

// exportHandlers는 html2pdf(브라우저 전역 self 의존)를 끌어오므로 node 테스트에서 stub —
// videoMappingConfig 검증과 무관. (vi.mock은 import보다 먼저 hoist된다.)
vi.mock('../../../modules/knee/utils/exportHandlers', () => ({ kneeExportHandlers: {} }));
vi.mock('../../../modules/shoulder/utils/exportHandlers', () => ({ shoulderExportHandlers: {} }));
vi.mock('../../../modules/spine/utils/exportHandlers', () => ({ spineExportHandlers: {} }));
vi.mock('../../../modules/cervical/utils/exportHandlers', () => ({ cervicalExportHandlers: {} }));

// 모듈 self-register (videoMappingConfig 포함)
import '../../../modules/knee';
import '../../../modules/shoulder';
import '../../../modules/spine';
import '../../../modules/cervical';

import { generateMockFeatures } from '../videoMock.js';
import { aggregateProcessFeatures, getAggregationMethod } from '../videoAggregate.js';
import {
  getModuleSuggestions,
  collectCandidateFeatures,
  applyFeatureToModule,
  rollbackAppliedInput,
} from '../videoProvenance.js';
import { getModule, getModulesWithVideoMapping } from '../../moduleRegistry.js';
import { createVideoAnalysisData } from '../../utils/data.js';
import { VideoFeatureValueSchema } from '../../../../shared/contracts/videoAnalysis';
import { VIDEO_FEATURE_TARGETS } from '../../../../shared/contracts/videoAnalysis';

const makePatient = () => ({
  id: 'p1',
  data: {
    shared: { videoAnalysis: createVideoAnalysisData() },
    modules: {
      knee: { jobExtras: [] },
      shoulder: { jobExtras: [] },
      spine: { tasks: [{ id: 't1', name: '작업', posture: 'G1', frequency: 80, timeValue: 5, timeUnit: 'min' }] },
      cervical: { tasks: [{ id: 'c1', neck_nonneutral_hours_per_day: '', forced_neck_posture: '' }] },
    },
    activeModules: ['knee', 'shoulder', 'spine', 'cervical'],
  },
});

describe('generateMockFeatures', () => {
  it('returns a feature for each requested key, all parseable by the contract', () => {
    const map = generateMockFeatures(['overheadHours', 'squatDuration', 'suspectedKneeTwist'], 'posture-basic');
    expect(Object.keys(map).sort()).toEqual(['overheadHours', 'squatDuration', 'suspectedKneeTwist']);
    for (const fv of Object.values(map)) {
      expect(() => VideoFeatureValueSchema.parse(fv)).not.toThrow();
    }
  });

  it('numeric features carry the contract unit; candidates are not auto-suggestable', () => {
    const map = generateMockFeatures(['overheadHours', 'suspectedKneeTwist']);
    expect(map.overheadHours.kind).toBe('numeric');
    expect(map.overheadHours.unit).toBe('hours_per_day');
    expect(map.suspectedKneeTwist.kind).toBe('candidate');
    expect(map.suspectedKneeTwist.autoSuggestAllowed).toBe(false);
    expect(map.suspectedKneeTwist.requiresManualReview).toBe(true);
  });

  it('auto-review features are auto-suggestable but require manual review', () => {
    const map = generateMockFeatures(['cyclesPerDay', 'overheadHours']);
    // cyclesPerDay = auto-review
    expect(map.cyclesPerDay.autoSuggestAllowed).toBe(true);
    expect(map.cyclesPerDay.requiresManualReview).toBe(true);
    // overheadHours = auto
    expect(map.overheadHours.autoSuggestAllowed).toBe(true);
    expect(map.overheadHours.requiresManualReview).toBe(false);
  });

  it('ignores unknown keys (only known FeatureKeys produced)', () => {
    const map = generateMockFeatures(['notAKey']);
    expect(map).toEqual({});
  });
});

describe('aggregateProcessFeatures (§8.6.2)', () => {
  const num = (value, confidence = 0.8, unit = 'hours_per_day') => ({
    kind: 'numeric', value, unit, confidence, autoSuggestAllowed: true, requiresManualReview: false, warnings: [],
  });

  it('weighted-sums cumulative time by share fraction', () => {
    const entries = [
      { share: 60, features: { overheadHours: num(2.0) } },
      { share: 40, features: { overheadHours: num(1.0) } },
    ];
    const out = aggregateProcessFeatures(entries);
    // 2.0*0.6 + 1.0*0.4 = 1.6
    expect(out.overheadHours.value).toBeCloseTo(1.6, 5);
    // 신뢰도는 보수적으로 최솟값
    expect(out.overheadHours.confidence).toBe(0.8);
  });

  it('weightedSum uses raw share/100 (not normalized) — partial-shift work is not over-counted', () => {
    // 단일 공정이 시프트의 60%만 차지 → 2시간 × 0.6 = 1.2시간 (정규화 시 잘못 2.0이 됨)
    const out = aggregateProcessFeatures([{ share: 60, features: { overheadHours: num(2.0) } }]);
    expect(out.overheadHours.value).toBeCloseTo(1.2, 5);
  });

  it('weighted-averages cycleSeconds (per-cycle, not cumulative)', () => {
    expect(getAggregationMethod('cycleSeconds')).toBe('weightedAvg');
    const entries = [
      { share: 50, features: { cycleSeconds: num(4, 0.8, 'seconds_per_cycle') } },
      { share: 50, features: { cycleSeconds: num(8, 0.7, 'seconds_per_cycle') } },
    ];
    const out = aggregateProcessFeatures(entries);
    expect(out.cycleSeconds.value).toBeCloseTo(6, 5); // (4+8)/2
    expect(out.cycleSeconds.confidence).toBe(0.7);
  });

  it('ORs boolean candidates and falls back to equal weight when shares are 0', () => {
    const cand = (v) => ({ kind: 'candidate', value: v, reason: 'r', confidence: 0.5, autoSuggestAllowed: false, requiresManualReview: true, warnings: [] });
    const out = aggregateProcessFeatures([
      { share: 0, features: { suspectedKneeTwist: cand(false) } },
      { share: 0, features: { suspectedKneeTwist: cand(true) } },
    ]);
    expect(out.suspectedKneeTwist.value).toBe(true);
  });
});

describe('videoMappingConfig manifest shape (registry safety net)', () => {
  it('only declared modules support video mapping; shapes are valid', () => {
    const mapped = getModulesWithVideoMapping().map((m) => m.id).sort();
    expect(mapped).toEqual(['cervical', 'knee', 'shoulder', 'spine']);
    for (const m of getModulesWithVideoMapping()) {
      const c = m.videoMappingConfig;
      expect(['job', 'task', 'job-diagnosis']).toContain(c.scope);
      expect(Array.isArray(c.featureKeys)).toBe(true);
      expect(typeof c.writeField).toBe('function');
      // 선언한 featureKey는 이 모듈로 매핑되고 candidate가 아니어야 한다(자동제안 대상).
      for (const fk of c.featureKeys) {
        const t = VIDEO_FEATURE_TARGETS[fk];
        expect(t).toBeTruthy();
        expect(t.moduleId).toBe(m.id);
        expect(t.mode).not.toBe('candidate');
      }
    }
  });
});

describe('getModuleSuggestions / collectCandidateFeatures', () => {
  it('routes auto features to their module and excludes candidates', () => {
    const featureMap = generateMockFeatures(['overheadHours', 'squatDuration', 'suspectedKneeTwist']);
    const shoulder = getModuleSuggestions(featureMap, 'shoulder');
    expect(shoulder.map((s) => s.featureKey)).toEqual(['overheadHours']);
    const knee = getModuleSuggestions(featureMap, 'knee');
    expect(knee.map((s) => s.featureKey)).toEqual(['squatDuration']); // candidate suspectedKneeTwist 제외
  });

  it('collects candidate features separately', () => {
    const featureMap = generateMockFeatures(['squatDuration', 'suspectedKneeTwist', 'trunkPostureG']);
    const cands = collectCandidateFeatures(featureMap, { processIds: ['pr1'], clipIds: ['cl1'] });
    expect(cands.map((c) => c.featureKey).sort()).toEqual(['suspectedKneeTwist', 'trunkPostureG']);
    expect(cands[0].processIds).toEqual(['pr1']);
  });
});

describe('applyFeatureToModule — coercion + provenance', () => {
  let patient;
  beforeEach(() => { patient = makePatient(); });

  it('knee squatDuration → squatting as STRING, appliedInputs recorded', () => {
    const map = generateMockFeatures(['squatDuration']);
    const { patient: next, appliedInput } = applyFeatureToModule(patient, {
      moduleId: 'knee', ctx: { sharedJobId: 'j1' }, featureKey: 'squatDuration',
      suggestedValue: map.squatDuration.value, confidence: map.squatDuration.confidence, appliedBy: 'doc1',
    });
    const extra = next.data.modules.knee.jobExtras.find((e) => e.sharedJobId === 'j1');
    expect(extra.squatting).toBe('180'); // string coercion
    expect(typeof extra.squatting).toBe('string');
    expect(appliedInput.unit).toBe('minutes_per_day');
    expect(appliedInput.source).toBe('video');
    expect(appliedInput.previousValue).toBe(''); // createKneeJobExtras 기본값
    expect(next.data.shared.videoAnalysis.appliedInputs).toHaveLength(1);
  });

  it('shoulder overheadHours → string field', () => {
    const { patient: next } = applyFeatureToModule(patient, {
      moduleId: 'shoulder', ctx: { sharedJobId: 'j1' }, featureKey: 'overheadHours',
      suggestedValue: 1.8, confidence: 0.82,
    });
    const extra = next.data.modules.shoulder.jobExtras.find((e) => e.sharedJobId === 'j1');
    expect(extra.overheadHours).toBe('1.8');
  });

  it('spine cyclesPerDay → frequency as NUMBER (module-specific coercion)', () => {
    const { patient: next } = applyFeatureToModule(patient, {
      moduleId: 'spine', ctx: { taskId: 't1' }, featureKey: 'cyclesPerDay',
      suggestedValue: 1200, confidence: 0.7,
    });
    const task = next.data.modules.spine.tasks.find((t) => t.id === 't1');
    expect(task.frequency).toBe(1200);
    expect(typeof task.frequency).toBe('number');
  });

  it('spine cycleSeconds → timeValue NUMBER + timeUnit forced to "sec"', () => {
    const { patient: next } = applyFeatureToModule(patient, {
      moduleId: 'spine', ctx: { taskId: 't1' }, featureKey: 'cycleSeconds',
      suggestedValue: 6.4, confidence: 0.7,
    });
    const task = next.data.modules.spine.tasks.find((t) => t.id === 't1');
    expect(task.timeValue).toBe(6); // Math.round
    expect(task.timeUnit).toBe('sec'); // was 'min' → forced
  });

  it('cervical neckFlexion → string field on task', () => {
    const { patient: next } = applyFeatureToModule(patient, {
      moduleId: 'cervical', ctx: { taskId: 'c1' }, featureKey: 'neckFlexionOver20HoursPerDay',
      suggestedValue: 1.2, confidence: 0.82,
    });
    const task = next.data.modules.cervical.tasks.find((t) => t.id === 'c1');
    expect(task.neck_nonneutral_hours_per_day).toBe('1.2');
  });

  it('throws (no empty provenance) when the task target does not exist', () => {
    expect(() => applyFeatureToModule(patient, {
      moduleId: 'spine', ctx: { taskId: 'nonexistent' }, featureKey: 'cyclesPerDay',
      suggestedValue: 1200, confidence: 0.7,
    })).toThrow(/not found/);
    // appliedInputs에 빈 기록이 남지 않아야 함
    expect(patient.data.shared.videoAnalysis.appliedInputs).toHaveLength(0);
  });

  it('does not mutate the original patient (immutability)', () => {
    applyFeatureToModule(patient, {
      moduleId: 'knee', ctx: { sharedJobId: 'j1' }, featureKey: 'squatDuration', suggestedValue: 180, confidence: 0.8,
    });
    expect(patient.data.modules.knee.jobExtras).toHaveLength(0);
    expect(patient.data.shared.videoAnalysis.appliedInputs).toHaveLength(0);
  });
});

describe('rollbackAppliedInput', () => {
  it('restores previousValue and removes the appliedInputs entry', () => {
    let patient = makePatient();
    // 기존 값 세팅
    patient.data.modules.shoulder.jobExtras = [{ sharedJobId: 'j1', overheadHours: '0.5' }];
    const { patient: applied, appliedInput } = applyFeatureToModule(patient, {
      moduleId: 'shoulder', ctx: { sharedJobId: 'j1' }, featureKey: 'overheadHours',
      suggestedValue: 1.8, confidence: 0.82,
    });
    expect(applied.data.modules.shoulder.jobExtras[0].overheadHours).toBe('1.8');
    expect(appliedInput.previousValue).toBe('0.5');

    const reverted = rollbackAppliedInput(applied, 0);
    expect(reverted.data.modules.shoulder.jobExtras[0].overheadHours).toBe('0.5');
    expect(reverted.data.shared.videoAnalysis.appliedInputs).toHaveLength(0);
  });

  it('is a no-op for an out-of-range index', () => {
    const patient = makePatient();
    expect(rollbackAppliedInput(patient, 5)).toBe(patient);
  });
});
