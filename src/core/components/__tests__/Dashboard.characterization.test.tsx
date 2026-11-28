// @vitest-environment jsdom
//
// 대시보드 화면 특성화(P2-84a, Phase 2 C9 구간 A) — vi.mock 없이 실제 모듈 등록(`modules/index`)과 실제 집계(dashboardStats)로
// 대시보드를 그려 지금 화면을 얼린다. 뒤따르는 이동·분할 PR(P2-84b-ts · P2-85a · P2-85b)의 안전망이다.
//   · 사례: 빈 상태(로컬 · 내 환자 범위 · 가려진 환자만), 골든·보강 환자 묶음 전체(로컬), 인트라넷 범위(전체 · 내 환자 ·
//     특정 의사 · 미배정)와 불러오는 중 배너. 담당 의사·명부는 합성 ID·이름이다.
//   · 조작: 기간 탭(월간·주간·일간), 카드의 성별 토글(전체·남·여), '모듈별 개수' ↔ '상위 직종' 라벨 토글, 범위 선택 상자,
//     빈 상태의 '전체 보기로 전환', 최근 활동의 환자 링크 — 바뀐 구역의 DOM과 부모 콜백 호출을 적는다.
//   · DOM은 한 요소 한 줄로 직렬화하고(src/testing/renderEvaluation.tsx), 제어되는 폼 상태를 따로 적는다.
// 규칙(의도한 출력 변경에서만 갱신, 리팩터링에서는 갱신 금지): src/core/fixtures/goldenEnv.js
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { useGoldenEnvironment } from '../../fixtures/goldenEnv';
import { loadGoldenBatchPatients, loadGoldenNarrativePatients, loadGoldenPatients } from '../../fixtures/goldenPatients';
import { formState, serializeDom } from '../../../testing/renderEvaluation';
import { UNASSIGNED_GROUP_KEY } from '../../utils/dashboardStats';
import type { PatientRecord } from '../../types/patient';
import '../../../modules/index';
import Dashboard from '../Dashboard';

type Fields = Record<string, unknown>;
type FixturePatient = PatientRecord;
interface SyntheticSession { mode: string; user: { id: string; role: string; name?: string; loginId?: string } }

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

const DOCTOR_A = 'synthetic-doctor-a';
const DOCTOR_B = 'synthetic-doctor-b';

const DOCTOR_SESSION: SyntheticSession = { mode: 'intranet', user: { id: DOCTOR_A, name: '합성 의사 가', role: 'doctor' } };
const ADMIN_SESSION: SyntheticSession = { mode: 'intranet', user: { id: 'synthetic-admin', loginId: 'synthetic-admin', role: 'admin' } };

function allFixturePatients(): FixturePatient[] {
  return [
    ...(loadGoldenPatients() as FixturePatient[]),
    ...(loadGoldenBatchPatients() as FixturePatient[]),
    ...(loadGoldenNarrativePatients() as FixturePatient[]),
  ];
}

/** 인트라넷 사례용: 차례대로 의사 가 · 의사 나 · 미배정(명시 null) · 작성자만(의사 가) 을 붙이고, 가려진 환자 하나를 더한다. */
function ownedPatients(): FixturePatient[] {
  const owners: Array<(p: FixturePatient) => FixturePatient> = [
    p => ({ ...p, assignedDoctorUserId: DOCTOR_A }),
    p => ({ ...p, assignedDoctorUserId: DOCTOR_B }),
    p => ({ ...p, assignedDoctorUserId: null }),
    p => ({ ...p, meta: { ...(p.meta || {}), createdBy: DOCTOR_A } }),
  ];
  return [
    ...allFixturePatients().map((p, i) => owners[i % owners.length](p)),
    { id: 'synthetic-redacted', redacted: true },
  ];
}

const ROSTER = {
  doctors: [
    { userId: DOCTOR_A, name: '합성 의사 가', count: 21 },
    { userId: DOCTOR_B, name: '합성 의사 나', count: 20 },
    { userId: 'synthetic-doctor-c', name: '', count: 0 },
  ],
  unassignedCount: 20,
};

interface DashboardCase {
  patients: FixturePatient[];
  session?: SyntheticSession | null;
  scope?: string;
  canUseScope?: boolean;
  doctorRoster?: typeof ROSTER;
  isScopeLoading?: boolean;
}

function renderDashboard(c: DashboardCase) {
  const calls: Array<[string, unknown]> = [];
  const view = render(
    <Dashboard
      patients={c.patients}
      onSelectPatient={(id: unknown) => calls.push(['onSelectPatient', id])}
      session={c.session ?? null}
      scope={c.scope}
      onScopeChange={(value: unknown) => calls.push(['onScopeChange', value])}
      canUseScope={c.canUseScope}
      doctorRoster={c.doctorRoster}
      isScopeLoading={c.isScopeLoading}
    />,
  );
  return { ...view, calls };
}

function snapshot(container: HTMLElement) {
  return { dom: serializeDom(container), form: formState(container) };
}

function region(container: HTMLElement, selector: string): string[] {
  const el = container.querySelector(selector);
  if (!el) throw new Error(`구역 없음: ${selector}`);
  return serializeDom(el);
}

const SCREEN_CASES: Array<[string, DashboardCase]> = [
  ['empty:local', { patients: [] }],
  ['empty:local-mine-without-scope', { patients: [], scope: 'mine' }],
  ['empty:intranet-mine', { patients: [], session: DOCTOR_SESSION, scope: 'mine', canUseScope: true, doctorRoster: ROSTER }],
  ['empty:redacted-only', { patients: [{ id: 'synthetic-redacted', redacted: true }] }],
  ['empty:not-array', { patients: null as unknown as FixturePatient[] }],
  ['full:local', { patients: allFixturePatients() }],
  ['full:intranet-doctor-all', { patients: ownedPatients(), session: DOCTOR_SESSION, scope: 'all', canUseScope: true, doctorRoster: ROSTER }],
  ['full:intranet-doctor-mine', { patients: ownedPatients(), session: DOCTOR_SESSION, scope: 'mine', canUseScope: true, doctorRoster: ROSTER }],
  ['full:intranet-admin-doctor-b', { patients: ownedPatients(), session: ADMIN_SESSION, scope: DOCTOR_B, canUseScope: true, doctorRoster: ROSTER }],
  ['full:intranet-admin-unassigned', { patients: ownedPatients(), session: ADMIN_SESSION, scope: UNASSIGNED_GROUP_KEY, canUseScope: true, doctorRoster: ROSTER }],
  ['full:intranet-admin-all-loading', { patients: ownedPatients(), session: ADMIN_SESSION, scope: 'all', canUseScope: true, doctorRoster: ROSTER, isScopeLoading: true }],
  ['full:intranet-without-scope', { patients: ownedPatients(), session: DOCTOR_SESSION, scope: 'all', canUseScope: false }],
];

describe('P2-84a — 대시보드 화면', () => {
  it('사례별 첫 렌더', async () => {
    const result: Fields = {};
    for (const [name, c] of SCREEN_CASES) {
      const view = renderDashboard(c);
      result[name] = { ...snapshot(view.container), calls: view.calls };
      view.unmount();
    }
    await expect(goldenJson(result)).toMatchFileSnapshot('./__goldens__/dashboard-screen.json');
  });

  it('조작 → 바뀐 구역과 콜백', async () => {
    const result: Fields = {};

    // 기간 탭: 월간(처음) → 주간 → 일간 → 월간
    {
      const view = renderDashboard({ patients: allFixturePatients() });
      const tabs = () => Array.from(view.container.querySelectorAll<HTMLButtonElement>('.dashboard-period-btn'));
      const steps: Fields = {};
      for (const label of ['주간', '일간', '월간']) {
        const button = tabs().find(b => b.textContent === label);
        if (!button) throw new Error(`기간 탭 없음: ${label}`);
        act(() => { fireEvent.click(button); });
        steps[label] = {
          tabs: region(view.container, '.dashboard-period-tabs'),
          charts: region(view.container, '.dashboard-content'),
        };
      }
      result.period = steps;
      view.unmount();
    }

    // 성별 토글: 네 카드 각각 남 → 여 → 전체. 카드마다 상태가 따로임을 보이려고 요약 구역 전체를 적는다.
    {
      const view = renderDashboard({ patients: allFixturePatients() });
      const cards = () => Array.from(view.container.querySelectorAll('.dashboard-card-with-toggle'));
      const steps: Fields = {};
      cards().forEach((_card, index) => {
        for (const label of ['남', '여', '전체']) {
          const button = Array.from(cards()[index].querySelectorAll<HTMLButtonElement>('.card-gender-btn')).find(b => b.textContent === label);
          if (!button) throw new Error(`성별 토글 없음: ${index} ${label}`);
          act(() => { fireEvent.click(button); });
          steps[`card${index}:${label}`] = region(view.container, '.dashboard-summary');
        }
      });
      result.genderToggle = steps;
      view.unmount();
    }

    // '모듈별 개수' ↔ '상위 직종' 라벨 토글(두 번 눌러 되돌아옴)
    {
      const view = renderDashboard({ patients: allFixturePatients() });
      const steps: Fields = {};
      for (const step of ['first', 'second']) {
        const label = view.container.querySelector('.stat-label-toggle');
        if (!label) throw new Error('라벨 토글 없음');
        act(() => { fireEvent.click(label); });
        steps[step] = region(view.container, '.metric-card-modules');
      }
      result.statLabelToggle = steps;
      view.unmount();
    }

    // 범위 선택 상자: 값을 바꾸면 부모 콜백만 부른다(범위는 부모가 쥔 prop).
    {
      const view = renderDashboard({ patients: ownedPatients(), session: DOCTOR_SESSION, scope: 'all', canUseScope: true, doctorRoster: ROSTER });
      const select = view.container.querySelector<HTMLSelectElement>('.patient-scope-select');
      if (!select) throw new Error('범위 선택 상자 없음');
      for (const value of ['mine', DOCTOR_B, UNASSIGNED_GROUP_KEY]) {
        act(() => { fireEvent.change(select, { target: { value } }); });
      }
      result.scopeSelect = { calls: view.calls, form: formState(view.container) };
      view.unmount();
    }

    // 빈 상태의 '전체 보기로 전환'
    {
      const view = renderDashboard({ patients: [], session: DOCTOR_SESSION, scope: 'mine', canUseScope: true, doctorRoster: ROSTER });
      const button = Array.from(view.container.querySelectorAll('button')).find(b => b.textContent?.includes('전체 보기로 전환'));
      if (!button) throw new Error('전체 보기 버튼 없음');
      act(() => { fireEvent.click(button); });
      result.emptySwitchToAll = { calls: view.calls };
      view.unmount();
    }

    // 최근 활동의 환자 링크(처음 두 줄)
    {
      const view = renderDashboard({ patients: allFixturePatients() });
      const links = Array.from(view.container.querySelectorAll<HTMLAnchorElement>('.dashboard-link')).slice(0, 2);
      for (const link of links) act(() => { fireEvent.click(link); });
      result.recentActivityLinks = { linkCount: view.container.querySelectorAll('.dashboard-link').length, calls: view.calls };
      view.unmount();
    }

    await expect(goldenJson(result)).toMatchFileSnapshot('./__goldens__/dashboard-actions.json');
  });
});
