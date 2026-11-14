// 전이 = 옮기기 전 익명 updater(REFACTORING_ROADMAP Phase 2 P2-35, useConflictResolution #9~12).
// 옛 구현을 이 파일에 옮겨 적고 같은 입력에 같은 출력(값·참조)을 내는지 비교한다.
import { describe, expect, it, vi } from 'vitest';
import { resolvePatientConflictInList } from '../../../services/patientConflictResolution';
import { patientTx } from '../transitions';

// --- 옛 구현(useConflictResolution.js, main) — #9는 updater 안 예약을 빼고 본체만 ---
const oldResolved = (patientId, resolution, options) => prev => resolvePatientConflictInList(prev, patientId, resolution, options);
const oldRemoteDelete = patientId => prev => prev.map(p => (
  p.id === patientId
    ? { ...p, sync: { ...(p.sync || {}), syncStatus: 'conflict', conflict: { ...(p.sync?.conflict || {}), kind: 'remote-delete', serverRevision: null } } }
    : p
));
const oldCorrected = (patient, corrected) => prev => prev.map(p => (
  p.id === patient.id ? { ...corrected, id: patient.id, meta: p.meta ?? corrected.meta } : p
));
const oldDeleteRevision = (patient, error) => prev => prev.map(p => (
  p.id === patient.id
    ? {
        ...p,
        sync: {
          ...(p.sync || {}),
          syncStatus: 'conflict',
          conflict: {
            ...(p.sync?.conflict || {}),
            serverRevision: error?.data?.currentRevision ?? p.sync?.conflict?.serverRevision ?? null,
          },
        },
      }
    : p
));

function list() {
  return [
    { id: 'a', meta: { createdBy: 'u1' }, data: { shared: { name: 'A' }, modules: {}, activeModules: [] }, sync: { serverId: 's-a', revision: 2, syncStatus: 'conflict', conflict: { kind: 'push', serverRevision: 3 } } },
    { id: 'b', data: { shared: { name: 'B' }, modules: {}, activeModules: [] }, sync: { serverId: 's-b', revision: 1, syncStatus: 'conflict', conflict: { kind: 'remote-delete', serverRevision: null } } },
    { id: 'c', data: { shared: { name: 'C' }, modules: {}, activeModules: [] }, sync: { serverId: 's-c', revision: 1, syncStatus: 'conflict', conflict: { kind: 'delete', serverRevision: 4 } } },
    { id: 'd', data: { shared: { name: 'D' }, modules: {}, activeModules: [] } },
  ];
}
const SERVER = { id: 's-a', data: { shared: { name: 'A-server' }, modules: {}, activeModules: [] }, sync: { serverId: 's-a', revision: 3, syncStatus: 'synced' }, meta: { createdBy: 'srv' } };

describe('conflict/resolved = 옛 resolvePatientConflictInList updater(#9)', () => {
  const cases = [
    ['a', 'use-local', { serverPatient: SERVER }],
    ['a', 'use-server', { serverPatient: SERVER }],
    ['a', 'merge', { serverPatient: SERVER, mergedData: { shared: { name: 'merged' }, modules: {}, activeModules: [] } }],
    ['b', 'use-local', { newId: 'b-new' }],
    ['b', 'use-server', { serverPatient: null }],
    ['b', 'merge', { mergedData: { shared: {}, modules: {}, activeModules: [] }, newId: 'b-merged' }],
    ['c', 'use-local', {}],
    ['c', 'use-server', { serverPatient: { ...SERVER, id: 's-c' } }],
    ['d', 'unknown-resolution', {}],
    ['missing', 'use-local', {}],
  ];
  for (const [id, resolution, options] of cases) {
    it(`${id} · ${resolution}`, () => {
      const prev = list();
      const expected = oldResolved(id, resolution, options)(list());
      const onReduced = vi.fn();
      const actual = patientTx.conflictResolved({ patientId: id, resolution, options, onReduced })(prev);
      expect(actual).toEqual(expected);
      prev.forEach((p, i) => { if (p.id !== id) expect(actual).toContain(prev[i]); }); // 비대상은 같은 참조
      expect(onReduced).toHaveBeenCalledTimes(1);
      expect(onReduced.mock.calls[0][0]).toBe(prev);
      expect(onReduced.mock.calls[0][1]).toBe(actual);
    });
  }

  it('onReduced 없이도 동작하고 type은 conflict/resolved', () => {
    const tx = patientTx.conflictResolved({ patientId: 'c', resolution: 'use-local' });
    expect(tx.type).toBe('conflict/resolved');
    expect(tx(list()).map(p => p.id)).toEqual(['a', 'b', 'd']);
  });
});

describe('conflict/remoteDeleteMarked = 옛 markRemoteDeleteConflict updater(#10)', () => {
  for (const id of ['a', 'b', 'd', 'missing']) {
    it(id, () => {
      const prev = list();
      const actual = patientTx.remoteDeleteMarked({ id })(prev);
      expect(actual).toEqual(oldRemoteDelete(id)(list()));
      expect(actual).not.toBe(prev);
      prev.forEach((p, i) => { if (p.id !== id) expect(actual[i]).toBe(p); });
    });
  }
});

describe('patient/replacedFromServer = 옛 생년월일 정정 updater(#11, keepLocalMeta)', () => {
  it('로컬 id와 로컬 meta(없으면 서버 meta)를 유지하고 다른 환자는 같은 참조', () => {
    for (const id of ['a', 'd', 'missing']) {
      const prev = list();
      const corrected = { ...SERVER, id: `srv-${id}` };
      const actual = patientTx.replacedFromServer({ id, serverPatient: corrected, keepLocalMeta: true })(prev);
      expect(actual).toEqual(oldCorrected({ id }, corrected)(list()));
      prev.forEach((p, i) => { if (p.id !== id) expect(actual[i]).toBe(p); });
    }
  });
});

describe('conflict/deleteRevisionUpdated = 옛 삭제 실패 revision 갱신 updater(#12)', () => {
  const errors = [
    ['currentRevision 있음', { data: { currentRevision: 9 } }],
    ['currentRevision 0', { data: { currentRevision: 0 } }],
    ['currentRevision 없음 → 기존 serverRevision', { data: {} }],
    ['error 없음', undefined],
  ];
  for (const id of ['a', 'b', 'd']) {
    for (const [label, error] of errors) {
      it(`${id} · ${label}`, () => {
        const prev = list();
        const actual = patientTx.deleteRevisionUpdated({ id, currentRevision: error?.data?.currentRevision })(prev);
        expect(actual).toEqual(oldDeleteRevision({ id }, error)(list()));
        prev.forEach((p, i) => { if (p.id !== id) expect(actual[i]).toBe(p); });
      });
    }
  }
});
