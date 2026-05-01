const { app, BrowserWindow, Menu, ipcMain, dialog, net } = require('electron');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ---------------------------------------------------------------------------
// Build target: 'intranet' or 'standalone' (default)
// Set WR_BUILD_TARGET=intranet + WR_INTRANET_URL=https://wr.hospital.local
// in the intranet build environment.
// ---------------------------------------------------------------------------
const IS_INTRANET_BUILD = process.env.WR_BUILD_TARGET === 'intranet';
const INTRANET_URL      = (process.env.WR_INTRANET_URL || '').trim().replace(/\/$/, '');

// Allowed origin for intranet build — derived from WR_INTRANET_URL.
// EMR ipc handlers reject requests from any other origin.
function getAllowedOrigin() {
  if (!INTRANET_URL) return null;
  try { return new URL(INTRANET_URL).origin; } catch { return null; }
}
const ALLOWED_ORIGIN = getAllowedOrigin();

function isAllowedSender(url) {
  if (!IS_INTRANET_BUILD) return true; // standalone: no origin gate
  if (!ALLOWED_ORIGIN) return false;
  try { return new URL(url).origin === ALLOWED_ORIGIN; } catch { return false; }
}

// Windows 7/8 호환성 (Electron 22 — 마지막 Win7 지원 버전)
if (process.platform === 'win32') {
  const ver = os.release();
  if (ver.startsWith('6.1') || ver.startsWith('6.2') || ver.startsWith('6.3')) {
    // Windows 7(6.1), 8(6.2), 8.1(6.3) — sandbox 비활성화 필수
    app.commandLine.appendSwitch('no-sandbox');
    app.commandLine.appendSwitch('disable-gpu');
    app.commandLine.appendSwitch('disable-gpu-compositing');
  }
}

let mainWindow;

function createWindow() {
  const preloadFile = IS_INTRANET_BUILD
    ? path.join(__dirname, 'preload-intranet.js')
    : path.join(__dirname, 'preload-standalone.js');

  mainWindow = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 1024,
    minHeight: 768,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      preload: preloadFile,
    },
    icon: path.join(__dirname, '../public/icon.ico'),
    title: '근골격계 질환 업무관련성 평가 및 특별진찰 소견서 작성 도우미'
  });

  if (IS_INTRANET_BUILD) {
    if (!INTRANET_URL) {
      dialog.showErrorBox('설정 오류', 'WR_INTRANET_URL 환경변수가 설정되지 않았습니다.');
      app.quit();
      return;
    }

    // Register all navigation guards BEFORE loadURL so no redirect can slip
    // through between the load call and handler registration.

    // Block SPA-level navigation away from the allowed origin.
    mainWindow.webContents.on('will-navigate', (event, url) => {
      if (!isAllowedSender(url)) {
        event.preventDefault();
        console.warn('[intranet] blocked navigation to', url);
      }
    });

    // Block HTTP 30x redirects that land on an external origin.
    mainWindow.webContents.on('will-redirect', (event, url) => {
      if (!isAllowedSender(url)) {
        event.preventDefault();
        console.warn('[intranet] blocked redirect to', url);
      }
    });

    // Block new windows from opening external origins.
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (isAllowedSender(url)) return { action: 'allow' };
      console.warn('[intranet] blocked window open for', url);
      return { action: 'deny' };
    });

    mainWindow.loadURL(INTRANET_URL);
  } else {
    const isDev = process.env.NODE_ENV === 'development';
    if (isDev) {
      mainWindow.loadURL('http://localhost:3000');
      mainWindow.webContents.openDevTools();
    } else {
      mainWindow.loadFile(path.join(__dirname, '../dist/electron/index.html'));
    }
  }

  const menuTemplate = [
    {
      label: '파일',
      submenu: [
        { label: '새로 만들기', accelerator: 'CmdOrCtrl+N', click: () => mainWindow.webContents.send('menu-new') },
        { type: 'separator' },
        { label: '종료', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() }
      ]
    },
    {
      label: '평가',
      submenu: [
        { label: '무릎 (슬관절) 평가', click: () => mainWindow.webContents.send('goto-module', 'knee') },
        { label: '척추 (요추) 평가', click: () => mainWindow.webContents.send('goto-module', 'spine') },
      ]
    },
    {
      label: '편집',
      submenu: [
        { label: '실행 취소', accelerator: 'CmdOrCtrl+Z', role: 'undo' },
        { label: '다시 실행', accelerator: 'CmdOrCtrl+Y', role: 'redo' },
        { type: 'separator' },
        { label: '잘라내기', accelerator: 'CmdOrCtrl+X', role: 'cut' },
        { label: '복사', accelerator: 'CmdOrCtrl+C', role: 'copy' },
        { label: '붙여넣기', accelerator: 'CmdOrCtrl+V', role: 'paste' }
      ]
    },
    {
      label: '보기',
      submenu: [
        { label: '새로고침', accelerator: 'CmdOrCtrl+R', click: () => mainWindow.reload() },
        { label: '전체 화면', accelerator: 'F11', click: () => mainWindow.setFullScreen(!mainWindow.isFullScreen()) },
        { type: 'separator' },
        { label: '확대', accelerator: 'CmdOrCtrl+Plus', click: () => mainWindow.webContents.setZoomLevel(mainWindow.webContents.getZoomLevel() + 0.5) },
        { label: '축소', accelerator: 'CmdOrCtrl+-', click: () => mainWindow.webContents.setZoomLevel(mainWindow.webContents.getZoomLevel() - 0.5) },
        { label: '기본 크기', accelerator: 'CmdOrCtrl+0', click: () => mainWindow.webContents.setZoomLevel(0) }
      ]
    },
    {
      label: '도움말',
      submenu: [
        { label: '버전 정보', click: () => {
          dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: '버전 정보',
            message: '근골격계 질환 업무관련성 평가 및 특별진찰 소견서 작성 도우미',
            detail: `버전: ${app.getVersion()}\n\n직업환경의학 전문의를 위한 통합 평가 도구\n(무릎/척추 평가 지원)`
          });
        }}
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));

  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(createWindow);

// IPC: 앱 버전 (preload에서 동기 호출)
ipcMain.on('get-app-version', (event) => {
  event.returnValue = app.getVersion();
});

// IPC: native alert/confirm
ipcMain.handle('show-alert', async (_event, message) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    await dialog.showMessageBox(mainWindow, {
      type: 'info', title: '알림', message: String(message), buttons: ['확인']
    });
  }
});

ipcMain.handle('show-confirm', async (_event, message) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'question', title: '확인', message: String(message),
      buttons: ['확인', '취소'], defaultId: 0, cancelId: 1
    });
    return response === 0;
  }
  return false;
});

// IPC: AI 분석 (Electron에서 직접 API 호출 — Claude / Gemini 분기)
ipcMain.handle('analyze-ai', async (_event, { prompt, systemPrompt, model, apiKey }) => {
  const isGemini = (model || '').startsWith('gemini');

  if (!apiKey) {
    return { error: { message: `API 키가 설정되지 않았습니다. 설정에서 ${isGemini ? 'Gemini' : 'Claude'} API 키를 입력하세요.` } };
  }

  try {
    if (isGemini) {
      return await callGemini({ prompt, systemPrompt, model, apiKey });
    } else {
      return await callClaude({ prompt, systemPrompt, model, apiKey });
    }
  } catch (error) {
    return { error: { message: 'AI 서버 연결 오류: ' + error.message } };
  }
});

// Electron net 모듈을 사용한 HTTPS 요청 헬퍼
// net.request는 Chromium 네트워크 스택을 사용하므로 시스템 인증서 저장소를 신뢰함
// → 회사 프록시(SSL Inspection)의 자체 서명 인증서도 정상 통과
function netRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    const req = net.request({ url, method: 'POST' });
    for (const [key, value] of Object.entries(options.headers || {})) {
      req.setHeader(key, value);
    }
    req.on('response', (res) => {
      let chunks = '';
      res.on('data', (chunk) => { chunks += chunk.toString(); });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(chunks);
          if (res.statusCode >= 400) {
            reject(new Error(parsed.error?.message || `HTTP ${res.statusCode}`));
          } else {
            resolve(parsed);
          }
        } catch {
          reject(new Error(`응답 파싱 오류 (HTTP ${res.statusCode})`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function callClaude({ prompt, systemPrompt, model, apiKey }) {
  const body = JSON.stringify({
    model: model || 'claude-haiku-4-5-20251001',
    max_tokens: 2000,
    system: systemPrompt || '',
    messages: [{ role: 'user', content: prompt }]
  });

  return netRequest('https://api.anthropic.com/v1/messages', {
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    }
  }, body);
}

function callGemini({ prompt, systemPrompt, model, apiKey }) {
  const geminiModel = model || 'gemini-2.5-flash';
  const isPro = geminiModel.includes('pro');
  const body = JSON.stringify({
    system_instruction: { parts: [{ text: systemPrompt || '' }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: isPro ? 65536 : 8192 }
  });

  return netRequest(`https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent`, {
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    }
  }, body);
}

// IPC: 구형 무릎 프로그램(wr-evaluation) 저장 데이터 읽기
// Chromium localStorage → LevelDB → WAL(.log) 포맷 파싱 + UTF-16LE 값 추출
ipcMain.handle('load-legacy-data', async () => {
  const debug = [];
  try {
    const legacyPath = path.join(app.getPath('appData'), 'wr-evaluation', 'Local Storage', 'leveldb');
    debug.push(`path: ${legacyPath}`);
    debug.push(`exists: ${fs.existsSync(legacyPath)}`);
    if (!fs.existsSync(legacyPath)) return { debug, data: null };

    const targetKey = 'wrEvaluationSavedItems';
    let savedItems = null;

    // .log 파일 우선 (WAL, 비압축), 이후 .ldb (SSTable)
    const files = fs.readdirSync(legacyPath);
    const logFiles = files.filter(f => f.endsWith('.log'));
    const ldbFiles = files.filter(f => f.endsWith('.ldb'));
    debug.push(`files: log=${logFiles.length} ldb=${ldbFiles.length} (${files.join(', ')})`);

    for (const file of [...logFiles, ...ldbFiles]) {
      const buf = fs.readFileSync(path.join(legacyPath, file));
      debug.push(`${file}: ${buf.length} bytes`);
      if (buf.length === 0) continue;

      const value = file.endsWith('.log')
        ? extractFromWal(buf, targetKey)
        : extractFromRawScan(buf, targetKey);

      debug.push(`${file}: value=${value ? `found(${value.length} chars)` : 'null'}`);

      if (value) {
        try {
          savedItems = JSON.parse(value);
          debug.push(`parsed OK: ${Array.isArray(savedItems) ? savedItems.length + ' items' : typeof savedItems}`);
          break;
        } catch (e) {
          debug.push(`JSON parse error: ${e.message}`);
        }
      }
    }

    return { debug, data: savedItems ? { savedItems } : null };
  } catch (e) {
    debug.push(`FATAL: ${e.message}\n${e.stack}`);
    return { debug, data: null };
  }
});

// Chromium WAL (.log) 포맷 파싱
// 블록(32KB) → 레코드(header 7B + data) → 배치(sequence + count + entries)
function extractFromWal(buf, targetKey) {
  const BLOCK_SIZE = 32768;
  const HEADER_SIZE = 7;

  // 1단계: WAL 레코드 → 배치 데이터 청크 추출
  const batches = [];
  let fragments = [];

  for (let blockStart = 0; blockStart < buf.length; blockStart += BLOCK_SIZE) {
    let pos = blockStart;
    const blockEnd = Math.min(blockStart + BLOCK_SIZE, buf.length);

    while (pos + HEADER_SIZE <= blockEnd) {
      const dataLen = buf.readUInt16LE(pos + 4);
      const type = buf[pos + 6];
      if (dataLen === 0 && type === 0) break; // 빈 패딩
      const dataEnd = Math.min(pos + HEADER_SIZE + dataLen, buf.length);
      const data = buf.slice(pos + HEADER_SIZE, dataEnd);

      if (type === 1) { // FULL
        batches.push(data);
      } else if (type === 2) { // FIRST
        fragments = [data];
      } else if (type === 3) { // MIDDLE
        fragments.push(data);
      } else if (type === 4) { // LAST
        fragments.push(data);
        batches.push(Buffer.concat(fragments));
        fragments = [];
      }
      pos = dataEnd;
    }
  }

  // 2단계: 배치에서 key-value 쌍 추출
  const keyBuf = Buffer.from(targetKey, 'ascii');

  for (const batch of batches) {
    if (batch.length < 12) continue;
    // sequence(8) + count(4) + entries
    let pos = 12;

    while (pos < batch.length) {
      const entryType = batch[pos++]; // 1=Put, 0=Delete
      const [keyLen, keyStart] = readVarint(batch, pos);
      pos = keyStart;
      if (pos + keyLen > batch.length) break;
      const key = batch.slice(pos, pos + keyLen);
      pos += keyLen;

      if (entryType === 1) { // Put
        const [valLen, valStart] = readVarint(batch, pos);
        pos = valStart;
        if (pos + valLen > batch.length) break;

        // key에 targetKey가 포함되어 있으면 값 추출
        if (key.indexOf(keyBuf) >= 0) {
          // Chromium localStorage value: 1바이트 타입 접두사(0x00=UTF-16LE) + UTF-16LE 데이터
          const valBuf = batch.slice(pos + 1, pos + valLen); // 첫 바이트 스킵
          try { return valBuf.toString('utf16le'); } catch { /* skip */ }
        }
        pos += valLen;
      }
      // Delete는 value 없음
    }
  }
  return null;
}

function readVarint(buf, offset) {
  let result = 0, shift = 0, pos = offset;
  while (pos < buf.length) {
    const byte = buf[pos++];
    result |= (byte & 0x7F) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return [result, pos];
}

// .ldb (SSTable) 파일: 나이브 바이트 스캔 (비압축 블록 대상, 최선 노력)
function extractFromRawScan(buf, targetKey) {
  const keyBuf = Buffer.from(targetKey, 'ascii');
  let searchStart = 0;

  while (true) {
    const idx = buf.indexOf(keyBuf, searchStart);
    if (idx < 0) return null;
    searchStart = idx + 1;

    // key 뒤에서 UTF-16LE '[' 또는 '{' 찾기
    let pos = idx + keyBuf.length;
    while (pos < buf.length - 1) {
      const lo = buf[pos], hi = buf[pos + 1];
      if (hi === 0 && (lo === 0x5B || lo === 0x7B)) break;
      pos++;
    }
    if (pos >= buf.length - 1) continue;

    const openChar = buf[pos];
    const closeChar = openChar === 0x5B ? 0x5D : 0x7D;
    let depth = 0, end = -1;
    for (let i = pos; i < buf.length - 1; i += 2) {
      const lo = buf[i], hi = buf[i + 1];
      if (hi !== 0) continue;
      if (lo === openChar) depth++;
      else if (lo === closeChar) { depth--; if (depth === 0) { end = i + 2; break; } }
    }
    if (end < 0) continue;

    const text = buf.slice(pos, end).toString('utf16le');
    try { JSON.parse(text); return text; } catch { continue; }
  }
}

// ======================================================
// 파일 기반 저장소 (환자별 개별 파일)
// ======================================================
const dataDir = path.join(app.getPath('userData'), 'wr-eval-data');
const patientsDir = path.join(dataDir, 'patients');
const savedDir = path.join(dataDir, 'saved');
const customPresetsPath = path.join(dataDir, 'custom-presets.json');

function ensureDirs() {
  for (const dir of [dataDir, patientsDir, savedDir]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

function readJsonFile(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch { return fallback; }
}

function writeJsonFile(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

// index.json: 환자 메타 목록
function loadIndex() {
  return readJsonFile(path.join(dataDir, 'index.json'), []);
}

function saveIndex(index) {
  writeJsonFile(path.join(dataDir, 'index.json'), index);
}

function sanitizeId(id) {
  const str = String(id);
  if (!/^[\w-]+$/.test(str)) {
    throw new Error('Invalid id: ' + str.slice(0, 50));
  }
  return str;
}

// 환자 개별 파일
ipcMain.handle('fs-load-all-patients', async () => {
  ensureDirs();
  const index = loadIndex();
  const patients = [];
  for (const meta of index) {
    const p = readJsonFile(path.join(patientsDir, `${meta.id}.json`));
    if (p) patients.push(p);
  }
  return patients;
});

ipcMain.handle('fs-load-patient', async (_e, id) => {
  ensureDirs();
  return readJsonFile(path.join(patientsDir, `${sanitizeId(id)}.json`));
});

ipcMain.handle('fs-save-patient', async (_e, patient) => {
  ensureDirs();
  sanitizeId(patient.id);
  writeJsonFile(path.join(patientsDir, `${patient.id}.json`), patient);
  // index 업데이트
  const index = loadIndex();
  const existing = index.findIndex(m => m.id === patient.id);
  const meta = {
    id: patient.id,
    name: patient.data?.shared?.name || '',
    createdAt: patient.createdAt || '',
    updatedAt: patient.updatedAt || '',
  };
  if (existing >= 0) index[existing] = meta;
  else index.push(meta);
  saveIndex(index);
});

ipcMain.handle('fs-delete-patient', async (_e, id) => {
  ensureDirs();
  const filePath = path.join(patientsDir, `${sanitizeId(id)}.json`);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  const index = loadIndex().filter(m => m.id !== id);
  saveIndex(index);
});

ipcMain.handle('fs-save-all-patients', async (_e, patients) => {
  ensureDirs();
  patients.forEach(p => sanitizeId(p.id));
  const index = [];
  for (const p of patients) {
    writeJsonFile(path.join(patientsDir, `${p.id}.json`), p);
    index.push({
      id: p.id,
      name: p.data?.shared?.name || '',
      createdAt: p.createdAt || '',
      updatedAt: p.updatedAt || '',
    });
  }
  saveIndex(index);
});

// 저장 항목 (savedItems)
ipcMain.handle('fs-load-items', async () => {
  ensureDirs();
  const files = fs.readdirSync(savedDir).filter(f => f.endsWith('.json'));
  const items = [];
  for (const file of files) {
    const item = readJsonFile(path.join(savedDir, file));
    if (item) items.push(item);
  }
  return items.sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
});

ipcMain.handle('fs-save-item', async (_e, item) => {
  ensureDirs();
  sanitizeId(item.id);
  writeJsonFile(path.join(savedDir, `${item.id}.json`), item);
});

ipcMain.handle('fs-delete-item', async (_e, id) => {
  ensureDirs();
  const filePath = path.join(savedDir, `${sanitizeId(id)}.json`);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
});

// 자동저장
ipcMain.handle('fs-save-autosave', async (_e, data) => {
  ensureDirs();
  writeJsonFile(path.join(dataDir, 'autosave.json'), data);
});

ipcMain.handle('fs-load-autosave', async () => {
  ensureDirs();
  return readJsonFile(path.join(dataDir, 'autosave.json'));
});

ipcMain.handle('fs-clear-autosave', async () => {
  const filePath = path.join(dataDir, 'autosave.json');
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
});

// 설정
ipcMain.handle('fs-save-settings', async (_e, settings) => {
  ensureDirs();
  writeJsonFile(path.join(dataDir, 'settings.json'), settings);
});

ipcMain.handle('fs-load-settings', async () => {
  ensureDirs();
  return readJsonFile(path.join(dataDir, 'settings.json'));
});

// 커스텀 프리셋
ipcMain.handle('fs-load-custom-presets', async () => {
  ensureDirs();
  return readJsonFile(customPresetsPath, []);
});

ipcMain.handle('fs-save-custom-presets', async (_e, presets) => {
  ensureDirs();
  writeJsonFile(customPresetsPath, Array.isArray(presets) ? presets : []);
});

// 마이그레이션: localStorage 데이터를 파일로 이전
ipcMain.handle('fs-migrate', async (_e, { savedItems, autoSave, settings }) => {
  ensureDirs();
  const indexPath = path.join(dataDir, 'index.json');
  if (fs.existsSync(indexPath)) return { migrated: false }; // 이미 마이그레이션됨

  // savedItems 마이그레이션
  if (savedItems && Array.isArray(savedItems)) {
    for (const item of savedItems) {
      writeJsonFile(path.join(savedDir, `${item.id}.json`), item);
      // 환자 데이터도 개별 파일로
      if (item.patients) {
        for (const p of item.patients) {
          writeJsonFile(path.join(patientsDir, `${p.id}.json`), p);
        }
      }
    }
  }

  // autoSave 마이그레이션
  if (autoSave && autoSave.patients) {
    writeJsonFile(path.join(dataDir, 'autosave.json'), autoSave);
    const index = [];
    for (const p of autoSave.patients) {
      writeJsonFile(path.join(patientsDir, `${p.id}.json`), p);
      index.push({
        id: p.id,
        name: p.data?.shared?.name || '',
        createdAt: p.createdAt || '',
        updatedAt: p.updatedAt || '',
      });
    }
    saveIndex(index);
  } else {
    saveIndex([]);
  }

  // 설정 마이그레이션
  if (settings) {
    writeJsonFile(path.join(dataDir, 'settings.json'), settings);
  }

  return { migrated: true };
});

// EmrHelper.exe 경로 해석 (개발: bin/Release, 패키징: extraResources)
function getHelperExe() {
  const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
  return isDev
    ? path.join(__dirname, 'emr-helper', 'bin', 'Release', 'EmrHelper.exe')
    : path.join(process.resourcesPath, 'emr-helper', 'EmrHelper.exe');
}

// EmrHelper 실행 공통 래퍼 (args: string[], timeoutMs: number)
function runHelper(args, timeoutMs = 15000) {
  const helperExe = getHelperExe();
  if (!fs.existsSync(helperExe)) {
    return Promise.resolve({ success: false, message: 'EmrHelper.exe not found: ' + helperExe });
  }
  return new Promise((resolve) => {
    execFile(
      helperExe, args,
      { timeout: timeoutMs, windowsHide: true, encoding: 'utf-8' },
      (error, stdout, stderr) => {
        const trimmed = (stdout || '').trim();
        const trimmedStderr = (stderr || '').trim();

        if (error && error.killed && !trimmed) {
          resolve({ success: false, message: `EmrHelper timeout (${timeoutMs / 1000}s)`, errorCode: error.code || null });
          return;
        }

        if (trimmed) {
          try {
            resolve(JSON.parse(trimmed));
          } catch {
            resolve({ success: false, message: 'EmrHelper response parse error', rawStdout: trimmed, rawStderr: trimmedStderr || undefined });
          }
          return;
        }

        if (error) {
          resolve({ success: false, message: error.message || trimmedStderr || 'EmrHelper returned no output', rawStderr: trimmedStderr || undefined, errorCode: error.code || null });
          return;
        }

        resolve({ success: false, message: trimmedStderr || 'EmrHelper returned no output' });
      }
    );
  });
}

// IPC: EMR 직접입력 (C# EmrHelper.exe → IE DOM 주입)
ipcMain.handle('emr-inject', async (event, fieldData) => {
  if (IS_INTRANET_BUILD && !isAllowedSender(event.sender.getURL())) {
    console.warn('[emr-inject] rejected: sender origin not in whitelist', event.sender.getURL());
    // TODO(T34): send rejection event to server audit log via device token signature
    return { success: false, message: 'EMR access denied: sender origin not allowed.' };
  }
  if (process.platform !== 'win32') {
    return { success: false, message: 'EMR direct input is Windows-only.' };
  }

  const tmpJson = path.join(os.tmpdir(), `emr-inject-${Date.now()}.json`);

  const helperExe = getHelperExe();

  if (!fs.existsSync(helperExe)) {
    return { success: false, message: 'EmrHelper.exe not found: ' + helperExe };
  }

  try {
    fs.writeFileSync(tmpJson, JSON.stringify(fieldData), 'utf-8');

    const helperRun = await new Promise((resolve) => {
      execFile(
        helperExe,
        ['--json', tmpJson],
        { timeout: 15000, windowsHide: true, encoding: 'utf-8' },
        (error, stdout, stderr) => {
          resolve({
            error: error || null,
            stdout: stdout || '',
            stderr: stderr || ''
          });
        }
      );
    });

    const { error, stdout, stderr } = helperRun;
    const trimmed = stdout.trim();
    const trimmedStderr = stderr.trim();

    if (error && error.killed && !trimmed) {
      return {
        success: false,
        message: 'EmrHelper timeout (15s)',
        errorCode: error.code || null
      };
    }

    // stdout에 JSON이 있으면 항상 그걸 반환
    if (trimmed) {
      try {
        const result = JSON.parse(trimmed);
        if (!result.success) {
          console.warn('[emr-inject:debug]', {
            candidateWindows: result.candidateWindows || [],
            debugSummary: result.debugSummary,
            stderr: trimmedStderr,
            errorCode: error?.code || null,
            errorMessage: error?.message || null
          });
        }
        return result;
      } catch {
        console.error('[emr-inject:parse-error]', {
          stdout: trimmed,
          stderr: trimmedStderr,
          errorCode: error?.code || null,
          errorMessage: error?.message || null
        });
        return {
          success: false,
          message: 'EmrHelper response parse error',
          rawStdout: trimmed,
          rawStderr: trimmedStderr || undefined,
          errorCode: error?.code || null
        };
      }
    }

    if (error) {
      console.error('[emr-inject:startup-error]', {
        errorCode: error.code || null,
        errorMessage: error.message,
        stderr: trimmedStderr,
        helperExe
      });
      return {
        success: false,
        message: error.message || trimmedStderr || 'EmrHelper returned no output',
        rawStdout: undefined,
        rawStderr: trimmedStderr || undefined,
        errorCode: error.code || null
      };
    }

    return {
      success: false,
      message: trimmedStderr || 'EmrHelper returned no output',
      rawStdout: undefined,
      rawStderr: trimmedStderr || undefined
    };
  } catch (err) {
    return { success: false, message: 'EMR inject failed: ' + err.message };
  } finally {
    try { fs.unlinkSync(tmpJson); } catch {}
  }
});

// IPC: 진료기록 데이터 추출 (단건 — App.jsx가 환자별 루프 수행)
ipcMain.handle('emr-extract-record', async (event, patientNo) => {
  if (IS_INTRANET_BUILD && !isAllowedSender(event.sender.getURL())) {
    console.warn('[emr-extract-record] rejected: sender origin not in whitelist', event.sender.getURL());
    // TODO(T34): send rejection event to server audit log via device token signature
    return { success: false, error: 'EMR access denied: sender origin not allowed.' };
  }
  if (process.platform !== 'win32') {
    return { success: false, error: 'EMR extraction is Windows-only.' };
  }
  return runHelper(['--extract-record', String(patientNo)], 30000);
});

// IPC: 다학제회신 추출 (현재 열린 진료메인 페이지 대상)
ipcMain.handle('emr-extract-consultation', async (event) => {
  if (IS_INTRANET_BUILD && !isAllowedSender(event.sender.getURL())) {
    console.warn('[emr-extract-consultation] rejected: sender origin not in whitelist', event.sender.getURL());
    // TODO(T34): send rejection event to server audit log via device token signature
    return { success: false, error: 'EMR access denied: sender origin not allowed.' };
  }
  if (process.platform !== 'win32') {
    return { success: false, error: 'EMR extraction is Windows-only.' };
  }
  return runHelper(['--extract-consultation'], 15000);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});
