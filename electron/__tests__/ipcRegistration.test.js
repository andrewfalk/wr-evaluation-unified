// HF3: 소스 수준 연결·드리프트 점검. 레지스트리(ipcGuard)를 만들어 두고 main.js에서 안 쓰거나, 독립형 전용 채널
// 목록이 preload·main과 어긋나는 것(선언만 하고 연결을 빼먹는 실수)을 잡는다. 동작 자체는 ipcGuard.test.js가 검증한다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { STANDALONE_ONLY_CHANNELS } from '../ipcGuard.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(DIR, file), 'utf8');
const MAIN = read('main.js');

const matchAll = (source, re) => [...source.matchAll(re)].map((m) => m[1]);
// preload가 main을 부르는 채널: invoke / send / sendSync
const preloadChannels = (file) => new Set(matchAll(read(file), /ipcRenderer\.(?:invoke|send|sendSync)\(\s*'([^']+)'/g));
const registeredViaRegistrar = new Set(matchAll(MAIN, /^ipc\.(?:handle|on)\(\s*'([^']+)'/gm));

describe('main.js의 IPC 등록 (HF3)', () => {
  it('최상위 IPC 채널은 전부 ipc.handle / ipc.on 레지스트리로 등록한다 — 날 것의 ipcMain.handle/on이 없다', () => {
    expect(MAIN.match(/^ipcMain\.(?:handle|on)\(/gm)).toBeNull();
    expect(MAIN).toMatch(/createIpcRegistrar\(\{[\s\S]*?isIntranetBuild: IS_INTRANET_BUILD/);
  });

  it('레지스트리를 거치지 않는 ipcMain 사용은 창마다 등록·해제하는 quit-logout-done(자체 sender 검사)뿐이다', () => {
    const raw = matchAll(MAIN, /ipcMain\.(?:on|handle|once|removeListener)\(\s*'([^']+)'/g);
    expect([...new Set(raw)]).toEqual(['quit-logout-done']);
  });

  it('독립형 전용 채널 목록 = 독립형 preload만 부르는 채널(독립형 preload − 인트라넷 preload)', () => {
    const standalone = preloadChannels('preload-standalone.js');
    const intranet = preloadChannels('preload-intranet.js');
    const standaloneOnly = [...standalone].filter((c) => !intranet.has(c)).sort();
    expect(standaloneOnly).toEqual([...STANDALONE_ONLY_CHANNELS].sort());
  });

  it('main.js에 등록된 fs-* · analyze-ai · load-legacy-data는 모두 독립형 전용 목록에 있다', () => {
    const candidates = [...registeredViaRegistrar].filter((c) => c.startsWith('fs-') || c === 'analyze-ai' || c === 'load-legacy-data');
    expect(candidates.length).toBeGreaterThanOrEqual(18);
    for (const channel of candidates) expect(STANDALONE_ONLY_CHANNELS.has(channel), channel).toBe(true);
  });

  it('두 preload가 부르는 모든 채널은 main.js에 등록돼 있다(오타·누락 방지)', () => {
    const registered = new Set([...registeredViaRegistrar, 'quit-logout-done']);
    for (const file of ['preload-intranet.js', 'preload-standalone.js']) {
      for (const channel of preloadChannels(file)) expect(registered.has(channel), `${file}: ${channel}`).toBe(true);
    }
  });
});

describe('main.js의 보안 가드 연결 (HF9)', () => {
  it('세션 권한 핸들러를 창 생성 전에 건다', () => {
    const permission = MAIN.indexOf('setPermissionRequestHandler');
    const check = MAIN.indexOf('setPermissionCheckHandler');
    const create = MAIN.indexOf('createWindow();', permission);
    expect(permission).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(permission);
  });

  it('독립형 분기도 will-navigate·will-redirect·새 창 거부를 로드 호출 전에 건다', () => {
    const standaloneBranch = MAIN.slice(MAIN.indexOf("const isDev = process.env.NODE_ENV === 'development'"));
    const load = standaloneBranch.indexOf('mainWindow.loadURL');
    for (const hook of ["on('will-navigate'", "on('will-redirect'", 'setWindowOpenHandler']) {
      const at = standaloneBranch.indexOf(hook);
      expect(at, hook).toBeGreaterThan(-1);
      expect(at, `${hook} must be before load`).toBeLessThan(load);
    }
    expect(standaloneBranch).toContain('isAllowedStandaloneNavigation');
  });
});
