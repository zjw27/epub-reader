const { app, BrowserWindow, dialog, Menu, ipcMain } = require('electron');
const path = require('path');

// 开发期兜底：关沙箱（稳）
app.commandLine.appendSwitch('no-sandbox');  // 将它放在此处

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    frame: true,
    titleBarStyle: 'hidden', // 开启半fregisterShortcuts自绘
    icon: path.join(__dirname, 'favicon.ico'),
    titleBarOverlay: { color: '#FAFAFB', symbolColor: '#0F1115', height: 36 },

    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      enableRemoteModule: false,  // 禁用远程模块（出于安全考虑）
      sandbox: false
    },
    
  });

  // 创建菜单栏
  const menuTemplate = [
    {
      label: 'File',
      submenu: [
        { label: '打开 EPUB', accelerator: 'Ctrl+O', click: () => win.webContents.send('open-epub') },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    // 你可以继续添加其他菜单项
  ];

  const menu = Menu.buildFromTemplate(menuTemplate);
  Menu.setApplicationMenu(menu);

  // 修改 DevTools 字体
  const injectDevtoolsCSS = () => {
    const devtools =
      (win.webContents.getDevToolsWebContents && win.webContents.getDevToolsWebContents()) ||
      win.webContents.devToolsWebContents;
    if (!devtools) return;

    const inject = () => {
      devtools.executeJavaScript(`
        (function () {
          if (document.getElementById('__custom-devtools-font')) return;
          const style = document.createElement('style');
          style.id = '__custom-devtools-font';
          style.textContent = \`
            :root {
              --monospace-font-family:
                "JetBrainsMono Nerd Font Mono",
                "JetBrainsMono NF",
                "JetBrains Mono",
                Consolas,
                monospace !important;
              --source-code-font-family: var(--monospace-font-family) !important;
            }
            .source-code, .CodeMirror, .cm-editor, .monaco-editor, .monospace {
              font-family: var(--monospace-font-family) !important;
              font-size: 15px !important;
              font-weight: 400 !important;
            }
          \`;
          document.documentElement.appendChild(style);
        })();
      `).catch(() => { });
    };

    devtools.once?.('dom-ready', inject);
    try { inject(); } catch { }
  };


  win.webContents.on('devtools-opened', injectDevtoolsCSS);
  win.webContents.on('did-open-devtools', injectDevtoolsCSS);
  win.webContents.on('before-input-event', (event, input) => {
  if (input.type !== 'keyDown') return; // 防止长按/重复触发

  // F12 → DevTools
  if (input.key === 'F12' && !input.alt && !input.control && !input.meta && !input.shift) {
    win.webContents.toggleDevTools();
    event.preventDefault();
    return;
  }

  // Ctrl+Shift+R → 强刷（忽略缓存）
  if (input.key?.toLowerCase() === 'r' && input.control && input.shift && !input.alt && !input.meta) {
    win.webContents.reloadIgnoringCache();
    event.preventDefault();
    return;
  }

  // Ctrl+R / F5 → 普通刷新
  if ((input.key?.toLowerCase() === 'r' && input.control) || input.key === 'F5') {
    win.webContents.reload();
    event.preventDefault();
    return;
  }
});


  win.loadFile('index.html');
  win.webContents.once('did-finish-load', () => {
    
  });
}

app.whenReady().then(() => {
  createWindow();  // 删除了重复调用

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// 监听渲染进程事件并触发相关操作
ipcMain.on('open-epub', async (evt) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  // …对话框/解析…
  const payload = await parseEpub(file);   // <- 你真实的解析
  win.webContents.send('book:loaded', payload);  // <- 补这一行
});

ipcMain.handle('pick-epub', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: '选择 EPUB 文件',
    filters: [{ name: 'EPUB', extensions: ['epub'] }],
    properties: ['openFile']
  });
  console.log('[MAIN] pick-epub ->', { canceled, path: filePaths?.[0] });
  if (canceled || !filePaths?.[0]) return null;
  return filePaths[0];
});

ipcMain.on('app:set-title', (evt, t) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  if (win) win.setTitle(String(t || 'EPUB Reader'));
});


