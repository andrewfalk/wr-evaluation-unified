// window.electron 스텁(REFACTORING_ROADMAP Phase 2 P2-02) — G9 App 스모크와 플랫폼 어댑터 테스트용.
//
// 키 집합은 구 셸 표면(fixtures/legacyShellSurface.json — 현장 설치본, E0 전)을 그대로 쓴다. 새 셸(E0 뒤)은
// `{ buildTarget }`만 더한다(window.electron 키는 Phase 2 동안 "추가만"). 함수는 전부 호출을 기록하고
// (`bridge.__calls`), invoke 계열은 overrides가 없으면 undefined로 resolve, subscribe 계열은 리스너를 보관해
// `bridge.__emit(key, ...args)`로 메뉴 이벤트 등을 흉내 낸다.
import surface from './fixtures/legacyShellSurface.json';

const VERSION = { app: '0.0.0-test', electron: 'E', node: 'N', chrome: 'C' };

/**
 * @param {'standalone'|'intranet'} target
 * @param {{ buildTarget?: string, overrides?: Record<string, unknown> }} [options]
 *   overrides: 키별 대체 구현(함수) 또는 값. 표면에 없는 키를 주면 오류(구 셸에 없는 키를 실수로 기대하지 않게).
 */
export function makeBridgeStub(target, { buildTarget, overrides = {} } = {}) {
  const keys = surface[target];
  if (!keys) throw new Error(`makeBridgeStub: unknown target "${target}"`);
  for (const key of Object.keys(overrides)) {
    if (!(key in keys)) throw new Error(`makeBridgeStub: "${key}" is not on the ${target} shell surface`);
  }
  const calls = [];
  const listeners = new Map();
  const bridge = {};
  for (const [key, kind] of Object.entries(keys)) {
    if (kind === 'value') {
      bridge[key] = key in overrides ? overrides[key] : key === 'platform' ? 'win32' : VERSION;
      continue;
    }
    const impl = overrides[key];
    if (kind === 'subscribe') {
      bridge[key] = (listener) => {
        calls.push({ key, args: [] });
        if (typeof impl === 'function') return impl(listener); // override가 구독 자체를 대신한다
        if (!listeners.has(key)) listeners.set(key, new Set());
        listeners.get(key).add(listener);
        return () => listeners.get(key)?.delete(listener);
      };
      continue;
    }
    bridge[key] = (...args) => {
      calls.push({ key, args });
      if (typeof impl === 'function') return impl(...args);
      return kind === 'invoke' ? Promise.resolve(undefined) : undefined;
    };
  }
  if (buildTarget !== undefined) bridge.buildTarget = buildTarget;
  Object.defineProperties(bridge, {
    __calls: { value: calls, enumerable: false },
    __callsOf: { value: (key) => calls.filter((c) => c.key === key).map((c) => c.args), enumerable: false },
    __listenerCount: { value: (key) => listeners.get(key)?.size ?? 0, enumerable: false },
    __emit: {
      value: (key, ...args) => { for (const l of [...(listeners.get(key) ?? [])]) l(...args); },
      enumerable: false,
    },
  });
  return bridge;
}

/** 구 셸 표면의 키 목록(검증용). */
export function legacyShellKeys(target) {
  return Object.keys(surface[target]);
}
