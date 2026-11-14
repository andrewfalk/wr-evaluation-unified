// @vitest-environment jsdom
//
// P2-39c(flagged, T4에서 확인돼 진행) — 평가일자 자동 설정에 편집 가능 가드(REFACTORING_ROADMAP Phase 2, 게이트 A 계획
// "flagged 수정 설계 ③"). 옮기기 전에는 편집 권한 없는 환자(다른 의사 담당)에도 평가일자를 쓰고 서버 환자를 dirty로 만들었다.
// 가드 = canEditPatient && (락 대상이 아니거나, lockState가 held이고 **그 환자의** 락 토큰이 있음). lockState에는 환자 id가
// 없어서, A의 락을 들고 B로 전환한 첫 렌더에는 A의 held가 그대로 보인다 — 토큰 확인이 그 창을 막는다(Codex 계획 리뷰 3회차).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode, useCallback, useState } from 'react';
import { cleanup, renderHook } from '@testing-library/react';
import { useEvaluationDateSync } from '../useEvaluationDateSync';
import { registerModule } from '../../../moduleRegistry';
import { clearAllLockTokens, clearLockToken, setLockToken } from '../../../services/lockTokenStore';

const MODULE_ID = 'p239c-eval-date-module';
registerModule({ id: MODULE_ID, name: 'P2-39c', isComplete: ({ module }) => module?.done === true });

const DOCTOR = { mode: 'intranet', apiBaseUrl: 'https://x', accessToken: 'tok', user: { id: 'u1', role: 'doctor', organizationId: 'org1' } };
const NOW = new Date(2026, 10, 14, 9, 30, 0);
const TODAY = '2026-11-14';

function patient(id, { mine = true, serverId = `s-${id}`, evaluationDate = '' } = {}) {
  return {
    id,
    data: { shared: { name: id, evaluationDate }, modules: { [MODULE_ID]: { done: true } }, activeModules: [MODULE_ID] },
    sync: serverId ? { serverId, revision: 1, syncStatus: 'synced' } : { syncStatus: 'local-only' },
    meta: mine
      ? { createdBy: 'u1', ownerUserId: 'u1', assignedDoctorUserId: 'u1', organizationId: 'org1' }
      : { createdBy: 'u2', ownerUserId: 'u2', assignedDoctorUserId: 'u2', organizationId: 'org1' },
  };
}

let writes;
function renderSubject(initialProps) {
  return renderHook(({ initialPatients, activeId, session, lockState }) => {
    const [patients, rawSetPatients] = useState(initialPatients);
    const setPatients = useCallback((arg) => { writes.push(arg); rawSetPatients(arg); }, []);
    useEvaluationDateSync({ activeId, patients, setPatients, session, lockState });
    return { patients };
  }, { initialProps, wrapper: StrictMode });
}
const dateOf = (result, id) => result.current.patients.find(p => p.id === id)?.data?.shared?.evaluationDate;

beforeEach(() => {
  writes = [];
  clearAllLockTokens();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('P2-39c — 평가일자 자동 설정 편집 가능 가드', () => {
  it('① 편집 권한 없는 환자(다른 의사 담당)에는 쓰지 않는다(락을 들고 있어도)', () => {
    setLockToken('a', 'lease-a');
    const { result } = renderSubject({ initialPatients: [patient('a', { mine: false })], activeId: 'a', session: DOCTOR, lockState: { status: 'held' } });
    expect(dateOf(result, 'a')).toBe('');
    expect(writes).toHaveLength(0);
  });

  it('② A의 락을 보유한 채 B로 전환한 직후, B의 락을 얻기 전에는 B에 쓰지 않는다', () => {
    setLockToken('a', 'lease-a');
    const held = { status: 'held' };
    const { result, rerender } = renderSubject({
      initialPatients: [patient('a', { evaluationDate: '2026-01-01' }), patient('b')],
      activeId: 'a', session: DOCTOR, lockState: held,
    });
    expect(writes).toHaveLength(0);
    // 전환: usePatientLock cleanup이 A의 토큰을 지우고, 이 렌더에는 A의 held(같은 객체)가 그대로 보인다.
    clearLockToken('a');
    rerender({ initialPatients: [], activeId: 'b', session: DOCTOR, lockState: held });
    expect(dateOf(result, 'b')).toBe('');
    expect(writes).toHaveLength(0);
    // 획득 중
    rerender({ initialPatients: [], activeId: 'b', session: DOCTOR, lockState: { status: 'acquiring' } });
    expect(writes).toHaveLength(0);
  });

  it('③ B의 락을 얻으면 그때 판정해 쓴다', () => {
    const { result, rerender } = renderSubject({ initialPatients: [patient('b')], activeId: 'b', session: DOCTOR, lockState: { status: 'acquiring' } });
    expect(writes).toHaveLength(0);
    setLockToken('b', 'lease-b');
    rerender({ initialPatients: [], activeId: 'b', session: DOCTOR, lockState: { status: 'held' } });
    expect(dateOf(result, 'b')).toBe(TODAY);
    expect(result.current.patients[0].sync.syncStatus).toBe('dirty');
  });

  it.each([['lost'], ['held-by-other']])('④ 락 상실(%s) 중에는 쓰지 않는다', (status) => {
    setLockToken('a', 'stale-token'); // 토큰이 남아 있어도 held가 아니면 안 씀
    const { result } = renderSubject({ initialPatients: [patient('a')], activeId: 'a', session: DOCTOR, lockState: { status } });
    expect(dateOf(result, 'a')).toBe('');
    expect(writes).toHaveLength(0);
  });

  it('⑤ 로컬 모드·서버 미등록 환자는 지금과 같이 쓴다(락 대상 아님)', () => {
    const local = renderSubject({ initialPatients: [patient('a', { serverId: null })], activeId: 'a', session: null, lockState: { status: 'none' } });
    expect(dateOf(local.result, 'a')).toBe(TODAY);
    writes = [];
    const unregistered = renderSubject({ initialPatients: [patient('n', { serverId: null })], activeId: 'n', session: DOCTOR, lockState: { status: 'none' } });
    expect(dateOf(unregistered.result, 'n')).toBe(TODAY);
  });
});
