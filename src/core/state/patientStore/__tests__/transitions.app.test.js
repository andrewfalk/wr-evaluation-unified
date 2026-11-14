// 전이 = 옮기기 전 익명 updater(REFACTORING_ROADMAP Phase 2 P2-37, App #1~3). 옛 구현을 옮겨 적고 비교한다.
import { describe, expect, it } from 'vitest';
import { patientTx } from '../transitions';

// --- 옛 구현(App.jsx, main) ---
const oldPause = currentId => prev => prev.map(p => (p.id === currentId ? { ...p, sync: { ...(p.sync || {}), syncPaused: true } } : p));
const oldVideoApplied = serverPatient => prev => prev.map(p => (p.id === serverPatient.id ? serverPatient : p));

function list() {
  return [
    { id: 'a', data: {}, sync: { serverId: 's-a', revision: 1, syncStatus: 'dirty' } },
    { id: 'b', data: {} }, // sync 없음
    { id: 'c', data: {}, sync: { serverId: 's-c', revision: 2, syncStatus: 'conflict', syncPaused: false } },
  ];
}

describe('sync/patientPaused = 옛 "저장하지 않고 이동" updater(#1)', () => {
  for (const id of ['a', 'b', 'c', 'missing']) {
    it(id, () => {
      const prev = list();
      const actual = patientTx.patientPaused({ id })(prev);
      expect(actual).toEqual(oldPause(id)(list()));
      expect(actual).not.toBe(prev);
      prev.forEach((p, i) => { if (p.id !== id) expect(actual[i]).toBe(p); });
    });
  }
});

describe('patient/replacedFromServer(keepLocalMeta: false) = 옛 영상 분석 서버 적용 updater(#2)', () => {
  for (const id of ['a', 'missing']) {
    it(id, () => {
      const prev = list();
      const serverPatient = { id, data: { shared: { name: 'server' } }, meta: { createdBy: 'srv' }, sync: { serverId: `s-${id}`, revision: 5, syncStatus: 'synced' } };
      const actual = patientTx.replacedFromServer({ id, serverPatient, keepLocalMeta: false })(prev);
      expect(actual).toEqual(oldVideoApplied(serverPatient)(list()));
      if (id === 'a') expect(actual[0]).toBe(serverPatient); // 서버 값 그 참조 그대로
      prev.forEach((p, i) => { if (p.id !== id) expect(actual[i]).toBe(p); });
    });
  }
});

describe('patients/replacedAll([]) = 옛 setPatients([])(#3 초기화)', () => {
  it('빈 배열', () => {
    const empty = [];
    expect(patientTx.replacedAll({ patients: empty })(list())).toBe(empty);
  });
});
