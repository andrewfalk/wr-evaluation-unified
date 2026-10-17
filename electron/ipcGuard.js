'use strict';
// electron/ipcGuard.js — HF3(M4)
// IPC 채널 등록의 단일 관문. electron에 의존하지 않는 순수 모듈이라 vitest에서 가짜 ipcMain으로 테스트한다.
//
// 하는 일 두 가지:
//  1) 독립형 전용 채널(fs-*·AI 직접 호출·구형 데이터 임포트)을 인트라넷 빌드에서는 "등록하지 않는다".
//     인트라넷 preload는 이 API를 노출하지 않지만, main에 핸들러가 있으면 렌더러가 침해됐을 때 raw ipcRenderer로
//     호출할 수 있다.
//  2) 모든 핸들러를 sender 검증으로 감싼다. 허용되지 않은 sender(다른 origin의 페이지·iframe·자식 창)의 호출은
//     핸들러 본문에 닿지 못한다.

const STANDALONE_ONLY_CHANNELS = new Set([
  'analyze-ai',
  'load-legacy-data',
  'fs-load-all-patients', 'fs-load-patient', 'fs-save-patient', 'fs-delete-patient', 'fs-save-all-patients',
  'fs-load-items', 'fs-save-item', 'fs-delete-item',
  'fs-save-autosave', 'fs-load-autosave', 'fs-clear-autosave',
  'fs-save-settings', 'fs-load-settings',
  'fs-load-custom-presets', 'fs-save-custom-presets',
  'fs-migrate',
]);

/**
 * @param {object}   deps
 * @param {object}   deps.ipcMain          electron ipcMain(또는 같은 모양의 가짜)
 * @param {boolean}  deps.isIntranetBuild  인트라넷 빌드 여부(main.js의 IS_INTRANET_BUILD)
 * @param {function} deps.isAllowedSender  (url) => boolean — 인트라넷 origin 게이트
 * @param {function} deps.getMainWindow    () => BrowserWindow | null — 독립형의 신뢰 창
 */
function createIpcRegistrar({ ipcMain, isIntranetBuild, isAllowedSender, getMainWindow }) {
  // 인트라넷: 허용 origin의 페이지만. 독립형: 페이지가 file://(origin 'null')이라 origin 비교가 안 되므로
  // "내 메인 창의 최상위 프레임"인지 신원으로 판정한다(iframe·자식 창·다른 webContents 거부).
  function isTrusted(event) {
    if (isIntranetBuild) return isAllowedSender(event.senderFrame?.url ?? event.sender?.getURL?.());
    const win = getMainWindow();
    if (!win || win.isDestroyed?.()) return false;
    const wc = win.webContents;
    return event.sender === wc && (!event.senderFrame || event.senderFrame === wc.mainFrame);
  }

  const skipped = (channel) => isIntranetBuild && STANDALONE_ONLY_CHANNELS.has(channel);
  const reject = (channel) => console.warn('[ipc] rejected untrusted sender:', channel);

  return {
    handle(channel, fn) {
      if (skipped(channel)) return;
      ipcMain.handle(channel, (event, ...args) => {
        if (!isTrusted(event)) {
          reject(channel);
          throw new Error('IPC sender not allowed');
        }
        return fn(event, ...args);
      });
    },
    on(channel, fn) {
      if (skipped(channel)) return;
      ipcMain.on(channel, (event, ...args) => {
        if (!isTrusted(event)) {
          reject(channel);
          event.returnValue = null; // sendSync 호출자가 영원히 멈추지 않게
          return;
        }
        return fn(event, ...args);
      });
    },
  };
}

module.exports = { createIpcRegistrar, STANDALONE_ONLY_CHANNELS };
