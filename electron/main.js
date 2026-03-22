const { app, BrowserWindow, Menu, ipcMain, dialog } = require('electron');
const path = require('path');
const os = require('os');
const https = require('https');

// Windows 7 GPU 호환성
if (process.platform === 'win32' && os.release().startsWith('6.1')) {
  app.commandLine.appendSwitch('disable-gpu');
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
            detail: `버전: 2.0.0\n\n직업환경의학 전문의를 위한 통합 평가 도구\n(무릎/척추 평가 지원)`
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

// IPC: AI 분석 (Electron에서 직접 Claude API 호출)
ipcMain.handle('analyze-ai', async (_event, { prompt, systemPrompt, model, apiKey }) => {
  const key = apiKey || process.env.CLAUDE_API_KEY || '';

  if (!key) {
    return { error: { message: 'API 키가 설정되지 않았습니다. 설정에서 Claude API 키를 입력하세요.' } };
  }

  try {
    const body = JSON.stringify({
      model: model || 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      system: [{ type: 'text', text: systemPrompt || '', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: prompt }]
    });

    const data = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'prompt-caching-2024-07-31',
          'Content-Length': Buffer.byteLength(body)
        }
      }, (res) => {
        let chunks = '';
        res.on('data', (chunk) => { chunks += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(chunks)); }
          catch { reject(new Error('응답 파싱 오류')); }
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    return data;
  } catch (error) {
    return { error: { message: 'AI 서버 연결 오류: ' + error.message } };
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});
