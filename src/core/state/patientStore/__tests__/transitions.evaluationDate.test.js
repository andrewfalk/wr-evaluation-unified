// 전이 = 옮기기 전 익명 updater(REFACTORING_ROADMAP Phase 2 P2-38, useEvaluationDateSync #24). 옛 구현을 옮겨 적고 비교한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { touchPatientRecord } from '../../../services/patientRecords';
import { patientTx } from '../transitions';

// --- 옛 구현(src/core/hooks/useEvaluationDateSync.js, main 6f41cfa — 이 PR에서 삭제) ---
const oldUpdater = (activeId, nextEvaluationDate, session) => prev => prev.map(x =>
  x.id === activeId
    ? touchPatientRecord(
      { ...x, data: { ...x.data, shared: { ...x.data.shared, evaluationDate: nextEvaluationDate } } },
      { session }
    )
    : x
);

function list() {
  return [
    { id: 'local', data: { shared: { name: 'L', evaluationDate: '' }, modules: {}, activeModules: [] }, sync: { syncStatus: 'local-only' } },
    { id: 'server', data: { shared: { name: 'S', evaluationDate: '2026-01-01' }, modules: {}, activeModules: [] }, sync: { serverId: 's1', revision: 2, syncStatus: 'synced' }, meta: { createdBy: 'u2', assignedDoctorUserId: 'u2' } },
    { id: 'redacted', redacted: true, data: { shared: {}, modules: {}, activeModules: [] }, sync: { serverId: 's2', revision: 1, syncStatus: 'synced' } },
  ];
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-14T06:07:08.000Z'));
});
afterEach(() => { vi.useRealTimers(); });

describe('patient/evaluationDateSynced = 옛 평가일자 updater(#24)', () => {
  for (const id of ['local', 'server', 'redacted', 'missing']) {
    for (const date of ['2026-11-14', '']) {
      for (const session of [null, { mode: 'intranet', user: { id: 'u1' } }]) {
        it(`${id} · "${date}" · ${session ? 'intranet' : 'local'}`, () => {
          const prev = list();
          const actual = patientTx.evaluationDateSynced({ id, evaluationDate: date, session })(prev);
          expect(actual).toEqual(oldUpdater(id, date, session)(list()));
          expect(actual).not.toBe(prev);
          prev.forEach((p, i) => { if (p.id !== id) expect(actual[i]).toBe(p); });
        });
      }
    }
  }
});
