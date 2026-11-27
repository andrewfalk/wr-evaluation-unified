// @vitest-environment jsdom
//
// 화면이 내려간 뒤 EMR 작업이 바깥에 영향을 주지 않는다(계정 전환 수정 AS-4, R23). 계정이 바뀌면 화면(App)이 다시 띄워진다 —
// 이전 화면의 일괄 추출 루프가 다음 환자의 추출 브리지를 계속 부르거나, 끝에 이전 계정 환자 이름을 모은 알림을 띄우면 안 된다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useEMRIntegration } from '../useEMRIntegration';
import { usePatientsContainer } from '../../state/patientStore/usePatientsContainer';

vi.mock('../../utils/platform', () => ({
  showAlert: vi.fn(async () => {}),
  showConfirm: vi.fn(async () => true),
}));

import { showAlert, showConfirm } from '../../utils/platform';

const SESSION = { mode: 'local' };

function patient(id) {
  return {
    id,
    data: { shared: { name: `환자-${id}`, patientNo: `N-${id}`, injuryDate: '', diagnoses: [] }, modules: {}, activeModules: [] },
    sync: { syncStatus: 'local-only' },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

function renderEmr(initialPatients, { selected = [] } = {}) {
  return renderHook(() => {
    const store = usePatientsContainer(initialPatients, { initialActiveId: initialPatients[0].id, initialSelectedIds: new Set(selected) });
    const activePatient = store.patients.find(p => p.id === store.activeId) || null;
    const emr = useEMRIntegration({
      activePatient, patients: store.patients, selectedIds: store.selectedIds, session: SESSION,
      setPatients: store.setPatients, dirtyAssessmentPatientId: null,
    });
    return { ...store, emr };
  }, { wrapper: StrictMode });
}

async function flushAll(rounds = 20) {
  for (let i = 0; i < rounds; i += 1) await act(async () => { await Promise.resolve(); });
}

let extract;
let inject;
let consult;
beforeEach(() => {
  vi.clearAllMocks();
  extract = vi.fn();
  inject = vi.fn();
  consult = vi.fn();
  window.electron = { extractRecord: extract, injectEMR: inject, extractConsultation: consult };
});

afterEach(() => {
  cleanup();
  delete window.electron;
});

describe('R23 — 화면이 내려간 뒤 EMR 작업', () => {
  it('일괄 추출 중 화면이 내려가면 보류된 응답이 와도 다음 추출 브리지 호출·알림이 없다', async () => {
    const first = deferred();
    extract.mockImplementationOnce(() => first.promise);
    extract.mockResolvedValue({ success: true, patientNo: 'N-p2' });
    const { result, unmount } = renderEmr([patient('p1'), patient('p2'), patient('p3')], { selected: ['p1', 'p2', 'p3'] });

    let done;
    act(() => { done = result.current.emr.handleEmrExtractBatch(); });
    await flushAll();
    expect(extract).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => { first.resolve({ success: true, patientNo: 'N-p1', patientName: '바뀐이름' }); await done; });

    expect(extract).toHaveBeenCalledTimes(1);
    expect(showAlert).not.toHaveBeenCalled();
  });

  it('확인창을 기다리는 동안 화면이 내려가면 추출을 시작하지 않는다', async () => {
    const answer = deferred();
    showConfirm.mockImplementationOnce(() => answer.promise);
    const { result, unmount } = renderEmr([patient('p1')]);
    let done;
    act(() => { done = result.current.emr.handleEmrExtractBatch(); });
    unmount();
    await act(async () => { answer.resolve(true); await done; });
    expect(extract).not.toHaveBeenCalled();
    expect(showAlert).not.toHaveBeenCalled();
  });

  it('EMR 입력 확인창을 기다리는 동안 화면이 내려가면 이전 환자 데이터를 EMR에 넣지 않는다', async () => {
    const answer = deferred();
    showConfirm.mockImplementationOnce(() => answer.promise);
    const { result, unmount } = renderEmr([patient('p1')]);
    let done;
    act(() => { done = result.current.emr.handleInjectConsultReply(); });
    unmount();
    await act(async () => { answer.resolve(true); await done; });
    expect(inject).not.toHaveBeenCalled();
    expect(showAlert).not.toHaveBeenCalled();
  });

  it('다학제 회신 추출을 기다리는 동안 화면이 내려가면 확인창·알림을 띄우지 않는다', async () => {
    const res = deferred();
    consult.mockImplementationOnce(() => res.promise);
    const { result, unmount } = renderEmr([patient('p1')]);
    let done;
    act(() => { done = result.current.emr.handleExtractConsultation(); });
    unmount();
    await act(async () => { res.resolve({ success: true, consultations: [{ department: '정형외과', content: 'x' }] }); await done; });
    expect(showConfirm).not.toHaveBeenCalled();
    expect(showAlert).not.toHaveBeenCalled();
  });
});
