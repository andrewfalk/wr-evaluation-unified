// @vitest-environment jsdom
//
// P2-43b(flagged, D2) — 일괄 가져오기를 적용 시점의 최신 목록에 병합한다(REFACTORING_ROADMAP Phase 2 게이트 B 계획 P2-43b).
// 옮기기 전에는 모달이 기존 목록 전체를 복제해 행을 적용한 뒤 그 사본으로 목록을 통째로 교체하며 **전원 touch** → 서버 환자 전원이
// dirty가 돼 전원 PATCH(T5-9가 고정), 그리고 사본을 뜬 뒤 들어온 pull·ACK는 사본이 덮었다. 이제는 모달이 "새 환자"와 "행이 실제로
// 바꾼 기존 환자"만 넘기고, 전이가 적용 시점 목록에서 그 환자만 바꿔 touch한다. 사본을 뜬 뒤 달라진 기존 환자(revision·updatedAt
// 불일치)는 건너뛰고 완료 알림에 "건너뜀 N명"을 더한다. 진짜 BatchImportModal + 환자 상태 컨테이너 + usePatientCrud, StrictMode.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode, useEffect } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { usePatientCrud } from '../usePatientCrud.js';
import { usePatientsContainer } from '../../state/patientStore/usePatientsContainer';
import { defineTransition } from '../../state/patientStore/transitions';
import { BatchImportModal } from '../../components/BatchImportModal';

vi.mock('../../utils/platform', async () => {
  const actual = await vi.importActual('../../utils/platform');
  return { ...actual, showAlert: vi.fn(async () => {}), showConfirm: vi.fn(async () => true) };
});
vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ session: { mode: 'intranet', apiBaseUrl: 'https://x', accessToken: 'tok', user: { id: 'u1', role: 'doctor' } } }),
}));

import { showAlert } from '../../utils/platform';

const SESSION = { mode: 'intranet', apiBaseUrl: 'https://x', accessToken: 'tok', user: { id: 'u1', role: 'doctor' } };
const AT = '2026-11-10T00:00:00.000Z';

function serverPatient(id, sync = {}) {
  return {
    id,
    updatedAt: AT,
    createdAt: AT,
    meta: { organizationId: 'o1', ownerUserId: 'u1', createdBy: 'u1', updatedBy: 'u1' },
    data: {
      shared: { name: id, patientNo: `N-${id}`, birthDate: '', injuryDate: '', diagnoses: [], jobs: [] },
      modules: {}, activeModules: [],
    },
    sync: { serverId: `s-${id}`, revision: 1, syncStatus: 'synced', lastSyncedAt: AT, ...sync },
  };
}

// 테스트가 목록을 직접 바꾸는 경로(창이 열린 동안 들어온 pull·ACK 흉내)
const rawSet = defineTransition('test/rawSet', (prev, arg) => (typeof arg === 'function' ? arg(prev) : arg));

function Harness({ initialPatients, onState, onImportOverride }) {
  const container = usePatientsContainer(initialPatients, { initialActiveId: initialPatients[0].id });
  const { patients, setPatients, activeId, setActiveId, selectedIds, setSelectedIds } = container;
  const crud = usePatientCrud({
    activeId, activeModuleId: null, session: SESSION, settings: {},
    patients, setPatients, selectedIds, setSelectedIds,
    setErrors: () => {}, setActiveId, setCurrentStepIndex: () => {},
    setIntakeShared: () => {}, setShowHome: () => {}, handleStartIntake: () => {},
    canMutateActivePatient: true,
  });
  useEffect(() => { onState({ patients, setPatients, handleBatchImport: crud.handleBatchImport }); });
  return <BatchImportModal onClose={() => {}} onImport={onImportOverride || crud.handleBatchImport} existingPatients={patients} />;
}

async function importCsv(container, csv) {
  const input = container.querySelector('input[type="file"]');
  fireEvent.change(input, { target: { files: [new File([csv], 'import.csv', { type: 'text/csv' })] } });
  const button = screen.getByRole('button', { name: '가져오기' });
  await waitFor(() => expect(button.disabled).toBe(false));
  fireEvent.click(button);
}

// a에 상병 1건을 더하는 행 + 새 환자 1명
const CSV = 'name,patientno,diagcode,diagname\na,N-a,M17.0,knee oa\nnewcomer,N-new,M75.1,shoulder\n';

beforeEach(() => { vi.clearAllMocks(); });
afterEach(cleanup);

describe('P2-43b — 일괄 가져오기를 최신 목록에 병합', () => {
  it('가져오기 뒤 dirty는 행이 바꾼 기존 환자뿐이고, 손대지 않은 환자는 같은 객체 그대로다', async () => {
    const state = {};
    const existing = ['a', 'b', 'c'].map(id => serverPatient(id));
    const { container } = render(<StrictMode><Harness initialPatients={existing} onState={(s) => Object.assign(state, s)} /></StrictMode>);
    const before = state.patients;
    await importCsv(container, CSV);
    await waitFor(() => expect(state.patients).toHaveLength(4));
    const byNo = Object.fromEntries(state.patients.map(p => [p.data.shared.patientNo, p]));
    expect(byNo['N-a'].sync.syncStatus).toBe('dirty');
    expect(byNo['N-a'].data.shared.diagnoses.map(d => d.code)).toEqual(['M17.0']);
    expect(byNo['N-b']).toBe(before[1]);
    expect(byNo['N-c']).toBe(before[2]);
    expect(byNo['N-new'].sync.syncStatus).toBe('local-only');
  });

  it('창이 열린 동안 들어온 pull·ACK는 유지되고, 그사이 달라진 기존 환자는 건너뛰어 "건너뜀 1명"으로 알린다', async () => {
    const state = {};
    let held = null;
    const existing = ['a', 'b', 'c'].map(id => serverPatient(id));
    const { container } = render(<StrictMode><Harness
      initialPatients={existing}
      onState={(s) => Object.assign(state, s)}
      onImportOverride={(...args) => { held = args; }}
    /></StrictMode>);
    await importCsv(container, CSV);
    await waitFor(() => expect(held).not.toBeNull());

    // 모달이 결과를 만든 뒤 적용 전에 pull·ACK가 들어왔다: b(가져오기가 손대지 않은 환자)와 a(가져오기가 바꾼 환자)의 revision이 오름.
    const bump = (p) => ({ ...p, updatedAt: '2026-11-15T00:00:00.000Z', sync: { ...p.sync, revision: 2, lastSyncedAt: '2026-11-15T00:00:00.000Z' } });
    act(() => { state.setPatients(rawSet(prev => prev.map(p => (p.id === 'a' || p.id === 'b' ? bump(p) : p)))); });
    act(() => { state.handleBatchImport(...held); });

    const byNo = Object.fromEntries(state.patients.map(p => [p.data.shared.patientNo, p]));
    expect(byNo['N-b'].sync).toMatchObject({ revision: 2, syncStatus: 'synced' }); // pull·ACK 유지
    expect(byNo['N-a'].sync).toMatchObject({ revision: 2, syncStatus: 'synced' }); // 그사이 달라져 건너뜀(가져오기 미적용)
    expect(byNo['N-a'].data.shared.diagnoses).toEqual([]);
    expect(byNo['N-new'].sync.syncStatus).toBe('local-only'); // 새 환자는 추가
    expect(String(showAlert.mock.calls.at(-1)?.[0])).toContain('건너뜀 1명');
  });
});
