// Golden (characterization) test G10 — the window.electron surface each preload exposes
// (REFACTORING_ROADMAP P0-9): the 11 keys both builds share, every key of each build, and for each
// function the IPC call it makes (method, channel, forwarded arguments). Also: the intranet preload
// exposes an empty object on a foreign origin.
// Sandboxed preloads cannot be imported, so the source runs in vm with a fake electron and window
// (same approach as preloadSubscribe.test.js).
// Update the golden only for an intended change of the bridge, never in a refactor:
// `npx vitest run -u electron/__tests__/preloadSurface.characterization.test.js` + reason in the PR.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ELECTRON_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://wr.test:8443';
const PRELOADS = ['preload-intranet.js', 'preload-standalone.js'];

// The keys the renderer may use in both builds.
const COMMON_KEYS = [
  'platform', 'onMenuNew', 'onGotoModule', 'onOpenStatistics', 'setStatsAvailable',
  'showAlert', 'showConfirm', 'injectEMR', 'extractRecord', 'extractConsultation', 'version',
];

function loadPreload(file, { origin = ORIGIN } = {}) {
  const exposed = {};
  const calls = [];
  const record = (method) => (channel, ...args) => {
    calls.push({ method, channel, args: args.map((a) => (typeof a === 'function' ? '<function>' : a)) });
    return method === 'sendSync' ? '0.0.0-golden' : undefined;
  };
  const ipcRenderer = {
    on: record('on'),
    removeListener: record('removeListener'),
    send: record('send'),
    invoke: record('invoke'),
    sendSync: record('sendSync'),
  };
  const electron = { contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } }, ipcRenderer };
  const sandbox = {
    require: (m) => { if (m === 'electron') return electron; throw new Error(`unexpected require: ${m}`); },
    process: { platform: 'win32', versions: { electron: 'E', node: 'N', chrome: 'C' }, env: { WR_INTRANET_URL: ORIGIN } },
    window: { location: { origin } },
    URL,
    console,
  };
  vm.runInNewContext(fs.readFileSync(path.join(ELECTRON_DIR, file), 'utf8'), sandbox, { filename: file });
  return { api: exposed.electron, calls };
}

// Every exposed key: a function → the IPC calls it makes when called with two marker arguments;
// anything else → its value.
function surface(file) {
  const { api, calls } = loadPreload(file);
  calls.length = 0; // drop the calls made while loading (version.app's sendSync is kept in the value)
  const out = {};
  for (const key of Object.keys(api).sort()) {
    const value = api[key];
    if (typeof value !== 'function') { out[key] = value; continue; }
    const before = calls.length;
    const returned = value('arg1', 'arg2');
    if (typeof returned === 'function') returned(); // subscriptions return an unsubscribe function
    out[key] = { calls: calls.slice(before), returnsUnsubscribe: typeof returned === 'function' };
  }
  return out;
}

describe('G10 — preload window.electron surface', () => {
  it.each(PRELOADS)('%s exposes the 11 common keys', (file) => {
    const { api } = loadPreload(file);
    for (const key of COMMON_KEYS) expect(api, `${file}: ${key}`).toHaveProperty(key);
  });

  it('intranet preload on a foreign origin exposes an empty object', () => {
    expect(loadPreload('preload-intranet.js', { origin: 'https://evil.test' }).api).toEqual({});
  });

  it('every key and the IPC call behind each function', async () => {
    const out = { commonKeys: COMMON_KEYS };
    for (const file of PRELOADS) out[file] = surface(file);
    await expect(JSON.stringify(out, null, 2) + '\n').toMatchFileSnapshot('./__goldens__/preload-surface.json');
  });
});
