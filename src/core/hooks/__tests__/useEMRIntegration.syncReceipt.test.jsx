// @vitest-environment jsdom
//
// P2-40b — EMR 일괄 추출의 적용 여부를 커밋 배리어 없이 dispatch 직후 receipt로 읽는다(REFACTORING_ROADMAP Phase 2, 게이트 B
// 계획 설계 2·P2-40b). 진짜 상태(환자 상태 컨테이너 + useEMRIntegration), StrictMode.
//   ① 같은 배치의 식별정보 변경은 dispatch 시점 목록에 이미 들어 있다 — 건너뜀으로 센다.
//   ② 전이가 던지면(손상된 상병 목록 등) 예외는 setPatients 호출부로 나온다 → 일괄 추출의 catch가 "실패 1명"으로 센다.
//      옮기기 전에는 전이가 React 렌더 중에 돌아 렌더 오류(화면 오류 경계)가 됐다(계획 설계 1 — 확인 항목).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useEMRIntegration } from '../useEMRIntegration';
import { usePatientsContainer } from '../../state/patientStore/usePatientsContainer';
import { patientTx } from '../../state/patientStore/transitions';

vi.mock('../../utils/platform', () => ({
  showAlert: vi.fn(async () => {}),
  showConfirm: vi.fn(async () => true),
}));

import { showAlert } from '../../utils/platform';

const SESSION = { mode: 'local' };

function patient(id, shared = {}) {
  return {
    id,
    data: {
      shared: { name: `old-${id}`, patientNo: `N-${id}`, injuryDate: '', diagnoses: [], ...shared },
      modules: {}, activeModules: [],
    },
    sync: { syncStatus: 'local-only' },
  };
}

function renderEmr(initialPatients, initialActiveId) {
  return renderHook(() => {
    const container = usePatientsContainer(initialPatients, { initialActiveId, initialSelectedIds: new Set(initialPatients.map(p => p.id)) });
    const activePatient = container.patients.find(p => p.id === container.activeId) || null;
    const emr = useEMRIntegration({
      activePatient, patients: container.patients, selectedIds: container.selectedIds, session: SESSION,
      setPatients: container.setPatients, dirtyAssessmentPatientId: null,
    });
    return { ...container, emr };
  }, { wrapper: StrictMode });
}

const lastAlert = () => showAlert.mock.calls.at(-1)?.[0] ?? '';

let extract;
beforeEach(() => {
  extract = vi.fn();
  window.electron = { extractRecord: (...args) => extract(...args) };
  showAlert.mockClear();
});
afterEach(() => {
  cleanup();
  delete window.electron;
});

describe('useEMRIntegration — dispatch 직후 receipt(P2-40b)', () => {
  it('① 추출 응답과 같은 동기 구간에서 등록번호가 바뀌면 그 환자는 건너뜀(dispatch 시점 목록 기준)', async () => {
    const { result } = renderEmr([patient('a'), patient('b')], 'a');
    extract.mockImplementation(async (patientNo) => {
      // 응답 직전, 같은 동기 구간에서 a의 등록번호를 바꾼다(커밋 전) — 스토어는 이미 바뀐 목록으로 판정한다.
      if (patientNo === 'N-a') {
        result.current.setPatients(patientTx.dataEdited({
          id: 'a', session: SESSION, edit: d => ({ ...d, shared: { ...d.shared, patientNo: 'N-changed' } }),
        }));
      }
      return { success: true, patientName: `new-${patientNo}` };
    });
    await act(async () => { await result.current.emr.handleEmrExtractBatch(); });
    expect(lastAlert()).toContain('2명 중 성공 1명, 실패 0명, 건너뜀 1명');
    const byId = Object.fromEntries(result.current.patients.map(p => [p.id, p.data.shared]));
    expect(byId.a).toMatchObject({ patientNo: 'N-changed', name: 'old-a' });
    expect(byId.b).toMatchObject({ patientNo: 'N-b', name: 'new-N-b' });
  });

  it('② 전이가 던지면(손상된 상병 목록) 그 환자는 "실패 1명"으로 세고 나머지는 계속 적용한다', async () => {
    // diagnoses가 배열이 아니면 병합(patch)이 전이 안에서 TypeError를 던진다.
    const { result } = renderEmr([patient('a', { diagnoses: { broken: true } }), patient('b')], 'a');
    extract.mockImplementation(async (patientNo) => ({
      success: true, patientName: `new-${patientNo}`, diseases: [{ code: 'M17', name: '무릎' }],
    }));
    await act(async () => { await result.current.emr.handleEmrExtractBatch(); });
    expect(lastAlert()).toContain('2명 중 성공 1명, 실패 1명');
    const byId = Object.fromEntries(result.current.patients.map(p => [p.id, p.data.shared]));
    expect(byId.a.name).toBe('old-a');
    expect(byId.b.name).toBe('new-N-b');
    expect(byId.b.diagnoses.map(d => d.code)).toEqual(['M17']);
  });
});
