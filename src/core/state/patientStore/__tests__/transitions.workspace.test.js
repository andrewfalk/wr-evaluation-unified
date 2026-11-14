// 전이 = 옮기기 전 익명 updater(REFACTORING_ROADMAP Phase 2 P2-34, useWorkspacePersistence #4~8).
// 옛 구현을 이 파일에 옮겨 적고 같은 입력에 같은 출력(값·참조)을 내는지 비교한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyWorkspaceSaveAck } from '../../../services/patientServerRepository';
import { patientTx } from '../transitions';

// --- 옛 구현(useWorkspacePersistence.js, main dbb05e9) ---
const oldSaveAck = (sentPatients, ack) => prev => applyWorkspaceSaveAck(prev, sentPatients, ack);
const oldAppend = newPatients => prev => [...prev, ...newPatients];

const at = '2026-11-10T00:00:00.000Z';
function local(id, extra = {}) {
  return { id, updatedAt: at, data: { shared: { name: id }, modules: {}, activeModules: [] }, sync: { syncStatus: 'local-only', serverId: null, revision: 0 }, ...extra };
}
function server(id, revision, extra = {}) {
  return { id, updatedAt: at, data: { shared: { name: id }, modules: {}, activeModules: [] }, sync: { serverId: `s-${id}`, revision, syncStatus: 'dirty' }, ...extra };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-14T03:04:05.000Z'));
});
afterEach(() => { vi.useRealTimers(); });

describe('workspace/saveAckApplied = 옛 저장 응답 updater(#5·#6)', () => {
  const sent = [local('a'), server('b', 2), server('c', 1, { sync: { serverId: 's-c', revision: 1, syncStatus: 'conflict', conflict: { kind: 'push', code: 'CONFLICT', serverRevision: 2 } } })];
  // ack 모양: { saved: [{ id(서버 id), revision, assignedDoctorUserId? }], conflicts: [{ id, serverRevision }], lockedByOther: [{ id, holder }] }
  const acks = [
    ['ack 없음', null],
    ['빈 ack', {}],
    ['저장됨(b·c — c는 이 저장이 만든 충돌이라 풀림)', { saved: [{ id: 's-b', revision: 3, assignedDoctorUserId: 'u9' }, { id: 's-c', revision: 2 }] }],
    ['충돌·락', { conflicts: [{ id: 's-b', serverRevision: 5 }], lockedByOther: [{ id: 's-c', holder: { name: '다른 의사' } }] }],
  ];
  const prevs = [
    ['보낸 그대로', () => sent.map(p => ({ ...p }))],
    ['보낸 뒤 b가 다시 편집됨', () => sent.map(p => (p.id === 'b' ? { ...p, updatedAt: '2026-11-10T00:00:09.000Z', data: { ...p.data, shared: { name: 'b2' } } } : p))],
    ['보낸 뒤 a가 삭제됨', () => sent.filter(p => p.id !== 'a')],
    ['보낸 뒤 b의 revision이 바뀜(오래된 응답)', () => sent.map(p => (p.id === 'b' ? { ...p, sync: { ...p.sync, revision: 4 } } : p))],
  ];
  for (const [ackLabel, ack] of acks) {
    for (const [prevLabel, makePrev] of prevs) {
      it(`${ackLabel} · ${prevLabel}`, () => {
        const prevA = makePrev();
        const prevB = makePrev();
        const expected = oldSaveAck(sent, ack)(prevA);
        const actual = patientTx.saveAckApplied({ sentPatients: sent, ack })(prevB);
        expect(actual).toEqual(expected);
        // 옛 구현이 prev를 그대로 돌려줬으면 새 전이도 prev를 그대로.
        if (expected === prevA) expect(actual).toBe(prevB);
      });
    }
  }

  it('꼬리표: type·payload', () => {
    const tx = patientTx.saveAckApplied({ sentPatients: sent, ack: null });
    expect(tx.type).toBe('workspace/saveAckApplied');
    expect(tx.payload.sentPatients).toBe(sent);
  });
});

describe('patients/appended = 옛 추가 updater(#8·#22)', () => {
  it('끝에 덧붙인 새 배열, 기존 환자는 같은 참조', () => {
    const prev = [local('a'), local('b')];
    const added = [local('c'), local('d')];
    const expected = oldAppend(added)(prev);
    const actual = patientTx.appended({ patients: added })(prev);
    expect(actual).toEqual(expected);
    expect(actual).not.toBe(prev);
    expect(actual[0]).toBe(prev[0]);
    expect(actual[2]).toBe(added[0]);
    expect(patientTx.appended({ patients: [] })(prev)).not.toBe(prev); // 빈 추가도 옛 코드처럼 새 배열
  });
});
