import { describe, expect, it, vi } from 'vitest';
import { createIpcRegistrar, STANDALONE_ONLY_CHANNELS } from '../ipcGuard.js';

const ORIGIN = 'https://wr.test:8443';
const isAllowedSender = (url) => {
  try { return new URL(url).origin === ORIGIN; } catch { return false; }
};

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle: (channel, fn) => handlers.set(`handle:${channel}`, fn),
    on: (channel, fn) => handlers.set(`on:${channel}`, fn),
  };
}

describe('createIpcRegistrar — 인트라넷 빌드', () => {
  const make = () => {
    const ipcMain = fakeIpcMain();
    const ipc = createIpcRegistrar({ ipcMain, isIntranetBuild: true, isAllowedSender, getMainWindow: () => null });
    return { ipcMain, ipc };
  };
  const fromPage = (url, getURL = () => url) => ({ sender: { getURL }, senderFrame: { url } });

  it('독립형 전용 채널(fs-* 16개·analyze-ai·load-legacy-data)은 등록 자체를 하지 않는다', () => {
    const { ipcMain, ipc } = make();
    for (const channel of STANDALONE_ONLY_CHANNELS) ipc.handle(channel, () => 'x');
    expect(ipcMain.handlers.size).toBe(0);
    expect([...STANDALONE_ONLY_CHANNELS].filter((c) => c.startsWith('fs-'))).toHaveLength(16);
  });

  it('공통 채널(EMR·알림·UI)은 등록된다', () => {
    const { ipcMain, ipc } = make();
    ipc.handle('emr-inject', () => 'ok');
    ipc.handle('show-alert', () => 'ok');
    ipc.on('set-stats-available', () => {});
    expect([...ipcMain.handlers.keys()].sort()).toEqual(['handle:emr-inject', 'handle:show-alert', 'on:set-stats-available']);
  });

  it('허용 origin의 sender는 핸들러에 도달하고 인자·반환값이 그대로 전달된다', async () => {
    const { ipcMain, ipc } = make();
    const fn = vi.fn(async (_e, a, b) => `${a}-${b}`);
    ipc.handle('emr-inject', fn);
    const event = fromPage(`${ORIGIN}/app`);
    await expect(ipcMain.handlers.get('handle:emr-inject')(event, 'p1', 2)).resolves.toBe('p1-2');
    expect(fn).toHaveBeenCalledWith(event, 'p1', 2);
  });

  it('다른 origin의 sender는 핸들러에 닿지 못하고 invoke가 거부된다', () => {
    const { ipcMain, ipc } = make();
    const fn = vi.fn();
    ipc.handle('emr-inject', fn);
    expect(() => ipcMain.handlers.get('handle:emr-inject')(fromPage('https://evil.example/'))).toThrow('IPC sender not allowed');
    expect(fn).not.toHaveBeenCalled();
  });

  it('on 채널은 거부 시 returnValue=null로 sendSync가 멈추지 않게 하고 핸들러를 부르지 않는다', () => {
    const { ipcMain, ipc } = make();
    const fn = vi.fn();
    ipc.on('get-app-version', fn);
    const event = fromPage('https://evil.example/');
    ipcMain.handlers.get('on:get-app-version')(event);
    expect(event.returnValue).toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });

  it('프레임 URL이 우선한다 — 최상위 페이지는 허용 origin이어도 다른 origin iframe의 호출은 거부', () => {
    const { ipcMain, ipc } = make();
    const fn = vi.fn();
    ipc.handle('emr-inject', fn);
    const iframeEvent = { sender: { getURL: () => `${ORIGIN}/app` }, senderFrame: { url: 'https://evil.example/frame' } };
    expect(() => ipcMain.handlers.get('handle:emr-inject')(iframeEvent)).toThrow();
    expect(fn).not.toHaveBeenCalled();
  });

  it('senderFrame이 없으면 sender.getURL()로 판정한다', () => {
    const { ipcMain, ipc } = make();
    const fn = vi.fn(() => 'ok');
    ipc.handle('emr-inject', fn);
    expect(ipcMain.handlers.get('handle:emr-inject')({ sender: { getURL: () => `${ORIGIN}/` } })).toBe('ok');
    expect(() => ipcMain.handlers.get('handle:emr-inject')({ sender: { getURL: () => 'https://evil.example/' } })).toThrow();
  });
});

describe('createIpcRegistrar — 독립형 빌드', () => {
  const mainFrame = { id: 'main' };
  const webContents = { mainFrame };
  const win = { webContents, isDestroyed: () => false };
  const make = (getMainWindow = () => win) => {
    const ipcMain = fakeIpcMain();
    const ipc = createIpcRegistrar({ ipcMain, isIntranetBuild: false, isAllowedSender: () => true, getMainWindow });
    return { ipcMain, ipc };
  };

  it('독립형 전용 채널도 등록된다', () => {
    const { ipcMain, ipc } = make();
    ipc.handle('fs-load-all-patients', () => []);
    ipc.handle('analyze-ai', () => ({}));
    expect(ipcMain.handlers.size).toBe(2);
  });

  it('메인 창의 최상위 프레임에서 온 호출은 통과한다', async () => {
    const { ipcMain, ipc } = make();
    ipc.handle('fs-load-all-patients', async () => ['p1']);
    await expect(ipcMain.handlers.get('handle:fs-load-all-patients')({ sender: webContents, senderFrame: mainFrame })).resolves.toEqual(['p1']);
  });

  it('senderFrame이 없어도(분리된 프레임 등) 메인 창 webContents면 통과한다', () => {
    const { ipcMain, ipc } = make();
    ipc.on('get-app-version', (e) => { e.returnValue = '7.1.4'; });
    const event = { sender: webContents };
    ipcMain.handlers.get('on:get-app-version')(event);
    expect(event.returnValue).toBe('7.1.4');
  });

  it.each([
    ['다른 webContents(자식 창·DevTools 등)', { sender: { mainFrame }, senderFrame: mainFrame }],
    ['메인 창의 iframe', { sender: webContents, senderFrame: { id: 'iframe' } }],
  ])('%s의 호출은 거부된다', (_name, event) => {
    const { ipcMain, ipc } = make();
    const fn = vi.fn();
    ipc.handle('fs-save-patient', fn);
    expect(() => ipcMain.handlers.get('handle:fs-save-patient')(event)).toThrow('IPC sender not allowed');
    expect(fn).not.toHaveBeenCalled();
  });

  it('메인 창이 아직 없거나 파괴됐으면 모두 거부된다', () => {
    for (const getMainWindow of [() => null, () => ({ webContents, isDestroyed: () => true })]) {
      const { ipcMain, ipc } = make(getMainWindow);
      const fn = vi.fn();
      ipc.handle('fs-save-patient', fn);
      expect(() => ipcMain.handlers.get('handle:fs-save-patient')({ sender: webContents, senderFrame: mainFrame })).toThrow();
      expect(fn).not.toHaveBeenCalled();
    }
  });
});
