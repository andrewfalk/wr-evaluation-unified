// 전이 = 옮기기 전 익명 updater(REFACTORING_ROADMAP Phase 2 P2-39, usePatientSync #17~19). 옛 구현을 옮겨 적고 비교한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyPushFailures, mergePushedPatientAck, reconcilePulledPatients } from '../../../services/patientServerRepository';
import { requiresLock } from '../../../hooks/usePatientLock';
import { patientTx } from '../transitions';

// --- 옛 구현(usePatientSync.js, main 3c2a276) ---
function applySyncedPatients(localPatients, syncedPairs) {
  return syncedPairs.reduce((next, { patient: pushedPatient, serverPatient }) => mergePushedPatientAck(next, serverPatient, pushedPatient), localPatients);
}
const oldPush = (synced, failed) => prev => applyPushFailures(applySyncedPatients(prev, synced), failed);
const oldPullBody = (pulledItems, pulledScope) => prev => reconcilePulledPatients(prev, pulledItems, { authoritativeDeletes: pulledScope === 'all' });
const oldResume = (activeId, lockStatus, session) => prev => {
  const current = prev.find(p => p.id === activeId);
  if (!current?.sync?.syncPaused) return prev;
  const stillBlocked = requiresLock(current, session) && lockStatus !== 'held';
  if (stillBlocked) return prev;
  return prev.map(p => (p.id === activeId ? { ...p, sync: { ...p.sync, syncPaused: false } } : p));
};

const INTRANET = { mode: 'intranet', user: { id: 'u1' }, accessToken: 't' };
const at = '2026-11-10T00:00:00.000Z';
function list() {
  return [
    { id: 'a', updatedAt: at, data: { shared: { name: 'A' } }, sync: { serverId: 's-a', revision: 1, syncStatus: 'dirty' } },
    { id: 'b', updatedAt: at, data: { shared: { name: 'B' } }, sync: { serverId: 's-b', revision: 2, syncStatus: 'synced' } },
    { id: 'c', updatedAt: at, data: { shared: { name: 'C' } }, sync: { serverId: null, revision: 0, syncStatus: 'local-only' } },
    { id: 'p', updatedAt: at, data: { shared: { name: 'P' } }, sync: { serverId: 's-p', revision: 1, syncStatus: 'dirty', syncPaused: true } },
    { id: 'q', updatedAt: at, data: { shared: { name: 'Q' } }, sync: { serverId: null, revision: 0, syncStatus: 'local-only', syncPaused: true } },
  ];
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-14T07:08:09.000Z'));
});
afterEach(() => { vi.useRealTimers(); });

describe('sync/pushResultsApplied = 옛 push 결과 updater(#17)', () => {
  const sent = list();
  const cases = [
    ['성공 1(보낸 그대로)', [{ patient: sent[0], serverPatient: { ...sent[0], sync: { serverId: 's-a', revision: 2, syncStatus: 'synced', lastSyncedAt: at } } }], []],
    ['성공 POST(로컬→서버 id)', [{ patient: sent[2], serverPatient: { ...sent[2], sync: { serverId: 's-c', revision: 1, syncStatus: 'synced', lastSyncedAt: at } } }], []],
    ['충돌', [], [{ patient: sent[0], kind: 'conflict', error: { status: 409, data: { code: 'CONFLICT', currentRevision: 5 } } }]],
    ['락', [], [{ patient: sent[0], kind: 'lock', error: { status: 423, data: { code: 'LOCK_HELD', holder: { name: 'x' } } } }]],
    ['성공+충돌', [{ patient: sent[2], serverPatient: { ...sent[2], sync: { serverId: 's-c', revision: 1, syncStatus: 'synced' } } }], [{ patient: sent[0], kind: 'conflict', error: { status: 409, data: { currentRevision: 3 } } }]],
  ];
  const prevs = [
    ['보낸 그대로', () => list()],
    ['보낸 뒤 a 재편집', () => list().map(p => (p.id === 'a' ? { ...p, updatedAt: '2026-11-10T00:00:05.000Z', data: { shared: { name: 'A2' } } } : p))],
  ];
  for (const [label, synced, failed] of cases) {
    for (const [prevLabel, makePrev] of prevs) {
      it(`${label} · ${prevLabel}`, () => {
        const prev = makePrev();
        const actual = patientTx.pushResultsApplied({ synced, failed })(prev);
        expect(actual).toEqual(oldPush(synced, failed)(makePrev()));
      });
    }
  }
});

describe('sync/pullApplied = 옛 pull 병합 updater 본체(#18)', () => {
  const pulls = [
    ['빈 pull', []],
    ['b 갱신·새 환자 d', [{ id: 's-b', data: { shared: { name: 'B-srv' } }, sync: { serverId: 's-b', revision: 3, syncStatus: 'synced' } }, { id: 's-d', data: {}, sync: { serverId: 's-d', revision: 1, syncStatus: 'synced' } }]],
    ['a(dirty) 서버가 앞섬', [{ id: 's-a', data: {}, sync: { serverId: 's-a', revision: 9, syncStatus: 'synced' } }]],
  ];
  for (const [label, items] of pulls) {
    for (const scope of ['mine', 'all']) {
      it(`${label} · scope=${scope}`, () => {
        const prev = list();
        const onReduced = vi.fn();
        const actual = patientTx.pullApplied({ pulledItems: items, authoritativeDeletes: scope === 'all', onReduced })(prev);
        expect(actual).toEqual(oldPullBody(items, scope)(list()));
        expect(onReduced).toHaveBeenCalledTimes(1);
        expect(onReduced.mock.calls[0][0]).toBe(prev);
        expect(onReduced.mock.calls[0][1]).toBe(actual);
      });
    }
  }
});

describe('sync/patientResumed = 옛 syncPaused 해제 updater(#19) — 바뀔 게 없으면 prev 그대로', () => {
  for (const id of ['p', 'q', 'a', 'missing']) {
    for (const lockStatus of ['held', 'acquiring', 'none', undefined]) {
      for (const session of [INTRANET, { mode: 'local' }]) {
        it(`${id} · ${lockStatus} · ${session.mode}`, () => {
          const prev = list();
          const expectedPrev = list();
          const expected = oldResume(id, lockStatus, session)(expectedPrev);
          const actual = patientTx.patientResumed({ id, lockStatus, session })(prev);
          expect(actual).toEqual(expected);
          if (expected === expectedPrev) expect(actual).toBe(prev);
          else expect(actual).not.toBe(prev);
        });
      }
    }
  }
});
