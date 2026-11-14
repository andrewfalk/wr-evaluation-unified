// 전이 = 옮기기 전 익명 updater(REFACTORING_ROADMAP Phase 2 P2-33, usePatientCrud #13~16).
// 옛 구현을 이 파일에 그대로 옮겨 적고 같은 입력에 같은 출력(값·참조)을 내는지 표로 비교한다 — 운영 코드의 옛 구현은 같은 PR에서 지웠다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { touchPatientRecord } from '../../../services/patientRecords';
import { isPatientTransition, patientTx } from '../transitions';

const NOW = new Date('2026-11-14T03:04:05.000Z');
const SESSION_LOCAL = { mode: 'local' };
const SESSION_INTRANET = { mode: 'intranet', user: { id: 'u1', organizationId: 'org1' } };

// --- 옛 구현(usePatientCrud.js, main 799ac02) ---
const oldUpdatePatient = (activeId, updater, session) => prev => prev.map(p =>
  p.id === activeId
    ? touchPatientRecord(
      {
        ...p,
        updatedAt: new Date().toISOString(),
        data: typeof updater === 'function' ? updater(p.data) : { ...p.data, ...updater },
      },
      { session }
    )
    : p
);

function fixtures() {
  return [
    { id: 'local', data: { shared: { name: 'L' }, modules: { knee: { a: 1 } }, activeModules: ['knee'] }, sync: { syncStatus: 'local-only' }, meta: { createdBy: 'u1' } },
    { id: 'server', data: { shared: { name: 'S' }, modules: {}, activeModules: [] }, sync: { serverId: 's1', revision: 3, syncStatus: 'synced' }, meta: { createdBy: 'u1', organizationId: 'org1' }, updatedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'conflict', data: { shared: { name: 'C' }, modules: {}, activeModules: [] }, sync: { serverId: 's2', revision: 1, syncStatus: 'conflict', conflict: { kind: 'push', code: 'CONFLICT' } } },
    { id: 'redacted', redacted: true, data: { shared: { name: 'R' }, modules: {}, activeModules: [] }, sync: { serverId: 's3', revision: 1, syncStatus: 'synced' } },
  ];
}

const EDITS = [
  ['객체 합치기', { activeModules: ['knee', 'spine'] }],
  ['함수 updater', d => ({ ...d, shared: { ...d.shared, name: `${d.shared.name}!` } })],
];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => { vi.useRealTimers(); });

describe('patient/dataEdited = 옛 updatePatient updater(#13)', () => {
  const ids = ['local', 'server', 'conflict', 'redacted', 'missing', null];
  for (const id of ids) {
    for (const [label, edit] of EDITS) {
      for (const session of [SESSION_LOCAL, SESSION_INTRANET]) {
        it(`id=${id} · ${label} · ${session.mode}`, () => {
          const input = fixtures();
          const expected = oldUpdatePatient(id, edit, session)(fixtures());
          const tx = patientTx.dataEdited({ id, edit, session, stampUpdatedAt: true });
          const actual = tx(input);
          expect(actual).toEqual(expected);
          expect(actual).not.toBe(input); // 옛 코드처럼 늘 새 배열
          input.forEach((p, i) => {
            if (p.id !== id) expect(actual[i]).toBe(p); // 대상이 아닌 환자는 같은 참조
          });
        });
      }
    }
  }

  it('touch 뒤 updatedAt = 주입한 시계(수동 stamp 없이도 일반 환자는 같다)', () => {
    const [local] = fixtures();
    const stamped = patientTx.dataEdited({ id: 'local', edit: {}, session: SESSION_LOCAL, stampUpdatedAt: true })([local]);
    const unstamped = patientTx.dataEdited({ id: 'local', edit: {}, session: SESSION_LOCAL })([local]);
    expect(stamped[0].updatedAt).toBe(NOW.toISOString());
    expect(unstamped).toEqual(stamped);
  });

  it('꼬리표: type·payload', () => {
    const payload = { id: 'local', edit: {}, session: null };
    const tx = patientTx.dataEdited(payload);
    expect(isPatientTransition(tx)).toBe(true);
    expect(tx.type).toBe('patient/dataEdited');
    expect(tx.payload).toBe(payload);
  });
});

describe('patients/replacedAll = 옛 setPatients(값)(#14·#15·#16)', () => {
  it('prev와 무관하게 payload 배열을 그 참조 그대로 낸다', () => {
    const next = fixtures();
    const tx = patientTx.replacedAll({ patients: next });
    expect(tx(fixtures())).toBe(next);
    expect(tx([])).toBe(next);
    expect(tx.type).toBe('patients/replacedAll');
  });
});
