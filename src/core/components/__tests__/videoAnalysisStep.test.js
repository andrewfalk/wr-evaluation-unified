import { describe, it, expect } from 'vitest';
import {
  requestedFeaturesForModules,
  buildJobFeatures,
  buildJobEvidence,
  shareTotalsByJob,
  clearDerived,
  editProcessVA,
  removeProcessVA,
  addClipVA,
  resolveApplyMode,
  resolveSourceJobs,
  sourceJobLabel,
  buildProcessEvidence,
  tasksForJob,
  resolveTargetTaskId,
} from '../VideoAnalysisStep.jsx';
import { getAggregationMethod } from '../../services/videoAggregate.js';
import { getModuleSuggestions } from '../../services/videoProvenance.js';

describe('resolveSourceJobs (6.0-8 — 골격 검수 source job 도출)', () => {
  it('시점 융합: 채택(adopted) 먼저, 탈락은 비교 시점으로 구분', () => {
    const jobEv = {
      analysisJobIds: ['jb', 'ja'],
      contributions: [{
        processName: '공정A',
        evidence: { fusion: {
          adopted: { jobId: 'ja', viewpoint: 'sagittal', adopted: true },
          candidates: [
            { jobId: 'jb', viewpoint: 'frontal', adopted: false },
            { jobId: 'ja', viewpoint: 'sagittal', adopted: true },
          ],
        } },
      }],
    };
    const out = resolveSourceJobs(jobEv);
    expect(out.map((s) => s.jobId)).toEqual(['ja', 'jb']); // 채택 먼저
    expect(out[0]).toMatchObject({ jobId: 'ja', adopted: true, viewpoint: 'sagittal', processName: '공정A' });
    expect(out[1]).toMatchObject({ jobId: 'jb', adopted: false, viewpoint: 'frontal' });
  });

  it('여러 공정 jobId 중복 제거', () => {
    const jobEv = { contributions: [
      { processName: 'A', evidence: { fusion: { candidates: [{ jobId: 'j1', viewpoint: 'sagittal', adopted: true }] } } },
      { processName: 'B', evidence: { fusion: { candidates: [{ jobId: 'j1', viewpoint: 'sagittal', adopted: true }] } } },
    ] };
    expect(resolveSourceJobs(jobEv).map((s) => s.jobId)).toEqual(['j1']);
  });

  it('contribution에 fusion 없으면 그 contribution의 analysisJobIds로 fallback(누락 방지)', () => {
    const jobEv = { contributions: [{ processName: '공정A', analysisJobIds: ['j9'], evidence: {} }] };
    const out = resolveSourceJobs(jobEv);
    expect(out).toEqual([{ jobId: 'j9', processName: '공정A', viewpoint: null, adopted: true }]);
  });

  it('혼합: fusion 있는 contribution + fusion 없는 contribution 모두 source에 포함', () => {
    const jobEv = { contributions: [
      { processName: 'A', evidence: { fusion: { candidates: [{ jobId: 'jf', viewpoint: 'sagittal', adopted: true }] } } },
      { processName: 'B', analysisJobIds: ['jn'], evidence: {} },
    ] };
    expect(resolveSourceJobs(jobEv).map((s) => s.jobId).sort()).toEqual(['jf', 'jn']);
  });

  it('contribution 없는 구 데이터 → feature 레벨 analysisJobIds 최종 fallback', () => {
    const jobEv = { analysisJobIds: ['j9'], contributions: [] };
    expect(resolveSourceJobs(jobEv)).toEqual([{ jobId: 'j9', processName: null, viewpoint: null, adopted: true }]);
  });

  it('jobEv 없음 → 빈 배열', () => {
    expect(resolveSourceJobs(null)).toEqual([]);
  });

  it('sourceJobLabel: 공정+시점+채택여부', () => {
    expect(sourceJobLabel({ processName: '공정A', viewpoint: 'sagittal', adopted: true })).toBe('공정A 측면 (채택)');
    expect(sourceJobLabel({ processName: '공정A', viewpoint: 'frontal', adopted: false })).toBe('공정A 정면 (비교 시점)');
    expect(sourceJobLabel({ processName: null, viewpoint: null, adopted: true })).toBe('(채택)');
  });
});

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

describe('buildJobEvidence (B2 선행 — 값/근거 분리, 2단 keying)', () => {
  const processes = [
    { id: 'p1', sharedJobId: 'jobA', name: '공정A', shiftSharePercent: 60 },
    { id: 'p2', sharedJobId: 'jobB', name: '공정B', shiftSharePercent: 100 },
  ];
  const processFeatures = [
    { processId: 'p1', features: { squatDuration: { kind: 'numeric', value: 126 } } },
    { processId: 'p2', features: { squatDuration: { kind: 'numeric', value: 40 } } },
  ];
  const processEvidence = [
    { processId: 'p1', analysisJobIds: ['j1'], evidenceByFeatureKey: { squatDuration: { intrinsicValue: 0.35, intrinsicMetric: 'posture_ratio', activeMinutesPerDay: 360, warnings: [] } } },
    { processId: 'p2', analysisJobIds: ['j2'], evidenceByFeatureKey: { squatDuration: { intrinsicValue: 0.1, intrinsicMetric: 'posture_ratio', activeMinutesPerDay: 400, warnings: [] } } },
  ];

  it('동일 featureKey 다직업 비충돌(2단 keying: sharedJobId → featureKey)', () => {
    const byJob = buildJobEvidence(processes, processFeatures, processEvidence);
    expect(byJob.jobA.squatDuration).toBeDefined();
    expect(byJob.jobB.squatDuration).toBeDefined();
    // 서로 다른 근거(다른 공정) — 덮어쓰기 없음
    expect(byJob.jobA.squatDuration.contributions[0].processName).toBe('공정A');
    expect(byJob.jobB.squatDuration.contributions[0].processName).toBe('공정B');
    expect(byJob.jobA.squatDuration.contributions[0].evidence.activeMinutesPerDay).toBe(360);
    expect(byJob.jobB.squatDuration.contributions[0].evidence.activeMinutesPerDay).toBe(400);
  });

  it('aggregationMethod + contributions(perDayValue·실 공정 점유율·evidence) + analysisJobIds 운반', () => {
    const byJob = buildJobEvidence(processes, processFeatures, processEvidence);
    const e = byJob.jobA.squatDuration;
    expect(e.aggregationMethod).toBe(getAggregationMethod('squatDuration'));
    // sharePercent=실 공정 점유율(60), 집계 가중치 100이 아님(검토자 오해 방지)
    expect(e.contributions[0]).toMatchObject({ processId: 'p1', sharePercent: 60, perDayValue: 126 });
    expect(e.analysisJobIds).toEqual(['j1']);
  });

  it('한 직업 다공정 → contributions 누적 + analysisJobIds 합집합', () => {
    const procs = [
      { id: 'p1', sharedJobId: 'jobA', name: 'A1', shiftSharePercent: 60 },
      { id: 'p2', sharedJobId: 'jobA', name: 'A2', shiftSharePercent: 40 },
    ];
    const pe = [
      { processId: 'p1', analysisJobIds: ['j1'], evidenceByFeatureKey: { squatDuration: { intrinsicValue: 0.3, warnings: [] } } },
      { processId: 'p2', analysisJobIds: ['j2'], evidenceByFeatureKey: { squatDuration: { intrinsicValue: 0.2, warnings: [] } } },
    ];
    const byJob = buildJobEvidence(procs, [], pe);
    expect(byJob.jobA.squatDuration.contributions).toHaveLength(2);
    expect(byJob.jobA.squatDuration.contributions.map((c) => c.sharePercent)).toEqual([60, 40]);
    expect(byJob.jobA.squatDuration.analysisJobIds).toEqual(['j1', 'j2']);
  });
});

describe('buildProcessEvidence (task-scope — 공정 단위, jobEv-like)', () => {
  const processes = [
    { id: 'p1', sharedJobId: 'jobA', name: '용접', shiftSharePercent: 60 },
    { id: 'p2', sharedJobId: 'jobA', name: '연삭', shiftSharePercent: 40 },
  ];
  const processFeatures = [
    { processId: 'p1', features: { neckFlexionOver20HoursPerDay: { kind: 'numeric', value: 2.4 } } },
    { processId: 'p2', features: { neckFlexionOver20HoursPerDay: { kind: 'numeric', value: 1.0 } } },
  ];
  const processEvidence = [
    { processId: 'p1', analysisJobIds: ['j1'], evidenceByFeatureKey: { neckFlexionOver20HoursPerDay: { intrinsicValue: 0.4, warnings: [] } } },
    { processId: 'p2', analysisJobIds: ['j2'], evidenceByFeatureKey: { neckFlexionOver20HoursPerDay: { intrinsicValue: 0.2, warnings: [] } } },
  ];

  it('공정(processId) 단위 keying — 집계 없이 공정별로 분리', () => {
    const byProc = buildProcessEvidence(processes, processFeatures, processEvidence);
    expect(byProc.p1.neckFlexionOver20HoursPerDay).toBeDefined();
    expect(byProc.p2.neckFlexionOver20HoursPerDay).toBeDefined();
    expect(byProc.p1.neckFlexionOver20HoursPerDay.contributions[0].processName).toBe('용접');
    expect(byProc.p2.neckFlexionOver20HoursPerDay.contributions[0].processName).toBe('연삭');
  });

  it('jobEv-like 형태(contributions 1개 + perDayValue + analysisJobIds) — renderEvidencePanel/resolveSourceJobs 재사용', () => {
    const e = buildProcessEvidence(processes, processFeatures, processEvidence).p1.neckFlexionOver20HoursPerDay;
    expect(e.aggregationMethod).toBe('task(1:1)');
    expect(e.contributions).toHaveLength(1);
    expect(e.contributions[0]).toMatchObject({ processId: 'p1', sharePercent: 60, perDayValue: 2.4 });
    expect(e.analysisJobIds).toEqual(['j1']);
    // resolveSourceJobs가 그대로 동작(fusion 없으면 contribution analysisJobIds fallback)
    expect(resolveSourceJobs(e).map((s) => s.jobId)).toEqual(['j1']);
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

describe('tasksForJob / resolveTargetTaskId (task-scope 적용 대상)', () => {
  const moduleData = {
    tasks: [
      { id: 't1', name: '용접', sharedJobId: 'jobA' },
      { id: 't2', name: '연삭', sharedJobId: 'jobA' },
      { id: 't3', name: '레거시', sharedJobId: '' },
    ],
  };

  it('직업 매칭 task만 반환(엄격, cervical 기본)', () => {
    expect(tasksForJob(moduleData, 'jobA').map((t) => t.id)).toEqual(['t1', 't2']);
    expect(tasksForJob(moduleData, 'jobB')).toEqual([]); // 매칭 없음 + fallback 미허용 → 빈
  });

  it('fallbackUnlinked(spine): 매칭 없을 때 미연결 레거시 task 허용', () => {
    expect(tasksForJob(moduleData, 'jobB', { fallbackUnlinked: true }).map((t) => t.id)).toEqual(['t3']);
    // 매칭이 있으면 fallback 안 씀(레거시로 새지 않음)
    expect(tasksForJob(moduleData, 'jobA', { fallbackUnlinked: true }).map((t) => t.id)).toEqual(['t1', 't2']);
  });

  it('resolveTargetTaskId: 선택값이 후보에 있을 때만 유효(stale 방어)', () => {
    const tasks = [{ id: 't1' }, { id: 't2' }];
    expect(resolveTargetTaskId(tasks, 't2')).toBe('t2');        // 유효 선택
    expect(resolveTargetTaskId(tasks, 'tX')).toBeNull();        // stale(삭제된 task) → 자동 안 됨(2개)
    expect(resolveTargetTaskId([{ id: 't1' }], 'tX')).toBe('t1'); // stale이지만 후보 1개 → 자동
    expect(resolveTargetTaskId([{ id: 't1' }])).toBe('t1');     // 미선택 + 1개 → 자동
    expect(resolveTargetTaskId(tasks)).toBeNull();              // 미선택 + 다수 → 없음
    expect(resolveTargetTaskId([])).toBeNull();                 // 후보 없음
  });
});

describe('task-scope 제안 노출+적용 활성 회귀 (경추 neckFlexion이 안 보이던 버그)', () => {
  it('cervical 활성 + processFeatures에 neckFlexion + task 1개 → 제안 렌더 + 적용 활성', () => {
    // 1) 분석값이 cervical 제안으로 노출되는가 (getModuleSuggestions는 레지스트리 무관, 계약만 사용)
    const features = {
      neckFlexionOver20HoursPerDay: { kind: 'numeric', value: 2.4, confidence: 0.85, autoSuggestAllowed: true, requiresManualReview: false },
    };
    const suggestions = getModuleSuggestions(features, 'cervical');
    expect(suggestions.map((s) => s.featureKey)).toContain('neckFlexionOver20HoursPerDay');
    const s = suggestions[0];

    // 2) 대상 task 1개 → 자동 지정 → 적용 비활성 아님(noTarget=false), 저신뢰 아님(refOnly=false)
    const moduleData = { tasks: [{ id: 'tk1', name: '용접', sharedJobId: 'jobA' }] };
    const tasks = tasksForJob(moduleData, 'jobA');
    const targetTaskId = resolveTargetTaskId(tasks, undefined);
    expect(targetTaskId).toBe('tk1');
    const noTarget = !targetTaskId;
    const refOnly = s.autoSuggestAllowed === false;
    expect(noTarget).toBe(false);
    expect(refOnly).toBe(false); // 적용 버튼 활성 조건(busy/applyBlocked 외)
  });
});
