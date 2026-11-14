// @vitest-environment jsdom
//
// T4 — useEvaluationDateSync 특성화(REFACTORING_ROADMAP Phase 2 P2-31a, 게이트 A 계획).
// 평가 완료 여부에 따라 활성 환자의 shared.evaluationDate를 자동으로 맞추는 effect의 현재 동작:
// 완료 → 오늘(이미 값이 있으면 유지), 미완료 → 빈 값, 같은 값이면 쓰지 않음, redacted 제외,
// 편집 권한 없는 환자에도 쓰는지(= 결정 2의 판단 근거), 불러오기처럼 목록 교체와 활성 환자 지정이
// 한 배치로 오면 중간 상태(새 목록 + 옛 활성 id)에 쓰지 않는지(A4 — 평가일자를 "액션마다 리듀서
// 후처리"로 옮기지 않은 이유).
//
// P2-38에서 이 effect를 환자 상태 컨테이너로 옮길 때는 renderSubject만 바꾸고 단언은 그대로 둔다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode, useCallback, useState } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
// P2-38: 대상 훅만 환자 상태 컨테이너 모듈의 것으로 바꿨다(옛 src/core/hooks/useEvaluationDateSync.js 삭제) — 단언은 그대로.
import { useEvaluationDateSync } from '../../state/patientStore/useEvaluationDateSync';
import { registerModule } from '../../moduleRegistry';
import { canEditPatient } from '../../utils/patientOwnership';

const MODULE_ID = 't4-eval-date-module';
registerModule({
  id: MODULE_ID,
  name: 'T4',
  isComplete: ({ module }) => module?.done === true,
});

const INTRANET_DOCTOR = { mode: 'intranet', apiBaseUrl: 'https://x', accessToken: 'tok', user: { id: 'u1', role: 'doctor', organizationId: 'org1' } };
const NOW = new Date(2026, 10, 14, 9, 30, 0); // 로컬 2026-11-14
const TODAY = '2026-11-14';

function patient(id, { done = true, evaluationDate = '', sync, meta, redacted } = {}) {
  const base = {
    id,
    data: {
      shared: { name: id, evaluationDate },
      modules: { [MODULE_ID]: { done } },
      activeModules: [MODULE_ID],
    },
    sync: sync || { syncStatus: 'local-only' },
    meta: meta || { createdBy: 'u1', ownerUserId: 'u1' },
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  // 가림 환자도 data를 붙여 둔다 — `!p.data` 가드가 아니라 redacted 가드 자체를 검증하려고.
  if (redacted) return { ...base, redacted: true };
  return base;
}

let writes;

function useHarness({ initialPatients, initialActiveId, session }) {
  const [patients, rawSetPatients] = useState(initialPatients);
  const [activeId, setActiveId] = useState(initialActiveId);
  // setPatients는 고정 참조여야 한다(effect deps). 호출마다 updater를 기록한다.
  const setPatients = useCallback((arg) => { writes.push(arg); rawSetPatients(arg); }, []);
  useEvaluationDateSync({ activeId, patients, setPatients, session });
  return { patients, activeId, rawSetPatients, setActiveId };
}

function renderSubject(initialProps) {
  return renderHook(props => useHarness(props), { initialProps, wrapper: StrictMode });
}

function evaluationDateOf(result, id) {
  return result.current.patients.find(p => p.id === id)?.data?.shared?.evaluationDate;
}

beforeEach(() => {
  writes = [];
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('T4 useEvaluationDateSync — 값 결정', () => {
  it('완료된 활성 환자의 빈 평가일자를 오늘로 채우고 touch한다(updatedAt 갱신, 로컬 환자는 local-only 유지)', () => {
    const { result } = renderSubject({ initialPatients: [patient('a')], initialActiveId: 'a', session: null });
    expect(evaluationDateOf(result, 'a')).toBe(TODAY);
    const a = result.current.patients[0];
    expect(a.updatedAt).toBe(NOW.toISOString());
    expect(a.sync.syncStatus).toBe('local-only');
    // StrictMode 이중 effect: 첫 effect가 쓰고, 두 번째 effect는 같은(아직 갱신 전) 렌더의 patients를 보고
    // 한 번 더 같은 값을 예약한다 — 결과는 같다.
    expect(writes.length).toBeGreaterThanOrEqual(1);
  });

  it('완료됐고 이미 평가일자가 있으면 그 값을 유지한다(쓰지 않음)', () => {
    const { result } = renderSubject({ initialPatients: [patient('a', { evaluationDate: '2026-03-01' })], initialActiveId: 'a', session: null });
    expect(evaluationDateOf(result, 'a')).toBe('2026-03-01');
    expect(writes).toHaveLength(0);
  });

  it('미완료인데 평가일자가 있으면 빈 값으로 지운다', () => {
    const { result } = renderSubject({ initialPatients: [patient('a', { done: false, evaluationDate: '2026-03-01' })], initialActiveId: 'a', session: null });
    expect(evaluationDateOf(result, 'a')).toBe('');
    expect(writes.length).toBeGreaterThanOrEqual(1);
  });

  it('미완료이고 평가일자도 비어 있으면 쓰지 않는다', () => {
    const { result } = renderSubject({ initialPatients: [patient('a', { done: false })], initialActiveId: 'a', session: null });
    expect(evaluationDateOf(result, 'a')).toBe('');
    expect(writes).toHaveLength(0);
  });

  it('활성 환자가 없거나 목록에 없으면 쓰지 않는다', () => {
    renderSubject({ initialPatients: [patient('a')], initialActiveId: null, session: null });
    renderSubject({ initialPatients: [patient('a')], initialActiveId: 'ghost', session: null });
    expect(writes).toHaveLength(0);
  });

  it('redacted 환자는 건너뛴다', () => {
    renderSubject({ initialPatients: [patient('a', { redacted: true })], initialActiveId: 'a', session: null });
    expect(writes).toHaveLength(0);
  });

  it('활성 환자만 바꾸고 다른 환자는 같은 참조로 둔다', () => {
    const b = patient('b', { done: false, evaluationDate: '2026-03-01' });
    const { result } = renderSubject({ initialPatients: [patient('a'), b], initialActiveId: 'a', session: null });
    expect(evaluationDateOf(result, 'a')).toBe(TODAY);
    expect(result.current.patients[1]).toBe(b);
  });

  it('편집으로 완료가 되는 순간 오늘을 채운다(effect가 patients 변경을 따라감)', () => {
    const { result } = renderSubject({ initialPatients: [patient('a', { done: false })], initialActiveId: 'a', session: null });
    expect(writes).toHaveLength(0);
    act(() => {
      result.current.rawSetPatients(prev => prev.map(p => ({ ...p, data: { ...p.data, modules: { [MODULE_ID]: { done: true } } } })));
    });
    expect(evaluationDateOf(result, 'a')).toBe(TODAY);
  });
});

describe('T4 useEvaluationDateSync — 권한·동기화 상태(결정 2의 판단 근거)', () => {
  it('[확인됨] 편집 권한 없는 환자(다른 의사 담당)에도 평가일자를 쓰고, 서버 환자라 syncStatus가 dirty가 된다', () => {
    const othersPatient = patient('a', {
      sync: { serverId: 's-a', revision: 3, syncStatus: 'synced' },
      meta: { createdBy: 'u2', ownerUserId: 'u2', assignedDoctorUserId: 'u2', organizationId: 'org1' },
    });
    // 전제: 이 세션은 이 환자를 편집할 수 없다.
    expect(canEditPatient(othersPatient, INTRANET_DOCTOR)).toBe(false);

    const { result } = renderSubject({ initialPatients: [othersPatient], initialActiveId: 'a', session: INTRANET_DOCTOR });

    // 현재 동작(가드 없음): 쓴다 → dirty → 자동 push 대상이 된다(서버는 403으로 거절).
    expect(evaluationDateOf(result, 'a')).toBe(TODAY);
    expect(result.current.patients[0].sync.syncStatus).toBe('dirty');
    expect(result.current.patients[0].meta.updatedBy).toBe('u1');
  });

  it('편집 권한 있는 서버 환자도 같은 경로로 dirty가 된다(대조)', () => {
    const mine = patient('a', {
      sync: { serverId: 's-a', revision: 3, syncStatus: 'synced' },
      meta: { createdBy: 'u1', ownerUserId: 'u1', assignedDoctorUserId: 'u1', organizationId: 'org1' },
    });
    expect(canEditPatient(mine, INTRANET_DOCTOR)).toBe(true);
    const { result } = renderSubject({ initialPatients: [mine], initialActiveId: 'a', session: INTRANET_DOCTOR });
    expect(evaluationDateOf(result, 'a')).toBe(TODAY);
    expect(result.current.patients[0].sync.syncStatus).toBe('dirty');
  });
});

describe('T4 useEvaluationDateSync — 불러오기 배치(A4)', () => {
  it('목록 전체 교체 + 활성 환자 지정이 한 배치면, 옛 활성 환자(새 목록에도 있는 같은 id)에 쓰지 않는다', () => {
    // 처음: a 완료·평가일자 있음 → 쓸 것 없음.
    const { result } = renderSubject({
      initialPatients: [patient('a', { evaluationDate: '2026-01-01' })],
      initialActiveId: 'a',
      session: null,
    });
    expect(writes).toHaveLength(0);

    // 불러오기(useWorkspacePersistence 214-215): setPatients(새 목록) → setActiveId(첫 환자).
    // 새 목록의 a는 미완료라, 중간 상태(새 목록 + 활성 a)를 effect가 봤다면 a의 평가일자를 지웠을 것이다.
    act(() => {
      result.current.rawSetPatients([
        patient('c', { evaluationDate: '2026-02-02' }),
        patient('a', { done: false, evaluationDate: '2026-01-01' }),
      ]);
      result.current.setActiveId('c');
    });

    expect(result.current.activeId).toBe('c');
    expect(evaluationDateOf(result, 'a')).toBe('2026-01-01');
    expect(evaluationDateOf(result, 'c')).toBe('2026-02-02');
    expect(writes).toHaveLength(0);
  });

  it('같은 배치의 최종 활성 환자에는 필요하면 쓴다', () => {
    const { result } = renderSubject({ initialPatients: [patient('a', { evaluationDate: '2026-01-01' })], initialActiveId: 'a', session: null });
    act(() => {
      result.current.rawSetPatients([patient('c'), patient('a', { done: false, evaluationDate: '2026-01-01' })]);
      result.current.setActiveId('c');
    });
    expect(evaluationDateOf(result, 'c')).toBe(TODAY);
    expect(evaluationDateOf(result, 'a')).toBe('2026-01-01');
  });
});
