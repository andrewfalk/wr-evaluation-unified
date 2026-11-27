// @vitest-environment jsdom
//
// 쌍둥이 화면 특성화(P2-67b, Phase 2 C8) — 팔꿈치·손목·무릎·어깨 평가 화면과 경추·척추 결과 패널, 기본정보 직력 카드 제목을
// vi.mock 없이 **실제로** 그려 지금 화면을 얼린다. 뒤따르는 safe PR(공용 코드로 합치기)의 안전망이다.
//   · props는 앱과 같은 모양: patient.data = { shared, module }(activeModules 없음 — StepContent.jsx), calc = computeCalc({ shared, module })
//     (src/testing/renderEvaluation.tsx). updateModule은 상태를 바꿔 다시 그린다(앱처럼 마운트 sync가 반영된 화면이 남는다).
//   · DOM은 한 요소 한 줄로 직렬화하고, 제어되는 폼 상태(select.value·checked·value)를 따로 적는다.
//   · 조작 사례: 노출 입력 화면의 핸들러(BK 유형 변경 시 기증자 복사·분기 초기화, 노출 유형 토글, 대표값 일괄 적용, 라디오·
//     입력·다중 선택, 시간적 선후관계) — 조작 → updateModule이 만든 결과에서 바뀐 엔트리를 적는다.
// 입력: 골든·보강 환자(goldenPatients*.json) + 쌍둥이 입력 표(goldenUpperLimbTwins.json)로 만든 사례.
// 규칙(의도한 출력 변경에서만 갱신, 리팩터링에서는 갱신 금지): src/core/fixtures/goldenEnv.js
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { useGoldenEnvironment } from '../../core/fixtures/goldenEnv';
import { loadGoldenBatchPatients, loadGoldenNarrativePatients, loadGoldenPatients } from '../../core/fixtures/goldenPatients';
import { loadUpperLimbTwinInputs } from '../../core/fixtures/goldenUpperLimbTwins';
import { formState, renderEvaluation, serializeDom } from '../../testing/renderEvaluation';
import type { EvaluationManifestLike } from '../../testing/renderEvaluation';
import '../index';
import { getModule } from '../../core/moduleRegistry';
import { CervicalResultPanel } from '../cervical/components/CervicalResultPanel';
import { SpineResultPanel } from '../spine/components/SpineResultPanel';
import { VibrationResultPanel } from '../spine/components/VibrationResultPanel';
import { BasicInfoForm } from '../../core/components/BasicInfoForm';

type Fields = Record<string, unknown>;
interface FixturePatient { id: string; data: { shared: Fields; modules: Record<string, Fields | undefined>; activeModules: string[] } }

function goldenJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}

beforeEach(() => {
  useGoldenEnvironment();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function allFixturePatients(): Array<{ source: string; patient: FixturePatient }> {
  return [
    ...(loadGoldenPatients() as FixturePatient[]).map(patient => ({ source: 'golden', patient })),
    ...(loadGoldenBatchPatients() as FixturePatient[]).map(patient => ({ source: 'batch', patient })),
    ...(loadGoldenNarrativePatients() as FixturePatient[]).map(patient => ({ source: 'narrative', patient })),
  ];
}

function fixtureCases(moduleId: string): Array<{ name: string; shared: Fields; module: Fields | undefined; errors?: unknown }> {
  return allFixturePatients()
    .filter(({ patient }) => patient.data.activeModules.includes(moduleId))
    .map(({ source, patient }) => ({ name: `${source}:${patient.id}`, shared: patient.data.shared, module: patient.data.modules[moduleId] }));
}

function manifestOf(moduleId: string): EvaluationManifestLike {
  return getModule(moduleId) as EvaluationManifestLike;
}

function snapshotRender(moduleId: string, c: { shared: Fields; module: Fields | undefined; errors?: unknown }) {
  const view = renderEvaluation({ manifest: manifestOf(moduleId), shared: c.shared, module: c.module, errors: c.errors ?? null, activeTab: getModule(moduleId).tabs[0].id });
  const out = { mountUpdates: view.updates.length, dom: serializeDom(view.container), form: formState(view.container) };
  view.unmount();
  return out;
}

// ── 팔꿈치·손목: 쌍둥이 입력 표로 만든 화면 사례 ────────────────────────────────────────────────────
interface UpperLimbCfg {
  id: 'elbow' | 'wrist';
  prefix: string;
  groupCodes: [string, string]; // 같은 BK2101로 묶이는 두 상병
  filledCode: string; // 값이 채워진 개별 카드(BK2103)
  emptyCode: string; // 값이 빈 개별 카드
  diagnosisIds: string[];
  exposureLabels: { force: string; awkward: string; repetition: string };
}

const UPPER_LIMB: UpperLimbCfg[] = [
  {
    id: 'elbow',
    prefix: 'elbow',
    groupCodes: ['M77.0', 'M77.1'],
    filledCode: 'T75.2',
    emptyCode: 'M70.2',
    diagnosisIds: ['dx-e2101a', 'dx-e2101b', 'dx-e2103', 'dx-e2105'],
    exposureLabels: { force: '힘 사용', awkward: '비중립 자세', repetition: '반복 동작' },
  },
  {
    id: 'wrist',
    prefix: 'wrist',
    groupCodes: ['M65.4', 'M65.3'],
    filledCode: 'M19.04',
    emptyCode: 'G56.0',
    diagnosisIds: ['dx-w2101a', 'dx-w2101b', 'dx-w2103', 'dx-w2113'],
    exposureLabels: { force: '힘 사용', awkward: '부자연스러운 자세', repetition: '반복 동작' },
  },
];

// job-a: BK2101 두 상병(값이 서로 다름 → 대표값 불일치 안내), BK2103 상병(채움), 빈 상병. job-b(빈 직종명·기간 0)는 빈 엔트리, job-c는 미포함.
function scenario(cfg: UpperLimbCfg) {
  const inputs = loadUpperLimbTwinInputs();
  const diagnoses = inputs.diagnoses.filter(d => cfg.diagnosisIds.includes(d.id));
  const [g1, g2, filled, empty] = cfg.diagnosisIds;
  const common = { ...inputs.commonValues, exposure_types: ['repetition', 'force'] };
  const module = {
    returnConsiderations: '',
    temporalSequence: { recent_task_change: 'increased_load', task_change_date: '2015-03-01', symptom_onset_interval: '', improves_with_rest: 'yes' },
    jobEvaluations: [
      {
        sharedJobId: 'job-a',
        diagnosisEntries: [
          { diagnosisId: g1, selectedBkType: 'BK2101', bkSelectionMode: 'auto', ...common, ...inputs.branchValues.BK2101 },
          { diagnosisId: g2, selectedBkType: 'BK2101', bkSelectionMode: 'auto', ...common, ...inputs.branchValues.BK2101, main_task_name: '다른 작업' },
          { diagnosisId: filled, selectedBkType: 'BK2103', bkSelectionMode: 'manual', ...common, ...inputs.branchValues.BK2103 },
          { diagnosisId: empty, selectedBkType: cfg.id === 'elbow' ? 'BK2105' : 'BK2113', bkSelectionMode: 'auto' },
        ],
      },
    ],
  };
  return { shared: { jobs: inputs.jobs, diagnoses }, module };
}

function upperLimbRenderCases(cfg: UpperLimbCfg) {
  const s = scenario(cfg);
  const jobs = s.shared.jobs as Fields[];
  return [
    { name: 'twin:scenario', ...s },
    { name: 'twin:errorsJobs', ...s, errors: { jobs: '직업을 1개 이상 입력해 주세요.' } },
    { name: 'twin:noDiagnoses', shared: { ...s.shared, diagnoses: [] }, module: s.module },
    { name: 'twin:noJobs', shared: { ...s.shared, jobs: [] }, module: s.module },
    { name: 'twin:allExcluded', shared: { ...s.shared, jobs: jobs.map(job => ({ ...job, excludeFromAnalysis: true })) }, module: s.module },
    { name: 'twin:emptyModule', shared: s.shared, module: undefined },
  ];
}

function jobCard(container: HTMLElement, cfg: UpperLimbCfg): Element {
  const card = container.querySelector(`.job-card.${cfg.prefix}-job-card`);
  if (!card) throw new Error('직력 카드 없음');
  return card;
}

function diagnosisCard(container: HTMLElement, cfg: UpperLimbCfg, code: string): Element {
  const card = Array.from(jobCard(container, cfg).querySelectorAll('.diagnosis-card'))
    .find(el => (el.querySelector('.diagnosis-card-header')?.textContent || '').includes(code));
  if (!card) throw new Error(`상병 카드 없음: ${code}`);
  return card;
}

function inputByLabel(card: Element, text: string): HTMLInputElement {
  const label = Array.from(card.querySelectorAll('label')).find(el => el.querySelector('input') && (el.textContent || '').trim() === text);
  const input = label?.querySelector('input');
  if (!input) throw new Error(`선택지 없음: ${text}`);
  return input;
}

function radio(card: Element, namePrefix: string, value: string): HTMLInputElement {
  const input = Array.from(card.querySelectorAll<HTMLInputElement>('input[type="radio"]'))
    .find(el => el.name.startsWith(namePrefix) && el.value === value);
  if (!input) throw new Error(`라디오 없음: ${namePrefix}=${value}`);
  return input;
}

// 바뀐 것만: 엔트리(직력·상병별, 바뀐 뒤 전체 — 키 순서 포함)와 그 밖의 최상위 값.
function changedParts(before: Fields, after: Fields) {
  const out: Fields = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key === 'jobEvaluations') continue;
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) out[key] = after[key] ?? null;
  }
  const entryMap = (data: Fields) => {
    const map = new Map<string, unknown>();
    for (const jobEval of (data.jobEvaluations as Fields[] | undefined) || []) {
      for (const entry of (jobEval.diagnosisEntries as Fields[] | undefined) || []) map.set(`${jobEval.sharedJobId}:${entry.diagnosisId}`, entry);
    }
    return map;
  };
  const a = entryMap(before);
  const b = entryMap(after);
  const entries: Fields = {};
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    if (JSON.stringify(a.get(key)) !== JSON.stringify(b.get(key))) entries[key] = b.get(key) ?? null;
  }
  out.entries = entries;
  // 엔트리 내용은 그대로인데 순서만 바뀌거나 직력별 다른 필드가 바뀐 경우도 잡는다(Codex P2-67b 1회차 권고).
  const shape = (data: Fields) => ((data.jobEvaluations as Fields[] | undefined) || []).map(jobEval => {
    const { diagnosisEntries, ...rest } = jobEval;
    return { ...rest, diagnosisIds: ((diagnosisEntries as Fields[] | undefined) || []).map(entry => entry.diagnosisId) };
  });
  if (JSON.stringify(shape(before)) !== JSON.stringify(shape(after))) out.jobEvaluationsShape = shape(after);
  return out;
}

type Action = (container: HTMLElement, cfg: UpperLimbCfg) => void;

const select = (el: Element | null, value: string) => {
  if (!(el instanceof HTMLSelectElement)) throw new Error('select 없음');
  fireEvent.change(el, { target: { value } });
};

const ACTIONS: Array<[string, Action]> = [
  ['entryBkChangeWithDonor', (c, cfg) => select(diagnosisCard(c, cfg, cfg.emptyCode).querySelector('select'), 'BK2101')],
  ['entryBkChangeWithoutDonor', (c, cfg) => select(diagnosisCard(c, cfg, cfg.emptyCode).querySelector('select'), 'BK2106')],
  ['entryBkClear', (c, cfg) => select(diagnosisCard(c, cfg, cfg.filledCode).querySelector('select'), '')],
  ['groupBkChangeWithDonor', (c, cfg) => select(diagnosisCard(c, cfg, cfg.groupCodes[0]).querySelector('select'), 'BK2103')],
  ['groupBkChangeWithoutDonor', (c, cfg) => select(diagnosisCard(c, cfg, cfg.groupCodes[0]).querySelector('select'), 'BK2106')],
  ['groupApplyRepresentative', (c, cfg) => {
    const button = Array.from(diagnosisCard(c, cfg, cfg.groupCodes[0]).querySelectorAll('button')).find(el => (el.textContent || '').includes('대표값'));
    if (!button) throw new Error('대표값 버튼 없음');
    fireEvent.click(button);
  }],
  ['entryExposureToggleOff', (c, cfg) => fireEvent.click(inputByLabel(diagnosisCard(c, cfg, cfg.filledCode), cfg.exposureLabels.force))],
  ['entryExposureToggleOn', (c, cfg) => fireEvent.click(inputByLabel(diagnosisCard(c, cfg, cfg.filledCode), cfg.exposureLabels.awkward))],
  ['groupExposureToggleOff', (c, cfg) => fireEvent.click(inputByLabel(diagnosisCard(c, cfg, cfg.groupCodes[0]), cfg.exposureLabels.repetition))],
  ['entryDirectLinkNo', (c, cfg) => fireEvent.click(radio(diagnosisCard(c, cfg, cfg.filledCode), 'direct_anatomic_link_', 'no'))],
  ['entryForceLevelMild', (c, cfg) => fireEvent.click(radio(diagnosisCard(c, cfg, cfg.filledCode), 'force_level_', 'mild'))],
  ['entryDailyHours', (c, cfg) => {
    const input = Array.from(diagnosisCard(c, cfg, cfg.filledCode).querySelectorAll<HTMLInputElement>('input[type="number"]'))[0];
    fireEvent.change(input, { target: { value: '7' } });
  }],
  ['groupTaskName', (c, cfg) => {
    const input = diagnosisCard(c, cfg, cfg.groupCodes[0]).querySelector<HTMLInputElement>('input:not([type])');
    if (!input) throw new Error('작업명 칸 없음');
    fireEvent.change(input, { target: { value: '새 작업명' } });
  }],
  ['entryMultiToggleOff', (c, cfg) => fireEvent.click(inputByLabel(diagnosisCard(c, cfg, cfg.filledCode), '그라인더'))],
  ['entryMultiToggleOn', (c, cfg) => fireEvent.click(inputByLabel(diagnosisCard(c, cfg, cfg.filledCode), '기타'))],
  ['temporalRecentTaskChange', (c, cfg) => {
    const input = c.querySelector<HTMLInputElement>(`input[name="${cfg.prefix}_recent_task_change"][value="new_task"]`);
    if (!input) throw new Error('시간적 선후관계 라디오 없음');
    fireEvent.click(input);
  }],
  ['temporalTaskChangeDate', c => {
    const input = c.querySelector<HTMLInputElement>('input[type="date"]');
    if (!input) throw new Error('날짜 칸 없음');
    fireEvent.change(input, { target: { value: '2016-07-01' } });
  }],
];

describe('P2-67b — 팔꿈치·손목 평가 화면', () => {
  it.each(UPPER_LIMB.map(cfg => [cfg.id, cfg] as const))('%s: 첫 렌더', async (_id, cfg) => {
    const result: Fields = {};
    for (const c of [...upperLimbRenderCases(cfg), ...fixtureCases(cfg.id)]) result[c.name] = snapshotRender(cfg.id, c);
    await expect(goldenJson(result)).toMatchFileSnapshot(`./__goldens__/twin-screen-${cfg.id}.json`);
  });

  it.each(UPPER_LIMB.map(cfg => [cfg.id, cfg] as const))('%s: 조작 → updateModule 결과', async (_id, cfg) => {
    const s = scenario(cfg);
    const result: Fields = {};
    for (const [name, action] of ACTIONS) {
      const view = renderEvaluation({ manifest: manifestOf(cfg.id), shared: s.shared, module: s.module, activeTab: 'burden' });
      const before = view.current();
      const mountUpdates = view.updates.length;
      act(() => action(view.container, cfg));
      const after = view.current();
      // 조작 뒤 다시 그린 화면의 폼 상태도 적는다 — 데이터는 맞게 바뀌었는데 화면이 옛 선택값을 보이는 회귀를 잡는다(Codex 2회차 권고).
      result[name] = { updates: view.updates.length - mountUpdates, changed: changedParts(before, after), formAfter: formState(view.container) };
      view.unmount();
    }
    await expect(goldenJson(result)).toMatchFileSnapshot(`./__goldens__/twin-screen-${cfg.id}-actions.json`);
  });
});

describe('P2-67b — 무릎·어깨 평가 화면', () => {
  it.each(['knee', 'shoulder'])('%s', async moduleId => {
    const inputs = loadUpperLimbTwinInputs();
    const extrasOf = (data: Fields | undefined) => ((data?.jobExtras as Fields[] | undefined) || []);
    const cases = [
      { name: 'twin:missingExtras', shared: { jobs: inputs.jobs, diagnoses: [] }, module: { jobExtras: [], returnConsiderations: '' } },
      { name: 'twin:errorsJobs', shared: { jobs: inputs.jobs, diagnoses: [] }, module: { jobExtras: [] }, errors: { jobs: '직업을 1개 이상 입력해 주세요.' } },
      { name: 'twin:noJobs', shared: { jobs: [], diagnoses: [] }, module: { jobExtras: [] } },
      { name: 'twin:allExcluded', shared: { jobs: inputs.jobs.map(job => ({ ...job, excludeFromAnalysis: true })), diagnoses: [] }, module: { jobExtras: [] } },
      ...fixtureCases(moduleId),
    ];
    const result: Fields = {};
    for (const c of cases) {
      const view = renderEvaluation({ manifest: manifestOf(moduleId), shared: c.shared, module: c.module, errors: c.errors ?? null, activeTab: getModule(moduleId).tabs[0].id });
      result[c.name] = {
        mountUpdates: view.updates.length,
        // 마운트 effect가 채운 jobExtras(누락 직력의 extras 자동 생성).
        jobExtrasAfterMount: view.updates.length ? extrasOf(view.current()) : null,
        dom: serializeDom(view.container),
        form: formState(view.container),
      };
      view.unmount();
    }
    await expect(goldenJson(result)).toMatchFileSnapshot(`./__goldens__/twin-screen-${moduleId}.json`);
  });
});

describe('P2-67b — 경추·척추 결과 패널', () => {
  it.each(['cervical', 'spine'])('%s', async moduleId => {
    const mod = getModule(moduleId);
    const result: Fields = {};
    for (const c of fixtureCases(moduleId)) {
      const calc = mod.computeCalc({ shared: c.shared, module: c.module || {} }) as Fields;
      const { container, unmount } = render(
        moduleId === 'cervical'
          ? <CervicalResultPanel calc={calc} />
          : <><SpineResultPanel calc={calc} /><VibrationResultPanel calc={calc?.vibration} /></>,
      );
      result[c.name] = serializeDom(container);
      unmount();
    }
    await expect(goldenJson(result)).toMatchFileSnapshot(`./__goldens__/twin-screen-${moduleId}-result.json`);
  });
});

describe('P2-67b — 기본정보 직력 카드 제목', () => {
  it('모든 골든·보강 환자 + 쌍둥이 직력', async () => {
    const inputs = loadUpperLimbTwinInputs();
    const cases = [
      ...allFixturePatients().map(({ source, patient }) => ({ name: `${source}:${patient.id}`, shared: patient.data.shared, activeModules: patient.data.activeModules })),
      { name: 'twin:jobs', shared: { jobs: inputs.jobs, diagnoses: inputs.diagnoses }, activeModules: ['elbow', 'wrist'] },
    ];
    const result: Fields = {};
    for (const c of cases) {
      const { container, unmount } = render(
        <BasicInfoForm
          shared={c.shared}
          onChange={() => {}}
          errors={null}
          presets={[]}
          presetMeta={undefined}
          presetError={undefined}
          onPresetSelect={undefined}
          onSavePreset={undefined}
          onBrowsePreset={undefined}
          activeModules={c.activeModules}
          session={null}
        />,
      );
      result[c.name] = Array.from(container.querySelectorAll('.job-card-title')).map(el => (el.textContent || '').replace(/\s+/g, ' ').trim());
      unmount();
    }
    await expect(goldenJson(result)).toMatchFileSnapshot('./__goldens__/twin-screen-basicinfo-job-titles.json');
  });
});
