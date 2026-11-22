// @vitest-environment jsdom
//
// 로그인 화면이 떠 있는 동안 평가일자를 쓰지 않는다(계정 전환 수정 AS-5). 인트라넷 모드에서 세션이 로컬로 돌아간 동안(로그인
// 화면 뒤에 이전 목록이 남아 있을 때) 로컬 세션은 편집 권한을 항상 참으로 보므로, 이전 사용자가 열람만 하던 환자에도 평가일자를
// 써서 저장 대기로 만들 수 있다 — 그동안은 멈춘다. StrictMode.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode, useCallback, useState } from 'react';
import { cleanup, renderHook } from '@testing-library/react';
import { useEvaluationDateSync } from '../useEvaluationDateSync';
import { registerModule } from '../../../moduleRegistry';
import { makeTestManifest } from '../../../../testing/moduleManifest';

const MODULE_ID = 'as5-eval-date-module';
registerModule(makeTestManifest({ id: MODULE_ID, name: 'AS5', isComplete: ({ module }) => module?.done === true }));

const LOCAL = { mode: 'local' };

function serverPatientOfOtherDoctor() {
  return {
    id: 'p1',
    data: { shared: { name: 'p1', evaluationDate: '' }, modules: { [MODULE_ID]: { done: true } }, activeModules: [MODULE_ID] },
    sync: { serverId: 'srv-p1', revision: 3, syncStatus: 'synced' },
    meta: { createdBy: 'other', ownerUserId: 'other' },
    assignedDoctorUserId: 'other',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

let writes;
function render({ suspended }) {
  return renderHook(() => {
    const [patients, raw] = useState([serverPatientOfOtherDoctor()]);
    const setPatients = useCallback((arg) => { writes.push(arg); raw(arg); }, []);
    useEvaluationDateSync({ activeId: 'p1', patients, setPatients, session: LOCAL, lockState: { status: 'none' }, suspended });
    return patients;
  }, { wrapper: StrictMode });
}

beforeEach(() => {
  writes = [];
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 15, 9, 0, 0));
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('useEvaluationDateSync — 로그인 화면이 떠 있는 동안', () => {
  it('멈춰 있으면(인트라넷 모드 + 인증 안 됨) 평가일자를 쓰지 않는다', () => {
    const view = render({ suspended: true });
    expect(writes).toHaveLength(0);
    expect(view.result.current[0].data.shared.evaluationDate).toBe('');
  });

  it('멈추지 않으면 지금처럼 쓴다(대조)', () => {
    const view = render({ suspended: false });
    expect(writes.length).toBeGreaterThan(0);
    expect(view.result.current[0].data.shared.evaluationDate).toBe('2026-11-15');
  });
});
