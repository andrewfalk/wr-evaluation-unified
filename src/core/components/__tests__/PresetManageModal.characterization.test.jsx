// @vitest-environment jsdom
//
// 특성화 테스트(P2-48, Phase 2 C5·C6) — 프리셋 저장 창이 지금 그리는 미리보기와 저장 값을 고정한다.
// 뒤 PR(P2-50)이 `presetConfig.fields: 'tasks'`를 `taskList` 필드로 바꾸고 죽은 미리보기 함수를
// 지울 때 화면이 그대로인지 이 테스트로 확인한다. 이 테스트는 "지금 어떻게 보이는가"를 적을 뿐
// 그것이 옳은지는 판단하지 않는다 — 경추 프리셋이 작업 이름만 보이는 것은 결함 후보(계획 결함 후보 1).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import '../../../modules/knee';
import '../../../modules/spine';
import '../../../modules/cervical';
import { PresetManageModal } from '../PresetManageModal.jsx';

afterEach(cleanup);

const JOB_ID = 'job-1';

function makePatient(activeModules, modules) {
  return {
    id: 'p1',
    data: {
      shared: { jobs: [{ id: JOB_ID, jobName: '조립원' }] },
      modules,
      activeModules,
    },
  };
}

function renderModal(props) {
  const onSave = vi.fn();
  const view = render(
    <PresetManageModal
      jobId={JOB_ID}
      presets={[]}
      onSave={onSave}
      onClose={() => {}}
      session={null}
      {...props}
    />,
  );
  return { ...view, onSave };
}

// 모듈 한 칸(.preset-module-section)이 그린 미리보기를 읽기 쉬운 모양으로.
function readSections(container) {
  return [...container.querySelectorAll('.preset-module-section')].map(section => ({
    header: section.querySelector('.preset-module-header')?.textContent,
    hasPreview: Boolean(section.querySelector('.preset-field-preview')),
    source: section.querySelector('.preset-preview-source')?.textContent ?? null,
    rows: [...section.querySelectorAll('.preset-preview-row')].map(row => [
      row.querySelector('.preset-preview-label')?.textContent,
      row.querySelector('.preset-preview-value')?.textContent,
    ]),
    tasks: [...section.querySelectorAll('.preset-task-card')].map(card => ({
      title: card.querySelector('.preset-task-title')?.textContent,
      chips: [...card.querySelectorAll('.preset-task-chip')].map(chip => chip.textContent),
    })),
  }));
}

const KNEE_EXTRA = {
  sharedJobId: JOB_ID,
  weight: '1500',
  squatting: '120',
  stairs: true,
  kneeTwist: false,
  startStop: true,
  tightSpace: false,
  kneeContact: false,
  jumpDown: false,
};

const SPINE_TASKS = [
  { id: 't1', sharedJobId: JOB_ID, name: '박스 들기', posture: 'G3', weight: 15, frequency: 40, timeValue: 2, timeUnit: 'sec', correctionFactor: 1.2 },
  { id: 't2', sharedJobId: JOB_ID, name: '운반', posture: 'G6', weight: 0, frequency: null, timeValue: 0, timeUnit: 'min', correctionFactor: 0 },
  { id: 't3', sharedJobId: 'other-job', name: '다른 직업 작업', posture: 'G1', weight: 5, frequency: 1, timeValue: 1, timeUnit: 'sec', correctionFactor: 1 },
];

const CERVICAL_TASKS = [
  {
    id: 'c1', sharedJobId: JOB_ID, name: '모니터 작업', exposure_types: ['forced_neck_posture'],
    load_weight_kg: '10', carry_hours_per_shift: '1', forced_neck_posture: 'yes',
    neck_nonneutral_hours_per_day: '3', combined_flexion_rotation_posture: 'no', precision_work: 'yes', notes: '메모',
  },
];

describe('PresetManageModal — 미리보기(특성화)', () => {
  it('필드형(knee): 값이 있는 필드만 라벨·표시값 줄로 그린다(불리언은 Y/N)', () => {
    const { container } = renderModal({
      patient: makePatient(['knee'], { knee: { jobExtras: [KNEE_EXTRA] } }),
    });
    expect(readSections(container)).toEqual([
      {
        header: '🏃무릎 신체부담',
        hasPreview: true,
        source: null,
        rows: [
          ['중량물 (kg/일)', '1500'],
          ['쪼그려앉기 (분/일)', '120'],
          ['계단오르내리기', 'Y'],
          ['무릎 비틀림', 'N'],
          ['출발/정지 반복', 'Y'],
          ['좁은 공간', 'N'],
          ['무릎 접촉/충격', 'N'],
          ['뛰어내리기', 'N'],
        ],
        tasks: [],
      },
    ]);
  });

  it('필드형(knee): 빈 문자열·null·없는 필드는 줄을 그리지 않는다(false·0은 그린다)', () => {
    const { container } = renderModal({
      patient: makePatient(['knee'], {
        knee: { jobExtras: [{ sharedJobId: JOB_ID, weight: '', squatting: null, stairs: false, kneeTwist: 0 }] },
      }),
    });
    expect(readSections(container)).toEqual([
      {
        header: '🏃무릎 신체부담',
        hasPreview: true,
        source: null,
        rows: [
          ['계단오르내리기', 'N'],
          ['무릎 비틀림', 'N'],
        ],
        tasks: [],
      },
    ]);
  });

  it('tasks형(spine): 이 직업의 작업만 카드로, 칩은 자세·중량·횟수·시간·보정(0/빈 시간·보정은 생략)', () => {
    const { container } = renderModal({
      patient: makePatient(['spine'], { spine: { tasks: SPINE_TASKS } }),
    });
    expect(readSections(container)).toEqual([
      {
        header: '⚕️척추 작업목록',
        hasPreview: true,
        source: null,
        rows: [],
        tasks: [
          { title: '박스 들기', chips: ['G3', '15kg', '40회', '2sec', '보정 1.2'] },
          { title: '운반', chips: ['G6', '0kg'] },
        ],
      },
    ]);
  });

  it('tasks형(cervical): 지금은 작업 이름만 보이고 칩이 없다(spine 필드만 그리기 때문)', () => {
    const { container } = renderModal({
      patient: makePatient(['cervical'], { cervical: { tasks: CERVICAL_TASKS } }),
    });
    expect(readSections(container)).toEqual([
      {
        header: '👤경추 작업목록',
        hasPreview: true,
        source: null,
        rows: [],
        tasks: [{ title: '모니터 작업', chips: [] }],
      },
    ]);
  });

  it('tasks형인데 저장된 프리셋에 tasks가 없으면 미리보기를 그리지 않는다', () => {
    const editingPreset = {
      id: 'preset-1',
      source: 'custom',
      jobName: '조립원',
      category: '제조업',
      modules: { spine: { note: 'tasks 키가 없는 옛 데이터' } },
    };
    const { container } = renderModal({
      patient: makePatient(['spine'], { spine: { tasks: [] } }),
      presets: [editingPreset],
      editingPreset,
    });
    expect(readSections(container)).toEqual([
      {
        header: '⚕️척추 작업목록기존 프리셋 데이터 유지',
        hasPreview: false,
        source: null,
        rows: [],
        tasks: [],
      },
    ]);
  });

  it('저장된 프리셋 값만 있는 tasks형은 "그대로 유지" 안내와 함께 그린다', () => {
    const editingPreset = {
      id: 'preset-2',
      source: 'custom',
      jobName: '조립원',
      category: '제조업',
      modules: { spine: { tasks: [{ name: '저장된 작업', posture: 'G2', weight: 3, frequency: 2 }] } },
    };
    const { container } = renderModal({
      patient: makePatient(['spine'], { spine: { tasks: [] } }),
      presets: [editingPreset],
      editingPreset,
    });
    expect(readSections(container)).toEqual([
      {
        header: '⚕️척추 작업목록기존 프리셋 데이터 유지',
        hasPreview: true,
        source: '기존 프리셋에 저장된 값을 그대로 유지 중입니다.',
        rows: [],
        tasks: [{ title: '저장된 작업', chips: ['G2', '3kg', '2회'] }],
      },
    ]);
  });
});

describe('PresetManageModal — 저장 값(특성화)', () => {
  it('새 프리셋 저장: onSave에 넘기는 프리셋과 모듈 목록', () => {
    const { onSave } = renderModal({
      patient: makePatient(['knee', 'spine', 'cervical'], {
        knee: { jobExtras: [KNEE_EXTRA] },
        spine: { tasks: SPINE_TASKS },
        cervical: { tasks: CERVICAL_TASKS },
      }),
    });
    fireEvent.click(screen.getByRole('button', { name: '프리셋 저장' }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]).toEqual([
      {
        id: undefined,
        revision: undefined,
        visibility: 'private',
        jobName: '조립원',
        category: '미분류',
        description: '',
        modules: {
          knee: {
            weight: '1500', squatting: '120', stairs: true, kneeTwist: false,
            startStop: true, tightSpace: false, kneeContact: false, jumpDown: false,
          },
          spine: {
            tasks: [
              { name: '박스 들기', posture: 'G3', weight: 15, frequency: 40, timeValue: 2, timeUnit: 'sec', correctionFactor: 1.2 },
              { name: '운반', posture: 'G6', weight: 0, frequency: null, timeValue: 0, timeUnit: 'min', correctionFactor: 0 },
            ],
          },
          cervical: {
            tasks: [
              {
                name: '모니터 작업', exposure_types: ['forced_neck_posture'], load_weight_kg: '10',
                carry_hours_per_shift: '1', forced_neck_posture: 'yes', neck_nonneutral_hours_per_day: '3',
                combined_flexion_rotation_posture: 'no', precision_work: 'yes', notes: '메모',
              },
            ],
          },
        },
      },
      {
        isUpdate: false,
        existingModuleIds: [],
        selectedModuleIds: ['knee', 'spine', 'cervical'],
        mergedModuleIds: ['knee', 'spine', 'cervical'],
        addedModuleIds: ['knee', 'spine', 'cervical'],
        overlappingModuleIds: [],
        removedModuleIds: [],
        replaceModules: false,
      },
    ]);
  });

  it('저장된 프리셋 수정: 현재 값이 없는 모듈은 저장된 값을 그대로 넘긴다', () => {
    const editingPreset = {
      id: 'preset-3',
      _customId: 'preset-3',
      _customRevision: 7,
      source: 'custom',
      jobName: '조립원',
      category: '제조업',
      description: '설명',
      modules: { spine: { tasks: [{ name: '저장된 작업' }] } },
    };
    const { onSave } = renderModal({
      patient: makePatient(['knee', 'spine'], { knee: { jobExtras: [KNEE_EXTRA] }, spine: { tasks: [] } }),
      presets: [editingPreset],
      editingPreset,
    });
    fireEvent.click(screen.getByRole('button', { name: '프리셋 수정 저장' }));
    expect(onSave.mock.calls[0]).toEqual([
      {
        id: 'preset-3',
        revision: 7,
        visibility: 'private',
        jobName: '조립원',
        category: '제조업',
        description: '설명',
        modules: { spine: { tasks: [{ name: '저장된 작업' }] } },
      },
      {
        isUpdate: true,
        existingModuleIds: ['spine'],
        selectedModuleIds: ['spine'],
        mergedModuleIds: ['spine'],
        addedModuleIds: [],
        overlappingModuleIds: ['spine'],
        removedModuleIds: [],
        replaceModules: true,
      },
    ]);
  });
});
