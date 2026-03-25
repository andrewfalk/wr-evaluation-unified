const { app, BrowserWindow, Menu, ipcMain, dialog, net } = require('electron');
const path = require('path');
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

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});
