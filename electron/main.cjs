'use strict';

const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const http = require('http');

// ─── Config ───────────────────────────────────────────────────────────────

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
const VITE_URL = 'http://localhost:3100';
const BACKEND_PORT = 8000;

let mainWindow = null;
let backendProcess = null;

// ─── Backend (Python FastAPI) ─────────────────────────────────────────────

function waitForBackend(retries = 20, delay = 500) {
  return new Promise((resolve, reject) => {
    function attempt(n) {
      http.get(`http://localhost:${BACKEND_PORT}/api/health`, (res) => {
        if (res.statusCode === 200) resolve();
        else retry(n);
      }).on('error', () => retry(n));
    }
    function retry(n) {
      if (n <= 0) return reject(new Error('Backend did not start'));
      setTimeout(() => attempt(n - 1), delay);
    }
    attempt(retries);
  });
}

function startBackend() {
  const backendDir = app.isPackaged
    ? path.join(process.resourcesPath, 'backend')
    : path.join(__dirname, '..', 'backend');

  const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
  const mainPy = path.join(backendDir, 'main.py');

  if (!fs.existsSync(mainPy)) {
    console.warn('[Electron] backend/main.py not found, skipping backend start');
    return;
  }

  backendProcess = spawn(pythonCmd, [mainPy], {
    cwd: backendDir,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  backendProcess.stdout.on('data', (d) => process.stdout.write(`[py] ${d}`));
  backendProcess.stderr.on('data', (d) => process.stderr.write(`[py] ${d}`));
  backendProcess.on('exit', (code) => console.log(`[Electron] Backend exited: ${code}`));
}

function stopBackend() {
  if (backendProcess) {
    backendProcess.kill('SIGTERM');
    backendProcess = null;
  }
}

// ─── Window ───────────────────────────────────────────────────────────────

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 960,
    minWidth: 1024,
    minHeight: 600,
    title: 'BubbleGraph',
    icon: path.join(__dirname, '..', 'public', 'favicon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    frame: true,
    backgroundColor: '#0f0f0f',
  });

  buildMenu();

  if (isDev) {
    await mainWindow.loadURL(VITE_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    const indexHtml = path.join(__dirname, '..', 'dist', 'index.html');
    await mainWindow.loadFile(indexHtml);
  }

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ─── Native Menu ──────────────────────────────────────────────────────────

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'New Project',
          accelerator: 'CmdOrCtrl+N',
          click: () => mainWindow?.webContents.send('menu:new-project'),
        },
        {
          label: 'Open Project…',
          accelerator: 'CmdOrCtrl+O',
          click: () => mainWindow?.webContents.send('menu:open-project'),
        },
        {
          label: 'Save Project',
          accelerator: 'CmdOrCtrl+S',
          click: () => mainWindow?.webContents.send('menu:save-project'),
        },
        {
          label: 'Save Project As…',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => triggerSaveAs(),
        },
        { type: 'separator' },
        {
          label: 'Export IFC',
          accelerator: 'CmdOrCtrl+E',
          click: () => mainWindow?.webContents.send('menu:export-ifc'),
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' },
        { type: 'separator' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ─── IPC: File dialogs ─────────────────────────────────────────────────────

async function triggerOpenProject() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open BubbleGraph Project',
    filters: [{ name: 'BubbleGraph Project', extensions: ['bgjson', 'json'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths.length) return;
  const filePath = result.filePaths[0];
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(content);
    mainWindow?.webContents.send('project:opened', { filePath, data });
  } catch (err) {
    dialog.showErrorBox('Error', `Could not open file:\n${err.message}`);
  }
}

async function triggerSaveAs() {
  mainWindow?.webContents.send('project:request-save-as');
}

// IPC: renderer asks for a save dialog path
ipcMain.handle('dialog:save-as', async (_event, defaultName) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save BubbleGraph Project',
    defaultPath: defaultName || 'project.bgjson',
    filters: [{ name: 'BubbleGraph Project', extensions: ['bgjson', 'json'] }],
  });
  return result.canceled ? null : result.filePath;
});

// IPC: renderer asks for open dialog
ipcMain.handle('dialog:open', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open BubbleGraph Project',
    filters: [{ name: 'BubbleGraph Project', extensions: ['bgjson', 'json'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths.length) return null;
  try {
    const filePath = result.filePaths[0];
    const content = fs.readFileSync(filePath, 'utf-8');
    return { filePath, data: JSON.parse(content) };
  } catch (err) {
    return { error: err.message };
  }
});

// IPC: renderer sends data to write to disk
ipcMain.handle('file:save', async (_event, { filePath, data }) => {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    return { success: true };
  } catch (err) {
    return { error: err.message };
  }
});

// IPC: get current project file path (stored in main)
let currentFilePath = null;
ipcMain.handle('project:get-path', () => currentFilePath);
ipcMain.handle('project:set-path', (_e, fp) => { currentFilePath = fp; });

// ─── App lifecycle ─────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  startBackend();

  // Wait up to 10s for backend before showing window
  try {
    await waitForBackend(20, 500);
    console.log('[Electron] Backend ready');
  } catch {
    console.warn('[Electron] Backend not available, continuing anyway');
  }

  await createWindow();

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow();
  });
});

app.on('window-all-closed', () => {
  stopBackend();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => stopBackend());
