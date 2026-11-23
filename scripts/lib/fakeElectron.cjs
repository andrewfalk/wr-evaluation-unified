'use strict';
// scripts/lib/fakeElectron.cjs
// 설치본(electron/)의 감사 코드를 Electron 없이 Node에서 돌리기 위한 가짜 `electron` 모듈 — 단위 테스트
// (electron/__tests__/)와 Tier-3 실서버 확인(scripts/tier3/emr-audit-smoke.mjs)이 함께 쓴다. 시험용이다.
//
// - app.getPath('userData') → 넘긴 폴더("PC" 하나 = Windows 사용자 프로필 하나)
// - safeStorage → DPAPI 대신 시험용 접두사(암호화가 아니다)
// - net.request → 넘긴 send 함수로 보내고 Electron과 같은 이벤트(response·data·end·error)를 낸다
// - loadShellModule() → 지정한 폴더의 모듈 캐시를 비우고(= 앱 재시작) require('electron')만 가짜로 바꿔 불러온다
const Module = require('module');
const path = require('path');
const { EventEmitter } = require('events');

const SAFE_PREFIX = 'fake-dpapi:';

/**
 * @param {{
 *   userDataDir: string,
 *   send: (req: { url: string, method: string, headers: Record<string, string>, body: Buffer }) =>
 *     Promise<{ status: number, body: string, headers?: Record<string, string> }>,
 *   encryptionAvailable?: () => boolean,
 * }} options  send가 reject하면 net 요청의 'error' 이벤트가 된다(네트워크 오류).
 */
function createFakeElectron(options) {
  const { userDataDir, send } = options;
  const encryptionAvailable = options.encryptionAvailable ?? (() => true);

  function request({ url, method = 'GET' }) {
    const req = new EventEmitter();
    const headers = {};
    const chunks = [];
    let aborted = false;
    req.setHeader = (k, v) => { headers[k] = String(v); };
    req.write = (chunk) => { chunks.push(Buffer.from(chunk)); };
    req.abort = () => {
      if (aborted) return;
      aborted = true;
      req.emit('abort');
    };
    req.end = () => {
      Promise.resolve()
        .then(() => send({ url, method, headers, body: Buffer.concat(chunks) }))
        .then((res) => {
          if (aborted) return;
          const r = new EventEmitter();
          r.statusCode = res.status;
          r.headers = res.headers ?? {};
          req.emit('response', r);
          if (res.body) r.emit('data', Buffer.from(res.body));
          r.emit('end');
        }, (err) => {
          if (!aborted) req.emit('error', err instanceof Error ? err : new Error(String(err)));
        });
    };
    return req;
  }

  return {
    app: {
      getPath(name) {
        if (name !== 'userData') throw new Error(`fake electron: app.getPath('${name}') is not supported`);
        return userDataDir;
      },
    },
    safeStorage: {
      isEncryptionAvailable: () => encryptionAvailable(),
      encryptString: (plain) => Buffer.from(SAFE_PREFIX + plain, 'utf8'),
      decryptString: (cipher) => {
        const s = Buffer.from(cipher).toString('utf8');
        if (!s.startsWith(SAFE_PREFIX)) throw new Error('fake safeStorage: cannot decrypt');
        return s.slice(SAFE_PREFIX.length);
      },
    },
    net: { request },
  };
}

/**
 * shellDir의 모듈을 새로 불러온다(같은 폴더의 require 캐시를 먼저 비운다). 불러오는 동안만 require('electron')이
 * fake를 돌려준다 — 모듈은 불러올 때 받은 fake를 계속 쓴다.
 */
function loadShellModule(shellDir, fileName, fake) {
  const dir = path.resolve(shellDir) + path.sep;
  for (const key of Object.keys(require.cache)) if (key.startsWith(dir)) delete require.cache[key];
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'electron') return fake;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(path.join(dir, fileName));
  } finally {
    Module._load = originalLoad;
  }
}

module.exports = { createFakeElectron, loadShellModule, SAFE_PREFIX };
