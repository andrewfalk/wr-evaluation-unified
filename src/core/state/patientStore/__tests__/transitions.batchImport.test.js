// 전이 patients/batchImportApplied = 옛 일괄 가져오기 경로(REFACTORING_ROADMAP Phase 2 P2-43, #15).
// 옛 경로: BatchImportModal이 결과 목록을 .map(touchPatientRecord) → usePatientCrud.handleBatchImport가 migratePatientRecords →
// replacedAll + setActiveId(마지막). 새 경로: 모달은 touch 전 목록을 넘기고 전이 하나가 touch → migrate(순서 그대로)·교체·활성(derive).
// 같은 입력(시각 고정)에 같은 출력을 내는지 표로 비교한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migratePatientRecords, touchPatientRecord } from '../../../services/patientRecords';
import { patientTx } from '../transitions';
import { createPatientStore } from '../store';
import { createPatientsState } from '../reducer';

const INTRANET = { mode: 'intranet', apiBaseUrl: 'https://x', accessToken: 't', user: { id: 'u1', organizationId: 'o1', role: 'doctor' } };
const LOCAL = { mode: 'local' };

const oldPipeline = (imported, session) => migratePatientRecords(imported.map(p => touchPatientRecord(p, { session })), { session });

function base(id, sync, extra = {}) {
  return {
    id,
    phase: 'evaluation',
    createdAt: '2026-11-01T00:00:00.000Z',
    data: { shared: { name: id, patientNo: `N-${id}`, diagnoses: [], jobs: [] }, modules: {}, activeModules: [] },
    ...(sync ? { sync } : {}),
    ...extra,
  };
}

const CASES = {
  '서버 synced': base('a', { serverId: 's-a', revision: 3, syncStatus: 'synced' }),
  '서버 dirty': base('b', { serverId: 's-b', revision: 1, syncStatus: 'dirty' }),
  '서버 충돌(push)': base('c', { serverId: 's-c', revision: 2, syncStatus: 'conflict', conflict: { kind: 'push', serverRevision: 3 } }),
  'local-only': base('d', { syncStatus: 'local-only' }),
  '메타 없음(새 환자)': base('e'),
  '일시정지': base('f', { serverId: 's-f', revision: 1, syncStatus: 'dirty', syncPaused: true }),
  '가림 환자': { id: 'g', redacted: true, sync: { serverId: 's-g', revision: 1, syncStatus: 'synced' } },
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-15T09:00:00.000Z'));
});
afterEach(() => { vi.useRealTimers(); });

describe('patients/batchImportApplied = 옛 일괄 가져오기(touch → migrate)', () => {
  for (const session of [INTRANET, LOCAL]) {
    for (const [label, patient] of Object.entries(CASES)) {
      it(`${label} · ${session.mode}`, () => {
        const imported = [structuredClone(patient)];
        const expected = oldPipeline(structuredClone(imported), session);
        const actual = patientTx.batchImportApplied({ importedPatients: imported, session })([base('old', { syncStatus: 'local-only' })]);
        expect(actual).toEqual(expected);
      });
    }

    it(`여러 명·순서 그대로 · ${session.mode}`, () => {
      const imported = Object.values(CASES).map(p => structuredClone(p));
      const expected = oldPipeline(structuredClone(imported), session);
      const actual = patientTx.batchImportApplied({ importedPatients: imported, session })([]);
      expect(actual).toEqual(expected);
      expect(actual.map(p => p.id)).toEqual(imported.map(p => p.id));
    });
  }

  it('목록을 통째로 교체하고(이전 목록 무시) 마지막 환자를 활성으로 — 빈 결과면 활성 그대로', () => {
    const store = createPatientStore(createPatientsState([base('old')], { activeId: 'old' }), () => {});
    store.dispatch(patientTx.batchImportApplied({ importedPatients: [base('x'), base('y')], session: LOCAL }));
    expect(store.getState().patients.map(p => p.id)).toEqual(['x', 'y']);
    expect(store.getState().activeId).toBe('y');
    store.dispatch(patientTx.batchImportApplied({ importedPatients: [], session: LOCAL }));
    expect(store.getState().patients).toEqual([]);
    expect(store.getState().activeId).toBe('y'); // 옛 handleBatchImport도 빈 결과면 setActiveId를 부르지 않았다
  });
});
