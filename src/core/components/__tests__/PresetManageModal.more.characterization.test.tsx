// @vitest-environment jsdom
//
// 프리셋 저장 창 특성화 보강(P2-88a, Phase 2 C9 구간 A) — 기존 특성화(PresetManageModal.characterization.test.jsx, 미리보기·저장 값
// 8건)가 덮지 않는 것을 화면 그대로 얼린다: 비슷한 프리셋 목록(점수·순서·상위 5개·내 것이 아닌 공유 프리셋 표시), 같은 프리셋이
// 이미 있을 때의 안내, 인트라넷 공개 범위(기본값·바꾸기·저장 값), 남의 프리셋을 연 읽기 전용 분기, 저장된 프리셋 수정·직접 입력
// 카테고리. 뒤따르는 이동(P2-88b-ts)과 미리보기·점수 함수 분리(P2-88c)의 안전망이다. 사용자·소유자는 합성 값이다.
// 규칙(의도한 출력 변경에서만 갱신, 리팩터링에서는 갱신 금지): src/core/fixtures/goldenEnv.js
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { useGoldenEnvironment } from '../../fixtures/goldenEnv';
import { formState, serializeDom } from '../../../testing/renderEvaluation';
import '../../../modules/index';
import { PresetManageModal } from '../PresetManageModal';

type Fields = Record<string, unknown>;

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

const JOB_ID = 'job-1';
const ME = 'synthetic-user-me';
const OTHER = 'synthetic-user-other';

const LOCAL_SESSION = null;
const INTRANET_SESSION = { mode: 'intranet', user: { id: ME, role: 'doctor' } };

const KNEE_EXTRA = {
  sharedJobId: JOB_ID, weight: '1500', squatting: '120', stairs: true, kneeTwist: false,
  startStop: true, tightSpace: false, kneeContact: false, jumpDown: false,
};
const SPINE_TASKS = [
  { id: 't1', sharedJobId: JOB_ID, name: '박스 들기', posture: 'G3', weight: 15, frequency: 40, timeValue: 2, timeUnit: 'sec', correctionFactor: 1.2 },
];

function makePatient(jobName = '조립원') {
  return {
    id: 'p1',
    data: {
      shared: { jobs: [{ id: JOB_ID, jobName }] },
      modules: { knee: { jobExtras: [KNEE_EXTRA] }, spine: { tasks: SPINE_TASKS } },
      activeModules: ['knee', 'spine'],
    },
  };
}

interface PresetCase {
  id: string;
  jobName: string;
  category?: string;
  description?: string;
  source?: string;
  _customId?: string;
  ownerUserId?: string | null;
  ownerName?: string | null;
  visibility?: string | null;
  modules?: Record<string, unknown>;
}

function custom(id: string, jobName: string, extra: Partial<PresetCase> = {}): PresetCase {
  // 소유자 없음 = 로컬에서는 내 것, 인트라넷에서는 남의 것(isOwnPreset). 인트라넷의 내 것은 ownerUserId: ME로 준다.
  return { id, jobName, source: 'custom', _customId: id, ownerUserId: null, modules: { knee: { weight: '10' } }, ...extra };
}

// 비슷한 프리셋 후보 — 점수(직종명 같음 6 / 포함 4 · 카테고리 같음 4 / 포함 2 · 설명 같음 3 / 포함 2 · 겹치는 낱말마다 1)와
// 같은 점수의 가나다 정렬, 상위 5개 자르기, 내장 프리셋·점수 0 제외를 고루 건드린다.
const SIMILAR_PRESETS: PresetCase[] = [
  custom('s1', '조립원 반장', { category: '제조업', modules: { knee: {}, spine: {} } }),
  custom('s2', '조립원(라인)', { category: '제조업', description: '라인 작업' }),
  custom('s3', '포장원', { category: '제조업' }),
  custom('s4', '다조립원', { category: '서비스업' }),
  custom('s5', '가조립원', { category: '서비스업' }),
  custom('s6', '나조립원', { category: '서비스업', description: '라인' }),
  custom('s7', '용접원', { category: '건설업', description: '라인 작업 보조' }),
  custom('s8', '조립', { category: '운수업' }),
  { id: 'b1', jobName: '조립원', category: '제조업', source: 'builtin', modules: { knee: {} } },
  custom('s9', '사무원', { category: '기타' }),
  custom('o1', '조립원 검사', { category: '제조업', ownerUserId: OTHER, ownerName: '합성 동료', visibility: 'organization' }),
  custom('o2', '조립 보조', { category: '제조업', ownerUserId: OTHER, ownerName: null, visibility: 'organization' }),
];

function renderModal(props: { session?: typeof INTRANET_SESSION | null; presets?: PresetCase[]; editingPreset?: PresetCase | null; jobName?: string }) {
  const calls: unknown[] = [];
  const view = render(
    <PresetManageModal
      jobId={JOB_ID}
      patient={makePatient(props.jobName)}
      presets={props.presets || []}
      // JS 컴포넌트의 추론(기본값 `editingPreset = null`)이 타입을 null로 좁힌다 — ModalHost.tsx와 같은 단언.
      editingPreset={(props.editingPreset ?? null) as null}
      onSave={(preset: unknown, meta: unknown) => calls.push({ preset, meta })}
      onClose={() => calls.push('onClose')}
      session={props.session ?? LOCAL_SESSION}
    />,
  );
  return { ...view, calls };
}

function snapshot(container: HTMLElement) {
  return { dom: serializeDom(container), form: formState(container) };
}

function similarList(container: HTMLElement) {
  return Array.from(container.querySelectorAll('.preset-similar-item')).map(item => ({
    name: item.querySelector('.preset-list-name')?.textContent ?? null,
    category: item.querySelector('.preset-list-category')?.textContent ?? null,
    extra: Array.from(item.querySelectorAll('.preset-list-description')).map(el => el.textContent),
    modules: item.querySelector('.preset-list-modules')?.textContent ?? null,
    badge: item.querySelector('.preset-badge')?.textContent ?? null,
  }));
}

function inputByPlaceholder(container: HTMLElement, placeholder: string): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`);
  if (!input) throw new Error(`입력란 없음: ${placeholder}`);
  return input;
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(b => b.textContent === text);
  if (!button) throw new Error(`버튼 없음: ${text}`);
  return button;
}

describe('P2-88a — 프리셋 저장 창', () => {
  it('비슷한 프리셋 목록 — 점수·순서·상위 5개, 입력을 바꿀 때마다', async () => {
    const result: Fields = {};
    const view = renderModal({ presets: SIMILAR_PRESETS });
    result.initial = { list: similarList(view.container), dom: serializeDom(view.container) };
    // 새 프리셋은 카테고리가 기본값('미분류' — 목록에 없다)이라 직접 입력 칸으로 시작한다. 목록 선택으로 바꾼 뒤 고른다.
    const steps: Array<[string, () => void]> = [
      ['toSelectMode', () => fireEvent.click(buttonByText(view.container, '목록선택'))],
      ['category:제조업', () => fireEvent.change(view.container.querySelector('select') as HTMLSelectElement, { target: { value: '제조업' } })],
      ['description:라인 작업', () => fireEvent.change(inputByPlaceholder(view.container, '작업 맥락이나 특징을 간단히 적어주세요'), { target: { value: '라인 작업' } })],
      ['jobName:용접', () => fireEvent.change(inputByPlaceholder(view.container, '직종명을 입력하세요'), { target: { value: '용접' } })],
      ['jobName:empty', () => fireEvent.change(inputByPlaceholder(view.container, '직종명을 입력하세요'), { target: { value: '' } })],
      ['category:empty+description:empty', () => {
        fireEvent.change(view.container.querySelector('select') as HTMLSelectElement, { target: { value: '' } });
        fireEvent.change(inputByPlaceholder(view.container, '작업 맥락이나 특징을 간단히 적어주세요'), { target: { value: '' } });
      }],
    ];
    for (const [name, step] of steps) {
      act(() => { step(); });
      result[name] = { list: similarList(view.container), saveDisabled: buttonByText(view.container, '프리셋 저장').disabled };
    }
    view.unmount();

    // 인트라넷: 남의 공유 프리셋은 "조직 공유 · 소유자 (참고용)"으로, 내 것만 같은 프리셋 판정에 쓴다.
    const intranet = renderModal({ session: INTRANET_SESSION, presets: SIMILAR_PRESETS });
    result.intranet = { list: similarList(intranet.container) };
    intranet.unmount();

    await expect(goldenJson(result)).toMatchFileSnapshot('./__goldens__/preset-manage-similar.json');
  });

  it('같은 프리셋·공개 범위·읽기 전용·수정 분기의 화면과 저장 값', async () => {
    const result: Fields = {};

    // 같은 프리셋이 이미 있다(내 것, 직종명·카테고리·설명이 같다) → 안내 카드, 비슷한 목록 없음, 버튼 '프리셋 업데이트'
    {
      const existing = custom('e1', '조립원', { category: '미분류', modules: { spine: { tasks: [] }, shoulder: { x: 1 } } });
      const view = renderModal({ presets: [existing, ...SIMILAR_PRESETS] });
      const before = snapshot(view.container);
      act(() => { fireEvent.click(buttonByText(view.container, '프리셋 업데이트')); });
      result.existingSame = { ...before, calls: view.calls };
      view.unmount();
    }

    // 같은 이름의 내 프리셋이 하나뿐이면 그것으로 시작한다(카테고리·설명을 채움 — 목록에 없는 카테고리는 직접 입력 칸으로)
    {
      const only = custom('u1', '조립원', { category: '나만의 분류', description: '야간' });
      const view = renderModal({ presets: [only] });
      result.sameNameSingle = snapshot(view.container);
      act(() => { fireEvent.click(buttonByText(view.container, '목록선택')); });
      result.sameNameSingleToSelect = snapshot(view.container);
      view.unmount();
    }

    // 인트라넷 새 프리셋: 공개 범위 기본값 '조직 공유' → '나만 보기'로 바꿔 저장
    {
      const view = renderModal({ session: INTRANET_SESSION });
      const before = snapshot(view.container);
      const privateRadio = view.container.querySelector<HTMLInputElement>('input[name="preset-visibility"][value="private"]');
      if (!privateRadio) throw new Error('나만 보기 라디오 없음');
      act(() => { fireEvent.click(privateRadio); });
      const afterToggle = formState(view.container);
      act(() => { fireEvent.click(buttonByText(view.container, '프리셋 저장')); });
      result.intranetVisibility = { ...before, afterToggle, calls: view.calls };
      view.unmount();
    }

    // 인트라넷에서 내 저장된 프리셋 수정: 저장된 공개 범위(private)로 시작, 공개 범위가 없으면 기본값
    for (const visibility of ['private', null]) {
      const editing = custom('m1', '조립원', { category: '제조업', ownerUserId: ME, visibility, modules: { knee: { weight: '1' }, spine: { tasks: [] } } });
      const view = renderModal({ session: INTRANET_SESSION, presets: [editing], editingPreset: editing });
      const before = snapshot(view.container);
      act(() => { fireEvent.click(buttonByText(view.container, '프리셋 수정 저장')); });
      result[`intranetEditOwn:${visibility ?? 'none'}`] = { ...before, calls: view.calls };
      view.unmount();
    }

    // 인트라넷에서 남의 공유 프리셋을 연 경우: 읽기 전용 안내, 공개 범위 잠금, 저장 버튼 잠금(눌러도 onSave 없음)
    {
      const shared = custom('r1', '조립원 검사', { category: '제조업', ownerUserId: OTHER, ownerName: '합성 동료', visibility: 'organization' });
      const view = renderModal({ session: INTRANET_SESSION, presets: [shared], editingPreset: shared });
      const before = snapshot(view.container);
      act(() => { fireEvent.click(buttonByText(view.container, '프리셋 수정 저장')); });
      result.intranetReadOnly = { ...before, saveDisabled: buttonByText(view.container, '프리셋 수정 저장').disabled, calls: view.calls };
      view.unmount();
    }

    // 로컬에서 저장된 프리셋 수정(소유자 없음 = 내 것): 수정 안내, 공개 범위 없음, 저장 값
    {
      const editing: PresetCase = { id: 'l1', jobName: '조립원', category: '제조업', description: '주간', source: 'custom', _customId: 'l1', modules: { knee: { weight: '2' } } };
      const view = renderModal({ presets: [editing], editingPreset: editing });
      const before = snapshot(view.container);
      act(() => { fireEvent.click(buttonByText(view.container, '프리셋 수정 저장')); });
      result.localEdit = { ...before, calls: view.calls };
      view.unmount();
    }

    // 오버레이 클릭은 닫기, 취소 버튼도 닫기
    {
      const view = renderModal({});
      act(() => { fireEvent.click(view.container.querySelector('.preset-manage-modal') as HTMLElement); });
      act(() => { fireEvent.click(buttonByText(view.container, '취소')); });
      act(() => { fireEvent.click(view.container.querySelector('.modal-overlay') as HTMLElement); });
      result.closing = { calls: view.calls };
      view.unmount();
    }

    await expect(goldenJson(result)).toMatchFileSnapshot('./__goldens__/preset-manage-branches.json');
  });
});
