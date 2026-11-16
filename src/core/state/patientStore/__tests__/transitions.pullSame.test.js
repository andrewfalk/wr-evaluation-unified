// D3 — pull 결과가 지금 목록과 같으면 지금 목록을 그대로 돌려준다(REFACTORING_ROADMAP Phase 2 게이트 B 뒤 D3, 사용자 결정 2026-11-16 "A 방식").
// 옮기기 전에는 pull 병합(reconcilePulledPatients)이 서버 내용이 같아도 synced 환자를 새 객체로 다시 만들고 늘 새 배열을 내서,
// push할 수 없는 dirty 환자(403 등)가 하나라도 있으면 "목록 바뀜 → 1초 debounce → push(실패) + pull → 새 배열"이 약 1초마다
// 반복됐다(T5-8). 이제 sync/pullApplied는 내용이 같은 환자는 직전 객체를, 전부 같으면 직전 배열을 쓴다.
import { describe, expect, it } from 'vitest';
import { patientTx } from '../transitions';

function serverPatient(id, sync = {}, shared = {}) {
  return {
    id,
    updatedAt: '2026-11-10T00:00:00.000Z',
    data: { shared: { name: id, diagnoses: [], ...shared }, modules: {}, activeModules: [] },
    sync: { serverId: `s-${id}`, revision: 1, syncStatus: 'synced', lastSyncedAt: '2026-11-10T00:00:00.000Z', ...sync },
  };
}
// 서버가 돌려주는 새 객체(내용은 같음)
const fresh = (p) => structuredClone(p);

describe('sync/pullApplied — 서버 내용이 같으면 지금 목록 그대로(D3)', () => {
  for (const authoritativeDeletes of [false, true]) {
    const scope = authoritativeDeletes ? 'all' : 'mine';

    it(`synced 환자만 있고 서버 내용이 같으면 같은 배열 · ${scope}`, () => {
      const prev = [serverPatient('a'), serverPatient('b')];
      const next = patientTx.pullApplied({ pulledItems: prev.map(fresh), authoritativeDeletes })(prev);
      expect(next).toBe(prev);
    });

    it(`push 못 하는 dirty 환자가 있어도 서버 내용이 같으면 같은 배열 · ${scope}`, () => {
      const prev = [serverPatient('a'), serverPatient('b', { syncStatus: 'dirty' }, { name: 'b-local-edit' })];
      // 서버는 b를 옛 내용(revision 1)으로 돌려준다 — 로컬 dirty가 이긴다
      const next = patientTx.pullApplied({ pulledItems: [fresh(serverPatient('a')), fresh(serverPatient('b'))], authoritativeDeletes })(prev);
      expect(next).toBe(prev);
    });

    it(`서버에서 바뀐 환자만 새 객체, 나머지는 직전 객체 그대로 · ${scope}`, () => {
      const prev = [serverPatient('a'), serverPatient('b'), serverPatient('c')];
      const changed = serverPatient('b', { revision: 2 }, { name: 'b-server-edit' });
      const next = patientTx.pullApplied({ pulledItems: [fresh(prev[0]), changed, fresh(prev[2])], authoritativeDeletes })(prev);
      expect(next).not.toBe(prev);
      expect(next[0]).toBe(prev[0]);
      expect(next[1]).toEqual(changed);
      expect(next[2]).toBe(prev[2]);
    });
  }

  it('새 환자가 들어오거나 범위 밖 환자가 빠지면 새 배열(같은 환자는 직전 객체)', () => {
    const prev = [serverPatient('a'), serverPatient('b')];
    const added = patientTx.pullApplied({ pulledItems: [fresh(prev[0]), fresh(prev[1]), serverPatient('c')], authoritativeDeletes: false })(prev);
    expect(added.map(p => p.id)).toEqual(['a', 'b', 'c']);
    expect(added[0]).toBe(prev[0]);
    const removed = patientTx.pullApplied({ pulledItems: [fresh(prev[0])], authoritativeDeletes: false })(prev);
    expect(removed.map(p => p.id)).toEqual(['a']);
    expect(removed[0]).toBe(prev[0]);
  });

  it('충돌 환자는 같은 서버 내용이 다시 와도 직전 객체(충돌 표시가 그대로면)', () => {
    const server = serverPatient('a', { revision: 3 }, { name: 'server' });
    const prev = [patientTx.pullApplied({ pulledItems: [server], authoritativeDeletes: false })([serverPatient('a', { syncStatus: 'dirty' }, { name: 'local' })])[0]];
    expect(prev[0].sync.syncStatus).toBe('conflict');
    const next = patientTx.pullApplied({ pulledItems: [fresh(server)], authoritativeDeletes: false })(prev);
    expect(next).toBe(prev);
  });
});
