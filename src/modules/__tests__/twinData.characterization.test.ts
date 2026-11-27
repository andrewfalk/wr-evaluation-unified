// 쌍둥이 데이터 층 특성화(P2-67a, Phase 2 C8) — 팔꿈치·손목을 한 벌로 합치기 전에, 두 모듈의 지금 출력을
// **같은 입력 표**(src/core/fixtures/goldenUpperLimbTwins.json)로 얼린다:
//   · utils/data의 export 이름·상수 표·팩토리(키 순서 포함 — 골든은 JSON 텍스트라 순서까지 고정한다)
//   · BK 추론·상병 판정·분기 초기화·sync(옛 형식·프리셋 대기·대표값 복사·보정 규칙)
//   · presetConfig 추출/적용 · computeCalc/isComplete
//   · batchImportConfig.applyRow(정확한 머리글 + 별칭 + 부분 일치 + 팔꿈치의 옛 키 + 대체값 사슬) — 모달과 같은 runBatchImport로
// 규칙(의도한 출력 변경에서만 갱신, 리팩터링에서는 갱신 금지): src/core/fixtures/goldenEnv.js
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useGoldenEnvironment } from '../../core/fixtures/goldenEnv';
import { loadUpperLimbTwinInputs } from '../../core/fixtures/goldenUpperLimbTwins';
import type { UpperLimbTwinInputs } from '../../core/fixtures/goldenUpperLimbTwins';
import * as elbowData from '../elbow/utils/data';
import * as wristData from '../wrist/utils/data';
import '../index';
import { getAllModules, getModule } from '../../core/moduleRegistry';
import { runBatchImport } from '../../core/services/batchImport';
import { BASE_COLUMNS, buildColMap, normalizeHeader } from '../../core/utils/batchImportHelpers';

type Json = Record<string, unknown>;
type AnyFn = (...args: unknown[]) => unknown;

function goldenJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === 'number' && !Number.isFinite(v) ? `__${v}__` : v), 2) + '\n';
}

// 계산 결과의 표시 항목은 key 속성에 손목 결합 노출 변수 같은 식별자 문자열을 갖는데, 비밀 검사(gitleaks
// generic-api-key)가 이것을 API 키로 오인한다(.gitleaksignore의 calc-wrist.json 항목과 같은 오탐). 무시 목록은 커밋 해시가
// 들어가 squash 뒤에 다시 적어야 하므로, 이 골든에서는 계산 절의 `key` 속성 이름만 `식별자`로 바꿔 적는다(값·순서는 그대로).
function renameKeyProps(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(renameKeyProps);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k === 'key' ? '식별자' : k, renameKeyProps(v)]));
  }
  return value;
}

function fn(mod: object, name: string): AnyFn {
  const value = (mod as Record<string, unknown>)[name];
  if (typeof value !== 'function') throw new Error(`export ${name} 없음`);
  return value as AnyFn;
}

function value(mod: object, name: string): unknown {
  const v = (mod as Record<string, unknown>)[name];
  if (v === undefined) throw new Error(`export ${name} 없음`);
  return v;
}

const BK_TYPES = ['BK2101', 'BK2103', 'BK2105', 'BK2106', 'BK2113'] as const;

// 모듈마다 이름이 다른 export를 같은 역할 이름으로 묶는다(값은 각 모듈의 것 그대로).
const TWINS = [
  {
    id: 'elbow',
    mod: elbowData as object,
    names: {
      createModuleData: 'createElbowModuleData',
      createTemporalSequence: 'createElbowTemporalSequence',
      createDiagnosisEntry: 'createElbowDiagnosisEntry',
      createDiagnosisEvaluation: 'createElbowDiagnosisEvaluation',
      createJobEvaluation: 'createElbowJobEvaluation',
      inferBkType: 'inferElbowBkTypeFromDiagnosis',
      isDiagnosis: 'isElbowDiagnosis',
      resetBranchFields: 'resetElbowBranchFields',
      sync: 'syncElbowModuleData',
      branchFields: 'ELBOW_BRANCH_FIELDS',
    },
  },
  {
    id: 'wrist',
    mod: wristData as object,
    names: {
      createModuleData: 'createWristModuleData',
      createTemporalSequence: 'createWristTemporalSequence',
      createDiagnosisEntry: 'createWristDiagnosisEntry',
      createDiagnosisEvaluation: 'createWristDiagnosisEvaluation',
      createJobEvaluation: 'createWristJobEvaluation',
      inferBkType: 'inferWristBkTypeFromDiagnosis',
      isDiagnosis: 'isWristDiagnosis',
      resetBranchFields: 'resetWristBranchFields',
      sync: 'syncWristModuleData',
      branchFields: 'WRIST_BRANCH_FIELDS',
    },
  },
] as const;

type Twin = (typeof TWINS)[number];

const CONSTANT_NAMES = [
  'BK_TYPE_OPTIONS', 'BK_TYPE_LABELS', 'EXPOSURE_TYPE_OPTIONS', 'EXPOSURE_TYPE_LABELS',
  'PRESSURE_SOURCE_OPTIONS', 'PRESSURE_SOURCE_LABELS', 'VIBRATION_TOOL_OPTIONS', 'VIBRATION_TOOL_LABELS',
];

interface SyncResult { changed: boolean; moduleData: Json; [key: string]: unknown }

// 상태 이름 → 모듈 데이터. 입력 표의 상태 + "BK 유형마다 job-a의 모든 상병을 그 유형(수동)으로 채운 상태".
function buildStates(twin: Twin, inputs: UpperLimbTwinInputs): Record<string, Json> {
  const states: Record<string, Json> = { ...(inputs.moduleStates as Record<string, Json>) };
  const sync = fn(twin.mod, twin.names.sync);
  const both = ['elbow', 'wrist'];
  const moduleDiagnoses = ((sync({}, inputs.jobs, inputs.diagnoses, both) as SyncResult)[`${twin.id}Diagnoses`] as Json[]);
  const createEntry = fn(twin.mod, twin.names.createDiagnosisEntry);
  for (const bk of BK_TYPES) {
    states[`filled-${bk}`] = {
      returnConsiderations: `${bk} 메모`,
      temporalSequence: { recent_task_change: 'yes', task_change_date: '2015-03-01', symptom_onset_interval: 'within_3_months', improves_with_rest: 'yes' },
      jobEvaluations: [{
        sharedJobId: 'job-a',
        diagnosisEntries: moduleDiagnoses.map(diagnosis => ({
          ...(createEntry(diagnosis) as Json),
          ...inputs.commonValues,
          ...(inputs.branchValues as Record<string, Json>)[bk],
          selectedBkType: bk,
          bkSelectionMode: 'manual',
        })),
      }],
    };
  }
  return states;
}

beforeEach(() => {
  useGoldenEnvironment();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('P2-67a — 팔꿈치·손목 데이터 층(같은 입력 표)', () => {
  it.each(TWINS.map(twin => [twin.id, twin] as const))('%s', async (_id, twin) => {
    const inputs = loadUpperLimbTwinInputs();
    const { jobs, diagnoses, activeModuleSets } = inputs;
    const n = twin.names;
    const m = twin.mod;
    const both = ['elbow', 'wrist'];

    const constants: Json = {};
    for (const name of CONSTANT_NAMES) constants[name] = value(m, name);
    constants[n.branchFields] = value(m, n.branchFields);

    const createEntry = fn(m, n.createDiagnosisEntry);
    const factories = {
      createModuleData: fn(m, n.createModuleData)(),
      createTemporalSequence: fn(m, n.createTemporalSequence)(),
      createJobEvaluation: { noArg: fn(m, n.createJobEvaluation)(), jobA: fn(m, n.createJobEvaluation)('job-a') },
      createDiagnosisEvaluation: { noArg: fn(m, n.createDiagnosisEvaluation)(), dx: fn(m, n.createDiagnosisEvaluation)('dx-x') },
      createDiagnosisEntry: {
        noArg: createEntry(),
        ...Object.fromEntries(diagnoses.map(diagnosis => [diagnosis.id, createEntry(diagnosis)])),
      },
      // 팔꿈치에만 있는 옛 이름(createElbowTemporalRelation) — 합친 뒤에도 같은 값을 내야 한다.
      ...(twin.id === 'elbow' ? { createElbowTemporalRelation: fn(m, 'createElbowTemporalRelation')() } : {}),
    };

    const inferBkType = fn(m, n.inferBkType);
    const infer = {
      noArg: inferBkType(),
      ...Object.fromEntries(diagnoses.map(diagnosis => [diagnosis.id, inferBkType(diagnosis)])),
    };

    const isDiagnosis = fn(m, n.isDiagnosis);
    const isDiag: Json = {};
    for (const set of [[], ...activeModuleSets]) {
      isDiag[set.join(',') || '(none)'] = Object.fromEntries(diagnoses.map(diagnosis => [diagnosis.id, isDiagnosis(diagnosis, set)]));
    }
    isDiag.noActiveModulesArg = Object.fromEntries(diagnoses.map(diagnosis => [diagnosis.id, isDiagnosis(diagnosis)]));

    const reset = fn(m, n.resetBranchFields);
    const allValues: Json = { ...(createEntry(diagnoses[0]) as Json), ...inputs.commonValues };
    for (const bk of BK_TYPES) Object.assign(allValues, (inputs.branchValues as Record<string, Json>)[bk]);
    const resetBranchFields: Json = { noArg: reset() };
    for (const bk of ['', ...BK_TYPES]) resetBranchFields[bk || '(empty)'] = reset(allValues, bk);

    const sync = fn(m, n.sync);
    const states = buildStates(twin, inputs);
    const syncOut: Json = {};
    const synced: Record<string, Json> = {};
    for (const [name, state] of Object.entries(states)) {
      const result = sync(state, jobs, diagnoses, both) as SyncResult;
      const again = sync(result.moduleData, jobs, diagnoses, both) as SyncResult;
      synced[name] = result.moduleData;
      const perSet: Json = {};
      for (const set of activeModuleSets) {
        const r = sync(state, jobs, diagnoses, set) as SyncResult;
        perSet[set.join(',')] = {
          changed: r.changed,
          diagnosisIds: (r[`${twin.id}Diagnoses`] as Json[]).map(d => d.id),
        };
      }
      // filled-* 상태는 job-a만 값이 있고 나머지 직력은 empty 상태와 같은 기본 엔트리다 — job-a만 적어 크기를 줄인다.
      syncOut[name] = name.startsWith('filled-')
        ? { changed: result.changed, jobA: (result.moduleData.jobEvaluations as Json[])[0], resyncChanged: again.changed, perActiveModuleSet: perSet }
        : { result, resyncChanged: again.changed, perActiveModuleSet: perSet };
    }
    syncOut['defaults(noArgs)'] = sync();
    syncOut['nullDiagnoses'] = sync(states.donor, jobs, null, both);
    syncOut['noJobs'] = sync(states.donor, [], diagnoses, both);

    const preset = getModule(twin.id).presetConfig;
    const createModuleData = fn(m, n.createModuleData);
    const presetOut: Json = { label: preset.label, fields: preset.fields };
    for (const [name, moduleData] of [...Object.entries(states).map(([k, v]) => [`raw:${k}`, v] as const), ...Object.entries(synced).map(([k, v]) => [`synced:${k}`, v] as const)]) {
      const perJob: Json = {};
      for (const job of jobs) perJob[job.id] = preset.extractFromModule(moduleData, job.id);
      presetOut[name] = perJob;
    }
    const sample = preset.extractFromModule(synced['filled-BK2101'], 'job-a');
    presetOut.apply = {
      sample,
      toFreshModule: preset.applyToModule(createModuleData(), 'job-a', sample),
      inPlace: preset.applyToModule(synced['filled-BK2101'], 'job-a', sample),
      toJobWithoutEntries: preset.applyToModule(states.pendingPreset, 'job-a', sample),
      toOtherJob: preset.applyToModule(synced['filled-BK2101'], 'job-b', sample),
      toMissingJob: preset.applyToModule(synced.donor, 'job-new', sample),
      partialPreset: preset.applyToModule(synced.donor, 'job-a', { daily_exposure_hours: '1', unknown_key: 'x', force_level: undefined }),
      thenSynced: (sync(preset.applyToModule(createModuleData(), 'job-a', sample), jobs, diagnoses, both) as SyncResult).moduleData,
    };

    // 계산은 analytics-core 몫이라(C8은 packages/**를 고치지 않는다) 모듈 매니페스트의 연결만 본다 — BK 유형별로 채운
    // 상태와 옛 형식 상태를, 직력은 job-a(평가)·job-c(미포함) 둘, 상병은 모듈마다 둘로 줄여 계산한다(전체는 크기가 너무 크다).
    const mod = getModule(twin.id);
    const calcJobs = jobs.filter(job => job.id === 'job-a' || job.id === 'job-c');
    const calcDiagnoses = diagnoses.filter(d => ['dx-e2101a', 'dx-e2103', 'dx-w2113', 'dx-w2101a'].includes(d.id));
    const calcOut: Json = {};
    const calcStates = Object.entries(synced).filter(([k]) => k.startsWith('filled-')).map(([k, v]) => [`synced:${k}`, v] as const);
    for (const [name, moduleData] of [...calcStates, ['raw:legacy', states.legacy] as const]) {
      const ctx = { shared: { jobs: calcJobs, diagnoses: calcDiagnoses }, module: moduleData, activeModules: both };
      calcOut[name] = { isComplete: mod.isComplete(ctx), calc: renameKeyProps(mod.computeCalc(ctx)) };
    }

    const result = {
      exports: Object.keys(m).sort(),
      constants,
      factories,
      inferBkType: infer,
      isDiagnosis: isDiag,
      resetBranchFields,
      sync: syncOut,
      preset: presetOut,
      calc: calcOut,
    };
    await expect(goldenJson(result)).toMatchFileSnapshot(`./__goldens__/twin-data-${twin.id}.json`);
  });
});

// 일괄 가져오기 — 모달이 쓰는 runBatchImport로 행을 넣는다. 머리글 묶음마다 팔꿈치·손목 열을 다르게 고른다
// (후보 첫째·둘째·마지막, 부분 일치, 대체값 사슬, 옛 키). 열 배정(colMap)도 같이 얼린다 — 열 표의 순서·별칭이 바뀌면
// 조용히 다른 열을 읽게 되므로(K6).
describe('P2-67a — 팔꿈치·손목 일괄 가져오기(applyRow)', () => {
  it('머리글 묶음별 colMap과 가져온 환자', async () => {
    const inputs = loadUpperLimbTwinInputs();
    const batchInput = inputs.batchImport;
    const values = batchInput.values as Record<string, unknown>;
    const modules = ['elbow', 'wrist'].map(id => ({ id, columns: getModule(id).batchImportConfig.columns as Record<string, string[]> }));

    // 머리글 묶음: 이름 → (모듈, 열 키, 후보 목록) → 머리글 문자열(없으면 그 열을 빼고, 값 덮기는 overrides).
    type Pick = (key: string, candidates: string[]) => string | null;
    const pickCandidate = (i: number): Pick => (_key, candidates) => candidates[Math.min(i, candidates.length - 1)];
    const only = (suffixes: string[]): Pick => (key, candidates) => (suffixes.some(s => key.endsWith(s)) ? candidates[0] : null);
    const headerSets: Array<{ name: string; pick: Pick; overrides?: Record<string, unknown> }> = [
      { name: 'candidate-1st', pick: pickCandidate(0) },
      { name: 'candidate-2nd', pick: pickCandidate(1) },
      { name: 'candidate-last', pick: pickCandidate(99) },
      { name: 'partial-suffix', pick: (_key, candidates) => `${candidates[0]}${batchInput.partialSuffix}` },
      { name: 'excel-serial-date', pick: pickCandidate(0), overrides: { TaskChangeDate: batchInput.excelSerialTaskChangeDate } },
      { name: 'tool-pressing-from-grip', pick: (key, candidates) => (key.endsWith('Bk2103ToolPressing') ? null : candidates[0]) },
      {
        name: 'tool-pressing-from-bk2106',
        pick: (key, candidates) => (key.endsWith('Bk2103ToolPressing') || key.endsWith('Bk2103FrequentHighForceGrip') ? null : candidates[0]),
      },
      {
        name: 'legacy-keys-only',
        pick: only(['BkType', 'Bk2105RepeatedFrictionImpact', 'Bk2106RepeatedMechanicalExposure', 'Bk2106NoncorrectablePosture',
          'Bk2106ProlongedJointPosition', 'Bk2106FrequentHighForceGrip', 'Bk2103HandheldOrGuided', 'Bk2106ToolPressing']),
      },
      { name: 'no-module-data', pick: only(['DailyExposureHours', 'Bk2101Monotony']) },
    ];

    const out: Json = {};
    for (const set of headerSets) {
      const baseHeaders = Object.keys(batchInput.baseRow);
      const moduleCols: Array<{ header: string; suffix: string }> = [];
      for (const { id, columns } of modules) {
        for (const [key, candidates] of Object.entries(columns)) {
          const header = set.pick(key, candidates);
          if (header) moduleCols.push({ header, suffix: key.slice(id.length) });
        }
      }
      const headers = [...baseHeaders, ...moduleCols.map(c => c.header)];
      const rows: unknown[][] = [headers];
      for (const rowSpec of batchInput.rows) {
        const spec = rowSpec as Record<string, unknown>;
        const base = { ...batchInput.baseRow, ...spec } as Record<string, unknown>;
        const blank = spec.__blankModuleValues === true;
        rows.push([
          ...baseHeaders.map(h => base[h]),
          ...moduleCols.map(c => (blank ? '' : (set.overrides && c.suffix in set.overrides ? set.overrides[c.suffix] : values[c.suffix]))),
        ]);
      }

      const colMapAll = buildColMap(rows[0].map(normalizeHeader), [
        BASE_COLUMNS,
        ...(getAllModules() as Array<{ batchImportConfig?: { columns?: Record<string, string[]> } }>)
          .filter(mod => mod.batchImportConfig)
          .map(mod => mod.batchImportConfig?.columns || {}),
      ]) as Record<string, number>;
      const colMap = Object.fromEntries(
        Object.entries(colMapAll).filter(([key]) => key.startsWith('elbow') || key.startsWith('wrist')),
      );
      // 팔꿈치·손목 머리글을 다른 모듈·기본 열이 가져갔는지도 본다.
      const moduleHeaderIndexes = new Set(moduleCols.map((_c, i) => baseHeaders.length + i));
      const takenByOthers = Object.fromEntries(
        Object.entries(colMapAll).filter(([key, idx]) => !key.startsWith('elbow') && !key.startsWith('wrist') && moduleHeaderIndexes.has(idx)),
      );

      const { newPatients, stats } = runBatchImport({ rows, existingPatients: [], errorRowIndexes: new Set(), session: null });
      out[set.name] = {
        headers: moduleCols.map(c => c.header),
        colMap,
        takenByOthers,
        stats,
        patients: newPatients.map(p => p.data),
      };
    }
    await expect(goldenJson(out)).toMatchFileSnapshot('./__goldens__/twin-batch-import.json');
  });
});
