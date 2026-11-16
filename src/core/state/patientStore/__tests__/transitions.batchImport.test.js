// 전이 patients/batchImportApplied(REFACTORING_ROADMAP Phase 2 P2-43, #15 · flagged P2-43b).
// P2-43: 모달이 하던 touch를 전이 안으로(touch → migrate 순서 그대로). 표 테스트: 반영되는 환자 하나하나는 옛 경로
// (`migratePatientRecords(list.map(touchPatientRecord))`)와 같은 결과(시각 고정).
// P2-43b(D2): 목록을 통째로 교체하지 않고 적용 시점 목록에 병합 — 행이 바꾼 기존 환자만 그 사본으로(touch), 손대지 않은 환자는 같은
// 객체, 새 환자는 끝에. 사본을 뜬 뒤 달라졌거나(revision·updatedAt) 지워진 기존 환자는 건너뛰고 receipt.skipped로 센다.
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
    updatedAt: '2026-11-02T00:00:00.000Z',
    data: { shared: { name: id, patientNo: `N-${id}`, diagnoses: [], jobs: [] }, modules: {}, activeModules: [] },
    ...(sync ? { sync } : {}),
    ...extra,
  };
}
const baseOf = (p) => ({ revision: p.sync?.revision ?? null, updatedAt: p.updatedAt ?? null });
/** 가져오기 행이 바꾼 사본(상병 1건 추가) */
const edited = (p) => {
  const copy = structuredClone(p);
  if (copy.data) copy.data.shared.diagnoses = [{ id: `${p.id}-dx`, code: 'M17.0', name: 'oa', side: '' }];
  return copy;
};

const CASES = {
  '서버 synced': base('a', { serverId: 's-a', revision: 3, syncStatus: 'synced' }),
  '서버 dirty': base('b', { serverId: 's-b', revision: 1, syncStatus: 'dirty' }),
  '서버 충돌(push)': base('c', { serverId: 's-c', revision: 2, syncStatus: 'conflict', conflict: { kind: 'push', serverRevision: 3 } }),
  'local-only': base('d', { syncStatus: 'local-only' }),
  '메타 없음(새 환자)': base('e'),
  '일시정지': base('f', { serverId: 's-f', revision: 1, syncStatus: 'dirty', syncPaused: true }),
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-15T09:00:00.000Z'));
});
afterEach(() => { vi.useRealTimers(); });

describe('patients/batchImportApplied — 반영되는 환자는 옛 경로와 같은 결과(touch → migrate)', () => {
  for (const session of [INTRANET, LOCAL]) {
    for (const [label, patient] of Object.entries(CASES)) {
      it(`바뀐 기존 환자 · ${label} · ${session.mode}`, () => {
        const other = base('z', { serverId: 's-z', revision: 1, syncStatus: 'synced' });
        const prev = [structuredClone(patient), other];
        const changedCopy = edited(patient);
        const expected = oldPipeline([structuredClone(changedCopy)], session)[0];
        const actual = patientTx.batchImportApplied({ newPatients: [], changed: [{ patient: changedCopy, base: baseOf(patient) }], session })(prev);
        expect(actual[0]).toEqual(expected);
        expect(actual[1]).toBe(prev[1]); // 손대지 않은 환자는 같은 객체(touch·dirty 없음)
      });

      it(`새 환자 · ${label} · ${session.mode}`, () => {
        const prev = [base('z', { serverId: 's-z', revision: 1, syncStatus: 'synced' })];
        const expected = oldPipeline([structuredClone(patient)], session);
        const actual = patientTx.batchImportApplied({ newPatients: [structuredClone(patient)], changed: [], session })(prev);
        expect(actual).toEqual([prev[0], ...expected]);
        expect(actual[0]).toBe(prev[0]);
      });
    }
  }
});

describe('patients/batchImportApplied — 최신 목록에 병합(P2-43b)', () => {
  it('사본을 뜬 뒤 달라진(revision·updatedAt) 기존 환자와 지워진 환자는 건너뛰고 receipt에 센다', () => {
    const a = base('a', { serverId: 's-a', revision: 1, syncStatus: 'synced' });
    const b = base('b', { serverId: 's-b', revision: 1, syncStatus: 'synced' });
    const gone = base('g', { serverId: 's-g', revision: 1, syncStatus: 'synced' });
    const bAfterPull = { ...b, updatedAt: '2026-11-14T00:00:00.000Z', sync: { ...b.sync, revision: 2 } };
    const receipt = {};
    const prev = [a, bAfterPull]; // g는 그사이 지워짐
    const actual = patientTx.batchImportApplied({
      newPatients: [base('n')],
      changed: [{ patient: edited(a), base: baseOf(a) }, { patient: edited(b), base: baseOf(b) }, { patient: edited(gone), base: baseOf(gone) }],
      session: INTRANET,
      receipt,
    })(prev);
    expect(actual.map(p => p.id)).toEqual(['a', 'b', 'n']);
    expect(actual[0].data.shared.diagnoses).toHaveLength(1);
    expect(actual[0].sync.syncStatus).toBe('dirty');
    expect(actual[1]).toBe(bAfterPull); // 건너뜀 — pull 결과 유지
    expect(receipt).toEqual({ skipped: 2, total: 3 });
  });

  it('스토어 경로: 결과 목록의 마지막 환자를 활성으로 — 결과가 비면 활성 그대로', () => {
    const store = createPatientStore(createPatientsState([base('old')], { activeId: 'old' }), () => {});
    store.dispatch(patientTx.batchImportApplied({ newPatients: [base('x'), base('y')], changed: [], session: LOCAL }));
    expect(store.getState().patients.map(p => p.id)).toEqual(['old', 'x', 'y']);
    expect(store.getState().activeId).toBe('y');
    const empty = createPatientStore(createPatientsState([], { activeId: null }), () => {});
    empty.dispatch(patientTx.batchImportApplied({ newPatients: [], changed: [], session: LOCAL }));
    expect(empty.getState().activeId).toBeNull();
  });
});
