// HF3: preload가 메인 이벤트를 페이지에 넘길 때 IpcRendererEvent(→ event.sender로 raw ipcRenderer 접근)를 빼는지.
// 샌드박스 preload라 import할 수 없어, 소스를 가짜 electron·window와 함께 vm에서 실행해 노출된 API를 직접 호출한다.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const ELECTRON_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://wr.test:8443';

function loadPreload(file, { origin = ORIGIN } = {}) {
  const exposed = {};
  const listeners = new Map(); // channel -> listener[]
  const ipcRenderer = {
    on: vi.fn((channel, listener) => listeners.set(channel, [...(listeners.get(channel) || []), listener])),
    removeListener: vi.fn((channel, listener) => listeners.set(channel, (listeners.get(channel) || []).filter((l) => l !== listener))),
    send: vi.fn(),
    invoke: vi.fn(async () => undefined),
    sendSync: vi.fn(() => '7.1.4'),
  };
  const electron = { contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } }, ipcRenderer };
  const sandbox = {
    require: (m) => { if (m === 'electron') return electron; throw new Error(`unexpected require: ${m}`); },
    process: { platform: 'win32', versions: { electron: '22', node: '16', chrome: '108' }, env: { WR_INTRANET_URL: ORIGIN } },
    window: { location: { origin } },
    URL, // vm 새 컨텍스트에는 Node 전역 URL이 없다 — 없으면 인트라넷 preload의 origin 게이트가 조용히 실패해 빈 객체를 노출한다
    console,
  };
  vm.runInNewContext(fs.readFileSync(path.join(ELECTRON_DIR, file), 'utf8'), sandbox, { filename: file });
  return { api: exposed.electron, listeners, ipcRenderer };
}

const CASES = [
  ['preload-intranet.js', 'onMenuNew', 'menu-new'],
  ['preload-intranet.js', 'onGotoModule', 'goto-module'],
  ['preload-intranet.js', 'onQuitRequested', 'app-quit-requested'],
  ['preload-intranet.js', 'onOpenStatistics', 'open-statistics'],
  ['preload-standalone.js', 'onMenuNew', 'menu-new'],
  ['preload-standalone.js', 'onGotoModule', 'goto-module'],
  ['preload-standalone.js', 'onOpenStatistics', 'open-statistics'],
];

describe('preload 이벤트 구독 (HF3)', () => {
  it.each(CASES)('%s %s: 콜백은 payload만 받고 이벤트 객체(sender)는 받지 않는다', (file, apiName, channel) => {
    const { api, listeners, ipcRenderer } = loadPreload(file);
    const callback = vi.fn();
    api[apiName](callback);

    const [listener] = listeners.get(channel);
    // 메인이 보내는 실제 모양: (IpcRendererEvent, ...payload) — event.sender가 ipcRenderer다
    listener({ sender: ipcRenderer, senderId: 1 }, 'knee', 7);

    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith('knee', 7);
    for (const arg of callback.mock.calls[0]) {
      expect(arg).not.toHaveProperty('sender');
    }
  });

  it.each(CASES)('%s %s: 반환한 해제 함수는 등록한 바로 그 리스너를 제거한다', (file, apiName, channel) => {
    const { api, listeners, ipcRenderer } = loadPreload(file);
    const unsubscribe = api[apiName](vi.fn());
    const [registered] = listeners.get(channel);

    unsubscribe();

    expect(ipcRenderer.removeListener).toHaveBeenCalledWith(channel, registered);
    expect(listeners.get(channel)).toEqual([]);
  });

  it('두 구독은 서로 독립이다 — 하나를 해제해도 다른 하나는 유지된다', () => {
    const { api, listeners } = loadPreload('preload-standalone.js');
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = api.onMenuNew(a);
    api.onMenuNew(b);
    unsubA();
    listeners.get('menu-new').forEach((l) => l({}, 'x'));
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledWith('x');
  });

  it('인트라넷 preload의 origin 게이트는 그대로다 — 다른 origin이면 아무것도 노출하지 않는다', () => {
    const { api } = loadPreload('preload-intranet.js', { origin: 'https://evil.example' });
    expect(api).toEqual({});
  });

  it('소스에 IpcRendererEvent를 그대로 넘기는 ipcRenderer.on(채널, callback) 형태가 남아 있지 않다(회귀 방지)', () => {
    for (const file of ['preload-intranet.js', 'preload-standalone.js']) {
      const source = fs.readFileSync(path.join(ELECTRON_DIR, file), 'utf8');
      expect(source, file).not.toMatch(/ipcRenderer\.on\(\s*['"][^'"]+['"]\s*,\s*callback\s*\)/);
    }
  });
});
