import { describe, it, expect } from 'vitest';
import {
  createVideoAnalysisData,
  createSharedData,
  createSamplePatient,
  ensureSharedDefaults,
  migratePatient,
  migratePatients,
} from '../data.js';
// 계약 소스(TS)를 직접 import — 생성물(shared/dist) 의존 없이 schema↔factory drift 검증.
import { VideoAnalysisDataSchema } from '../../../../shared/contracts/videoAnalysis';

describe('createVideoAnalysisData()', () => {
  it('matches the shared contract VideoAnalysisDataSchema default shape (no drift)', () => {
    const factory = createVideoAnalysisData();
    const schemaDefault = VideoAnalysisDataSchema.parse({});
    expect(factory).toEqual(schemaDefault);
  });

  it('is parseable by the contract schema', () => {
    expect(() => VideoAnalysisDataSchema.parse(createVideoAnalysisData())).not.toThrow();
  });

  it('contains no file-path keys (§8.11 — temp paths never in JSONB)', () => {
    const v = createVideoAnalysisData();
    expect(v.clips).toEqual([]);
    expect(JSON.stringify(v)).not.toMatch(/upload_path|uploadPath|filePath/i);
  });
});

describe('createSharedData()', () => {
  it('includes videoAnalysis by default', () => {
    expect(createSharedData().videoAnalysis).toEqual(createVideoAnalysisData());
  });
});

describe('ensureSharedDefaults()', () => {
  it('injects videoAnalysis into a new-format patient that lacks it (early-return regression)', () => {
    // 신형식 + shared.jobs 존재 → migrateJobsToShared는 조기 반환하던 케이스
    const patient = {
      id: 'p1',
      createdAt: '2024-01-01T00:00:00.000Z',
      data: {
        shared: { jobs: [{ id: 'j1', jobName: 'x' }] },
        modules: { knee: { jobExtras: [] } },
        activeModules: ['knee'],
      },
    };
    const out = ensureSharedDefaults(patient);
    expect(out.data.shared.videoAnalysis).toEqual(createVideoAnalysisData());
    // 기존 jobs 보존
    expect(out.data.shared.jobs).toEqual([{ id: 'j1', jobName: 'x' }]);
  });

  it('backfills jobs when missing', () => {
    const out = ensureSharedDefaults({ data: { shared: {}, modules: {}, activeModules: [] } });
    expect(Array.isArray(out.data.shared.jobs)).toBe(true);
    expect(out.data.shared.jobs).toHaveLength(1);
  });

  it('is a no-op (returns same ref) when defaults already present', () => {
    const patient = {
      data: {
        shared: { jobs: [{ id: 'j1' }], videoAnalysis: createVideoAnalysisData() },
        modules: {},
        activeModules: [],
      },
    };
    expect(ensureSharedDefaults(patient)).toBe(patient);
  });

  it('does not touch invalid/redacted-like input without data', () => {
    const p = { redacted: true };
    expect(ensureSharedDefaults(p)).toBe(p);
  });
});

describe('migratePatient() — videoAnalysis backfill', () => {
  it('new-format file WITHOUT videoAnalysis → injected (the bug this PR fixes)', () => {
    const legacy = {
      id: 'p2',
      createdAt: '2024-01-01T00:00:00.000Z',
      data: {
        shared: {
          name: '기존환자',
          jobs: [{ id: 'j1', jobName: '용접공', workDaysPerYear: 250 }],
        },
        modules: { spine: { tasks: [{ id: 1, posture: 'G1', frequency: 80 }] } },
        activeModules: ['spine'],
      },
    };
    const out = migratePatient(legacy);
    expect(out.data.shared.videoAnalysis).toEqual(createVideoAnalysisData());
    // 기존 모듈/잡 무파손
    expect(out.data.modules.spine.tasks[0].posture).toBe('G1');
    expect(out.data.shared.jobs[0].jobName).toBe('용접공');
    expect(out.data.activeModules).toEqual(['spine']);
  });

  it('old-format (moduleId + data.module) → jobs and videoAnalysis both present', () => {
    const old = {
      id: 'p3',
      moduleId: 'knee',
      data: {
        shared: { name: '구형환자' },
        module: {
          jobs: [{ id: 'jx', jobName: '배관공', squatting: '120', weight: '20' }],
        },
      },
    };
    const out = migratePatient(old);
    expect(out.data.activeModules).toEqual(['knee']);
    expect(out.data.shared.videoAnalysis).toEqual(createVideoAnalysisData());
    expect(Array.isArray(out.data.shared.jobs)).toBe(true);
    expect(out.data.shared.jobs.length).toBeGreaterThan(0);
    // 무릎 jobExtras로 이동했는지(기존 마이그레이션 동작 보존)
    expect(out.data.modules.knee.jobExtras[0].squatting).toBe('120');
  });

  it('leaves redacted patients untouched', () => {
    const r = { redacted: true, data: { shared: {} } };
    expect(migratePatient(r)).toBe(r);
  });

  it('migratePatients() backfills across an array', () => {
    const arr = [
      { id: 'a', createdAt: 'x', data: { shared: { jobs: [] }, modules: {}, activeModules: [] } },
      { id: 'b', createdAt: 'x', data: { shared: { jobs: [] }, modules: {}, activeModules: [] } },
    ];
    const out = migratePatients(arr);
    expect(out.every(p => !!p.data.shared.videoAnalysis)).toBe(true);
  });
});

describe('createSamplePatient()', () => {
  it('has a parseable videoAnalysis with a sample process', () => {
    const p = createSamplePatient();
    expect(() => VideoAnalysisDataSchema.parse(p.data.shared.videoAnalysis)).not.toThrow();
    expect(p.data.shared.videoAnalysis.processes).toHaveLength(1);
  });

  it('round-trips through migratePatient without losing existing data', () => {
    const migrated = migratePatient(createSamplePatient());
    expect(migrated.data.modules.knee.jobExtras).toHaveLength(2);
    expect(migrated.data.modules.spine.tasks).toHaveLength(5);
    expect(migrated.data.shared.videoAnalysis.processes).toHaveLength(1);
  });
});
