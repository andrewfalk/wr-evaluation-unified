// scripts/arch-metrics.mjs — 게이트 B 스토어 규칙(REFACTORING_ROADMAP Phase 2 P2-40a, 게이트 B 계획 설계 5).
//   untaggedSetPatients: `dispatch(` / `store.dispatch(`도 꼬리표 전이(`patientTx.…`)만.
//   storeGetStateOutsideSync: 스토어의 앞선 상태(getState)는 src/core/state/·src/core/sync/ 밖에서 읽지 않는다.
import { describe, expect, it } from 'vitest';
import { scanFile } from './arch-metrics.mjs';

describe('arch-metrics untaggedSetPatients — dispatch(P2-40a)', () => {
  it('꼬리표 전이가 아닌 dispatch 호출(맨 호출·store.dispatch)을 센다', () => {
    const src = [
      'store.dispatch(prev => prev);',
      'dispatch(next);',
      'store.dispatch(patientTx.appended({ patients }));',
      'dispatch( patientTx . replacedAll({ patients: [] }));',
    ].join('\n');
    expect(scanFile('src/core/hooks/useX.js', src).untaggedSetPatients).toBe(2);
  });

  it('dispatchEvent·onDispatch·함수 선언·주석·스토어 계층은 세지 않는다', () => {
    const src = [
      'window.dispatchEvent(new Event("x"));',
      'onDispatch(value);',
      'redispatch(value);',
      'function dispatch(action) { return action; }',
      '// store.dispatch(prev => prev)',
    ].join('\n');
    expect(scanFile('src/core/hooks/useY.js', src).untaggedSetPatients).toBeUndefined();
    expect(scanFile('src/core/state/patientStore/store.ts', 'update(x); dispatch(arg);').untaggedSetPatients).toBeUndefined();
  });

  it('setPatients와 dispatch를 합쳐 센다', () => {
    expect(scanFile('src/App.jsx', 'setPatients([]);\nstore.dispatch(next);').untaggedSetPatients).toBe(2);
  });
});

describe('arch-metrics storeGetStateOutsideSync(P2-40a)', () => {
  it('스토어·sync 계층 밖 제품 코드의 getState 호출(맨 호출·멤버 호출)을 센다', () => {
    const src = [
      'const { patients } = store.getState();',
      'const s = getState();',
      'store.getState ().activeId;',
    ].join('\n');
    expect(scanFile('src/App.jsx', src).storeGetStateOutsideSync).toBe(3);
  });

  it('src/core/state/·src/core/sync/·테스트·함수 선언·주석·속성 정의는 세지 않는다', () => {
    expect(scanFile('src/core/state/patientStore/store.ts', 'store.getState();').storeGetStateOutsideSync).toBeUndefined();
    expect(scanFile('src/core/sync/patientSyncEngine.ts', 'store.getState();').storeGetStateOutsideSync).toBeUndefined();
    expect(scanFile('src/core/hooks/__tests__/x.test.jsx', 'store.getState();').storeGetStateOutsideSync).toBeUndefined();
    const src = [
      'function getState() { return 1; }',
      '// store.getState()',
      'const api = { getState: () => ahead };',
      'useStatsState(); getStateLabel();',
    ].join('\n');
    expect(scanFile('src/core/hooks/useZ.js', src).storeGetStateOutsideSync).toBeUndefined();
  });
});
