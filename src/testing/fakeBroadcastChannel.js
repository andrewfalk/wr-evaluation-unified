// 테스트 파일 안에서만 오가는 BroadcastChannel(REFACTORING_ROADMAP Phase 2 P2-09에서 추가).
//
// 왜: Node 내장 BroadcastChannel은 같은 프로세스의 worker thread끼리도 메시지를 전달한다. vitest는 테스트 파일을
// 병렬 worker로 돌리므로, 한 파일(예: authChannel 특성화)이 'wr-auth' 채널에 LOGOUT을 보내면 동시에 돌던 다른 파일
// (G9 App 스모크)의 앱이 로그아웃된다 — 실제로 전체 스위트에서 G9b-2가 로그인 화면으로 돌아가며 실패했다.
// 이 가짜는 설치한 worker(= 테스트 파일) 안의 인스턴스끼리만 전달한다. 의미는 실물과 같게: 같은 이름의 **다른**
// 인스턴스에만, 비동기(macrotask)로, 구조화 복제된 data를 담은 MessageEvent 모양 객체로.
//
// 사용: authChannel을 import하기 **전에** installFakeBroadcastChannel()(모듈 로드 시 채널을 만든다).
//   정적 import보다 먼저 설치하려면: await vi.hoisted(async () => (await import('./testing/fakeBroadcastChannel.js')).installFakeBroadcastChannel());

export class FakeBroadcastChannel {
  static registry = new Map();

  constructor(name) {
    this.name = String(name);
    this.listeners = new Set();
    this.onmessage = null;
    this.closed = false;
    if (!FakeBroadcastChannel.registry.has(this.name)) FakeBroadcastChannel.registry.set(this.name, new Set());
    FakeBroadcastChannel.registry.get(this.name).add(this);
  }

  postMessage(message) {
    if (this.closed) throw new Error('BroadcastChannel is closed');
    const data = structuredClone(message);
    for (const peer of FakeBroadcastChannel.registry.get(this.name) ?? []) {
      if (peer === this || peer.closed) continue;
      setTimeout(() => peer.dispatch(data), 0);
    }
  }

  dispatch(data) {
    if (this.closed) return;
    const event = { type: 'message', data };
    this.onmessage?.(event);
    for (const listener of [...this.listeners]) listener(event);
  }

  addEventListener(type, listener) {
    if (type === 'message') this.listeners.add(listener);
  }

  removeEventListener(type, listener) {
    if (type === 'message') this.listeners.delete(listener);
  }

  close() {
    this.closed = true;
    FakeBroadcastChannel.registry.get(this.name)?.delete(this);
  }
}

export function installFakeBroadcastChannel() {
  // 테스트가 쓰는 부분(postMessage·add/removeEventListener·onmessage·close)만 구현한 대체품이다.
  globalThis.BroadcastChannel = /** @type {typeof BroadcastChannel} */ (/** @type {unknown} */ (FakeBroadcastChannel));
  return FakeBroadcastChannel;
}
