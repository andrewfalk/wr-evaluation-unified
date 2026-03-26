const { app, BrowserWindow, Menu, ipcMain, dialog, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

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
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 1024,
    minHeight: 768,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    icon: path.join(__dirname, '../public/icon.ico'),
    title: '직업성 질환 통합 평가 프로그램'
  });

  const isDev = process.env.NODE_ENV === 'development';

  if (isDev) {
    mainWindow.loadURL('http://localhost:3000');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/electron/index.html'));
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
            message: '직업성 질환 통합 평가 프로그램',
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
        try { resolve(JSON.parse(chunks)); }
        catch { reject(new Error('응답 파싱 오류')); }
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

  return netRequest(`https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${apiKey}`, {
    headers: { 'Content-Type': 'application/json' }
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

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});
