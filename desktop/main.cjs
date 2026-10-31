/**
 * PaperLens 桌面启动器（Electron 主进程）。
 *
 * 不依赖系统安装的 Node：Electron 自带 Node 24，设置 ELECTRON_RUN_AS_NODE=1
 * 后用自身可执行文件运行 server/index.mjs，因此 node:sqlite 可用。
 *
 * 职责：启动/停止本地服务、等待健康检查、打开默认浏览器、显示状态与日志。
 */
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const HOST = '127.0.0.1';
const DEFAULT_PORT = 5173;
const PORT_RANGE = 30;
const APP_ROOT = path.resolve(__dirname, '..');
const SERVER_ENTRY = path.join(APP_ROOT, 'server', 'index.mjs');

let mainWindow = null;
let serverProcess = null;
let startingPromise = null;
let quitRequested = false;

const state = {
  status: 'stopped', // stopped | starting | running | error
  port: DEFAULT_PORT,
  message: '服务未启动',
  logs: [],
  owned: false,
};

function dataDir() {
  return path.resolve(process.env.PAPERLENS_DATA_DIR || path.join(os.homedir(), '.paperlens', 'data'));
}

function publicState() {
  return {
    ...state,
    logs: state.logs.slice(-120),
    url: `http://${HOST}:${state.port}/`,
    dataDir: dataDir(),
  };
}

function broadcast() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('launcher:state', publicState());
  }
}

function appendLog(chunk) {
  const text = String(chunk || '');
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    state.logs.push(line.slice(0, 2000));
  }
  if (state.logs.length > 200) state.logs.splice(0, state.logs.length - 200);
  broadcast();
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, HOST);
  });
}

function probeHealth(port, timeout = 900) {
  return new Promise((resolve) => {
    const req = http.get({ host: HOST, port, path: '/api/health', timeout }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve(res.statusCode === 200 && json?.service === 'paperlens');
        } catch {
          resolve(false);
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

async function pickPort() {
  if (await probeHealth(DEFAULT_PORT)) return { port: DEFAULT_PORT, existing: true };
  for (let port = DEFAULT_PORT; port < DEFAULT_PORT + PORT_RANGE; port += 1) {
    if (await isPortFree(port)) return { port, existing: false };
  }
  throw new Error(`端口 ${DEFAULT_PORT}–${DEFAULT_PORT + PORT_RANGE - 1} 都被占用`);
}

async function waitForHealth(port, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (serverProcess && serverProcess.exitCode !== null) return false;
    if (await probeHealth(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function openPage() {
  if (state.status === 'running') shell.openExternal(`http://${HOST}:${state.port}/`);
  return publicState();
}

async function startServer() {
  if (startingPromise) return startingPromise;
  if (state.status === 'running') return publicState();

  startingPromise = (async () => {
    state.status = 'starting';
    state.message = '正在启动服务…';
    broadcast();
    try {
      const { port, existing } = await pickPort();
      state.port = port;

      if (existing) {
        state.status = 'running';
        state.owned = false;
        state.message = `检测到已在运行的服务（端口 ${port}）`;
        broadcast();
        openPage();
        return publicState();
      }

      const env = { ...process.env, PORT: String(port), HOST, ELECTRON_RUN_AS_NODE: '1' };
      serverProcess = spawn(process.execPath, [SERVER_ENTRY], {
        cwd: APP_ROOT,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      state.owned = true;

      serverProcess.stdout.setEncoding('utf8');
      serverProcess.stderr.setEncoding('utf8');
      serverProcess.stdout.on('data', appendLog);
      serverProcess.stderr.on('data', appendLog);
      serverProcess.on('exit', (code, signal) => {
        serverProcess = null;
        if (state.status === 'running' || state.status === 'starting') {
          state.status = 'stopped';
          state.owned = false;
          state.message = `服务已退出（${signal || code || '未知原因'}）`;
          broadcast();
        }
      });

      const ready = await waitForHealth(port, 15000);
      if (!ready) throw new Error('服务启动超时，请查看日志');

      state.status = 'running';
      state.message = '服务运行中';
      broadcast();
      openPage();
    } catch (err) {
      state.status = 'error';
      state.owned = false;
      state.message = err.message || String(err);
      broadcast();
    } finally {
      startingPromise = null;
    }
    return publicState();
  })();

  return startingPromise;
}

function stopServer() {
  if (serverProcess) {
    const child = serverProcess;
    serverProcess = null;
    try {
      child.kill();
    } catch {
      /* 已经退出 */
    }
    state.status = 'stopped';
    state.owned = false;
    state.message = '服务已停止';
  } else if (state.status !== 'stopped') {
    state.status = 'stopped';
    state.owned = false;
    state.message = '服务未运行';
  }
  broadcast();
  return publicState();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 820,
    height: 620,
    minWidth: 680,
    minHeight: 520,
    title: 'PaperLens 启动器',
    backgroundColor: '#0b0f16',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function registerIpc() {
  ipcMain.handle('launcher:get-state', () => publicState());
  ipcMain.handle('launcher:start', () => startServer());
  ipcMain.handle('launcher:stop', () => stopServer());
  ipcMain.handle('launcher:open', () => openPage());
  ipcMain.handle('launcher:open-data', async () => {
    fs.mkdirSync(dataDir(), { recursive: true });
    await shell.openPath(dataDir());
    return publicState();
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    registerIpc();
    createWindow();
    // 双击即用：启动器打开时自动拉起服务，启动成功后自动打开默认浏览器
    startServer();
  });

  app.on('window-all-closed', () => {
    quitRequested = true;
    stopServer();
    app.quit();
  });

  app.on('before-quit', () => {
    if (!quitRequested) stopServer();
  });
}
