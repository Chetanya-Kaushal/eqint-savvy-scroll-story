const { app, BrowserWindow, ipcMain, screen, desktopCapturer, Tray, Menu, globalShortcut, session, safeStorage, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { spawn } = require('child_process');
const zlib = require('zlib');
const Store = require('electron-store');
const { autoUpdater } = require('electron-updater');
const { describeCursorRegion } = require('./main/cursor-region');
const { loadPolicyConfig } = require('./main/policy-config');
const { makeSecureStorage } = require('./main/secure-storage');

const secureStorage = makeSecureStorage(safeStorage);

let overlayWindow = null;
let tray = null;
let serverProcess = null;
let bipServerProcess = null;
let dashboardServerProcess = null;
let localAuthToken = null;

const API_PORT = process.env.HCM_API_PORT || 8080;
const BIP_PORT = 3000;
const DASHBOARD_PORT = 3001;
const API_URL = `http://localhost:${API_PORT}`;
const BIP_URL = `http://localhost:${BIP_PORT}`;
const DASHBOARD_URL = `http://localhost:${DASHBOARD_PORT}`;

const store = new Store({
  defaults: {
    settings: {
      ollamaUrl: 'http://localhost:11434',
      ollamaModel: 'phi3:mini',
      oracleUrl: '',
      oracleUser: '',
      oraclePass: '',
      alwaysOnTop: true,
    },
    overlayX: null,
    overlayY: null,
    overlayWidth: 420,
    overlayHeight: 750,
  }
});

const API_BASE = `http://localhost:${API_PORT}`;

// ===== Local Auth Token =====
function ensureLocalAuthToken() {
  try {
    const tokenPath = path.join(app.getPath('userData'), 'local-auth-token');
    if (fs.existsSync(tokenPath)) {
      const existing = fs.readFileSync(tokenPath, 'utf8').trim();
      if (existing.length >= 32) { localAuthToken = existing; return localAuthToken; }
    }
    localAuthToken = require('crypto').randomBytes(32).toString('hex');
    fs.writeFileSync(tokenPath, localAuthToken + '\n', { mode: 0o600 });
  } catch (err) {
    console.error('[auth] failed to persist local token:', err.message);
    localAuthToken = require('crypto').randomBytes(32).toString('hex');
  }
  return localAuthToken;
}

// ===== Backend Server Management =====
function findRepoRoot() {
  const candidates = [];
  if (process.env.HCM_AGENT_HOME) candidates.push(process.env.HCM_AGENT_HOME);
  if (!app.isPackaged) candidates.push(path.join(__dirname, '..'));
  candidates.push(path.join(app.getPath('home'), 'hcm-ai-agent'));
  candidates.push(path.join(app.getPath('home'), 'Downloads', 'FUSION AI', 'HCM AI'));
  candidates.push(path.join(app.getPath('home'), 'OneDrive', 'Documents', 'ABHIRAM NAIR', 'FUSION AI', 'HCM AI'));
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'src', 'api', 'server.py'))) return c;
  }
  return null;
}

function waitForApi(url, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve) => {
    const probe = () => {
      const req = http.get(`${url}/health`, { timeout: 2000 }, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve(true);
        retry();
      });
      req.on('error', retry);
      req.on('timeout', () => { req.destroy(); retry(); });
    };
    const retry = () => {
      if (Date.now() - started >= timeoutMs) return resolve(false);
      setTimeout(probe, 1000);
    };
    probe();
  });
}

function findPython() {
  const isWin = process.platform === 'win32';
  const candidates = [
    process.env.HCM_PYTHON,
    isWin ? path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python314', 'python.exe') : null,
    isWin ? path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python313', 'python.exe') : null,
    isWin ? 'python.exe' : null,
    '/Library/Frameworks/Python.framework/Versions/3.13/bin/python3',
    '/usr/local/bin/python3',
    '/opt/homebrew/bin/python3',
    '/usr/bin/python3'
  ].filter(Boolean);
  for (const c of candidates) {
    if (isWin && !c.includes('/') && !c.includes('\\')) return c;
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  return isWin ? 'python' : 'python3';
}

async function startBackendServer() {
  const repoRoot = findRepoRoot();
  if (!repoRoot) {
    console.error('[backend] repo root not found — set HCM_AGENT_HOME');
    return false;
  }
  try {
    const logFd = fs.openSync(path.join(app.getPath('userData'), 'server.log'), 'a');
    ensureLocalAuthToken();
    const env = { ...process.env };
    if (localAuthToken) env.HCM_LOCAL_TOKEN = localAuthToken;
    let pythonCmd = findPython();
    const venvPyPosix = path.join(repoRoot, '.venv', 'bin', 'python3');
    const homeVenvPy = path.join(app.getPath('home'), 'hcm-ai-agent', '.venv', 'bin', 'python3');
    if (process.platform === 'win32') {
      const venvPyWin = path.join(repoRoot, '.venv', 'Scripts', 'python.exe');
      if (fs.existsSync(venvPyWin)) pythonCmd = venvPyWin;
    } else if (fs.existsSync(venvPyPosix)) {
      pythonCmd = venvPyPosix;
    } else if (fs.existsSync(homeVenvPy)) {
      pythonCmd = homeVenvPy;
    }
    console.log(`[backend] using python: ${pythonCmd}`);
    serverProcess = spawn(pythonCmd, [
      '-m', 'uvicorn', 'src.api.server:app',
      '--host', '127.0.0.1', '--port', String(API_PORT)
    ], { cwd: repoRoot, env, stdio: ['ignore', logFd, logFd], detached: false });
    serverProcess.on('error', (err) => { console.error('[backend] spawn error:', err.message); serverProcess = null; });
    serverProcess.on('exit', (code) => { console.log(`[backend] exited code ${code}`); serverProcess = null; });
  } catch (err) {
    console.error('[backend] failed:', err.message);
    return false;
  }
  const healthy = await waitForApi(API_URL, 30000);
  console.log(`[backend] ${healthy ? 'ready' : 'not ready'} at ${API_URL}`);
  return healthy;
}

function stopBackendServer() {
  if (serverProcess) { try { serverProcess.kill(); } catch {} serverProcess = null; }
  if (bipServerProcess) { try { bipServerProcess.kill(); } catch {} bipServerProcess = null; }
  if (dashboardServerProcess) { try { dashboardServerProcess.kill(); } catch {} dashboardServerProcess = null; }
}

async function startBipServer() {
  const repoRoot = findRepoRoot();
  if (!repoRoot) return false;
  const bipDir = path.join(repoRoot, 'bip-report-generator');
  if (!fs.existsSync(path.join(bipDir, 'src', 'server.ts'))) { console.log('[bip] source not found, skipping'); return false; }
  try {
    const logFd = fs.openSync(path.join(app.getPath('userData'), 'bip-server.log'), 'a');
    const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    bipServerProcess = spawn(npx, ['tsx', 'src/server.ts'], {
      cwd: bipDir, env: { ...process.env }, stdio: ['ignore', logFd, logFd], detached: false
    });
    bipServerProcess.on('error', (err) => { console.error('[bip] spawn error:', err.message); bipServerProcess = null; });
    bipServerProcess.on('exit', (code) => { console.log(`[bip] exited code ${code}`); bipServerProcess = null; });
  } catch (err) { console.error('[bip] failed:', err.message); return false; }
  const ok = await waitForApi(BIP_URL, 15000);
  console.log(`[bip] ${ok ? 'ready' : 'not ready'} at ${BIP_URL}`);
  return ok;
}

async function startDashboardServer() {
  const repoRoot = findRepoRoot();
  if (!repoRoot) return false;
  const dashDir = path.join(repoRoot, 'dashboard-fusion', 'server');
  if (!fs.existsSync(path.join(dashDir, 'src', 'index.ts'))) { console.log('[dashboard] source not found, skipping'); return false; }
  try {
    const logFd = fs.openSync(path.join(app.getPath('userData'), 'dashboard-server.log'), 'a');
    const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    dashboardServerProcess = spawn(npx, ['tsx', 'src/index.ts'], {
      cwd: dashDir, env: { ...process.env }, stdio: ['ignore', logFd, logFd], detached: false
    });
    dashboardServerProcess.on('error', (err) => { console.error('[dashboard] spawn error:', err.message); dashboardServerProcess = null; });
    dashboardServerProcess.on('exit', (code) => { console.log(`[dashboard] exited code ${code}`); dashboardServerProcess = null; });
  } catch (err) { console.error('[dashboard] failed:', err.message); return false; }
  const ok = await waitForApi(DASHBOARD_URL, 15000);
  console.log(`[dashboard] ${ok ? 'ready' : 'not ready'} at ${DASHBOARD_URL}`);
  return ok;
}

// ===== Window Creation =====
function createOverlay() {
  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;
  const settings = store.get('settings');
  const savedX = store.get('overlayX');
  const savedY = store.get('overlayY');
  const defaultW = store.get('overlayWidth') || 420;
  const defaultH = store.get('overlayHeight') || 750;
  let posX = savedX;
  let posY = savedY;
  if (posX === null || posY === null || posX > screenW - 100 || posY > screenH - 100 || posX < -10 || posY < -10) {
    posX = Math.round((screenW - defaultW) / 2) + 60;
    posY = Math.round((screenH - defaultH) / 2);
    store.set('overlayX', posX);
    store.set('overlayY', posY);
  }

  overlayWindow = new BrowserWindow({
    width: store.get('overlayWidth') || defaultW,
    height: store.get('overlayHeight') || defaultH,
    x: posX,
    y: posY,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: settings.alwaysOnTop,
    resizable: true,
    skipTaskbar: true,
    hasShadow: false,
    minWidth: 360,
    minHeight: 500,
    icon: path.join(__dirname, '..', 'assets', 'logo-icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  overlayWindow.loadFile(path.join(__dirname, 'overlay.html'));
  overlayWindow.setVisibleOnAllWorkspaces(true);

  overlayWindow.once('ready-to-show', () => {
    overlayWindow.show();
    overlayWindow.focus();
  });

  overlayWindow.on('move', () => {
    if (!store.get('isBubbleMode', false)) {
      const [x, y] = overlayWindow.getPosition();
      store.set('overlayX', x);
      store.set('overlayY', y);
    }
  });

  overlayWindow.on('resize', () => {
    if (!store.get('isBubbleMode', false)) {
      const [width, height] = overlayWindow.getSize();
      store.set('overlayWidth', width);
      store.set('overlayHeight', height);
    }
  });
}

function createTray() {
  tray = new Tray(path.join(__dirname, '..', 'assets', 'logo-tray.png'));
  const settings = store.get('settings');
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show App', click: () => overlayWindow && overlayWindow.show() },
    { label: 'Hide App', click: () => overlayWindow && overlayWindow.hide() },
    { type: 'separator' },
    { label: 'Toggle Always On Top', click: () => {
      const isOnTop = overlayWindow.isAlwaysOnTop();
      overlayWindow.setAlwaysOnTop(!isOnTop);
      settings.alwaysOnTop = !isOnTop;
      store.set('settings', settings);
    }},
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
  tray.setToolTip('EQInt Savvy');
  tray.setContextMenu(contextMenu);
  tray.on('click', () => {
    if (overlayWindow.isVisible()) overlayWindow.hide();
    else overlayWindow.show();
  });
}

// ===== IPC Handlers =====
ipcMain.handle('get-settings', () => store.get('settings'));
ipcMain.handle('set-settings', (e, newSettings) => {
  const currentSettings = store.get('settings');
  store.set('settings', { ...currentSettings, ...newSettings });
  return true;
});

ipcMain.handle('get-conversation-history', () => store.get('conversationHistory', []));
ipcMain.handle('set-conversation-history', (e, history) => { store.set('conversationHistory', history); return true; });

// Local auth token
ipcMain.handle('auth:getLocalToken', () => localAuthToken || ensureLocalAuthToken());

// Window controls
ipcMain.on('window:minimize', () => overlayWindow?.minimize());
ipcMain.on('window:maximize', () => {
  if (overlayWindow?.isMaximized()) overlayWindow.unmaximize();
  else overlayWindow?.maximize();
});
ipcMain.on('window:close', () => overlayWindow?.close());

// Close overlay (hide)
ipcMain.on('close-overlay', () => { if (overlayWindow) overlayWindow.hide(); });

// Overlay positioning
ipcMain.handle('set-overlay-size', (e, { width, height }) => {
  if (overlayWindow) { overlayWindow.setSize(width, height); return true; }
  return false;
});
ipcMain.handle('get-overlay-position', () => {
  if (overlayWindow) { const [x, y] = overlayWindow.getPosition(); return { x, y }; }
  return null;
});
ipcMain.handle('set-overlay-position', (e, { x, y }) => {
  if (overlayWindow) { overlayWindow.setPosition(x, y); return true; }
  return false;
});
ipcMain.handle('center-if-needed', (e, { x, y }) => {
  if (!overlayWindow) return false;
  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;
  const [winW] = overlayWindow.getSize();
  if (x > screenW - 100 || y > screenH - 100 || x < -10 || y < -10) {
    const centerX = Math.round((screenW - winW) / 2);
    const centerY = Math.round((screenH - 750) / 2);
    overlayWindow.setPosition(centerX, centerY);
    store.set('overlayX', centerX); store.set('overlayY', centerY);
    return true;
  }
  return false;
});
ipcMain.handle('center-window', () => {
  if (!overlayWindow) return false;
  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;
  const [winW] = overlayWindow.getSize();
  const centerX = Math.round((screenW - winW) / 2);
  const centerY = Math.round((screenH - 750) / 2);
  overlayWindow.setPosition(centerX, centerY);
  store.set('overlayX', centerX); store.set('overlayY', centerY);
  return true;
});

// Bubble mode
ipcMain.handle('clear-bubble-mode', () => { store.set('isBubbleMode', false); return true; });
ipcMain.handle('move-overlay-to-corner', () => {
  if (overlayWindow) {
    const [cw, ch] = overlayWindow.getSize();
    store.set('overlayWidth', cw); store.set('overlayHeight', ch);
    const [cx, cy] = overlayWindow.getPosition();
    store.set('overlayX', cx); store.set('overlayY', cy);
    store.set('isBubbleMode', true);
    const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;
    overlayWindow.setPosition(screenW - 100, screenH - 100);
    overlayWindow.setSize(80, 80);
    return true;
  }
  return false;
});

// UI state
const ALLOWED_UI_KEYS = ['isBubbleMode', 'isCollapsed', 'overlayWidth', 'overlayHeight', 'overlayX', 'overlayY'];
ipcMain.handle('get-ui-state', (e, key) => ALLOWED_UI_KEYS.includes(key) ? store.get(key) : null);
ipcMain.handle('set-ui-state', (e, { key, value }) => {
  if (!ALLOWED_UI_KEYS.includes(key)) return false;
  store.set(key, value); return true;
});

// Knowledge base
ipcMain.handle('load-knowledge-base', () => {
  const result = { hcmApis: null, knowledgeBase: [] };
  try {
    const apiPath = path.join(__dirname, '..', 'knowledge', 'hcm-apis.json');
    if (fs.existsSync(apiPath)) result.hcmApis = JSON.parse(fs.readFileSync(apiPath, 'utf8'));
  } catch (err) { console.error('Failed to load HCM APIs:', err); }
  try {
    const kbPath = path.join(__dirname, '..', 'knowledge', 'hcm.json');
    if (fs.existsSync(kbPath)) result.knowledgeBase = JSON.parse(fs.readFileSync(kbPath, 'utf8'));
  } catch (err) { console.error('Failed to load knowledge base:', err); }
  return result;
});

// Oracle HCM REST API proxy
ipcMain.handle('oracle-api', async (e, { url, user, pass }) => {
  console.log('[Oracle] API call:', url);
  return new Promise((resolve) => {
    const auth = 'Basic ' + Buffer.from(user + ':' + pass).toString('base64');
    const parsedUrl = new URL(url);
    const transport = parsedUrl.protocol === 'https:' ? https : http;
    const req = transport.get({
      hostname: parsedUrl.hostname, port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      headers: { Authorization: auth, Accept: 'application/json', 'Accept-Encoding': 'gzip, deflate, br' },
      timeout: 15000,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => { chunks.push(chunk); });
      res.on('end', () => {
        const rawBuffer = Buffer.concat(chunks);
        const encoding = (res.headers['content-encoding'] || '').toLowerCase();
        let body;
        try {
          if (encoding.includes('gzip')) body = zlib.gunzipSync(rawBuffer).toString('utf8');
          else if (encoding.includes('br')) body = zlib.brotliDecompressSync(rawBuffer).toString('utf8');
          else if (encoding.includes('deflate')) body = zlib.inflateSync(rawBuffer).toString('utf8');
          else body = rawBuffer.toString('utf8');
        } catch { body = rawBuffer.toString('utf8'); }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          resolve({ ok: false, status: res.statusCode, statusText: res.statusMessage, body: body.slice(0, 500) });
        } else {
          try { resolve({ ok: true, status: res.statusCode, data: JSON.parse(body) }); }
          catch { resolve({ ok: false, status: res.statusCode, statusText: 'Invalid JSON', body: body.slice(0, 500) }); }
        }
      });
    });
    req.on('error', (err) => resolve({ ok: false, status: 0, statusText: err.message, body: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, statusText: 'Request timed out (15s)', body: '' }); });
  });
});

// Screen capture
ipcMain.handle('capture-screen', async () => {
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1920, height: 1080 } });
    if (sources.length > 0) return sources[0].thumbnail.toDataURL();
  } catch (err) { console.error('Screen capture failed:', err); }
  return null;
});
ipcMain.handle('get-window-sources', async () => {
  try {
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1920, height: 1080 } });
    return sources.map(s => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() }));
  } catch (err) { console.error('Window capture failed:', err); return []; }
});
ipcMain.handle('capture-window', async (e, windowId) => {
  try {
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1920, height: 1080 } });
    const source = sources.find(s => s.id === windowId);
    if (source) return source.thumbnail.toDataURL();
  } catch (err) { console.error('Window capture failed:', err); }
  return null;
});

// Cursor awareness
ipcMain.handle('get-cursor-context', () => {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const region = describeCursorRegion(cursor, display.workArea);
  return { x: cursor.x, y: cursor.y, region };
});

// SSO
try {
  const { loginWithSso, getAuthState, logout } = require('./main/auth');
  ipcMain.handle('login-with-sso', (e, { backendUrl, tenantId }) => loginWithSso(backendUrl, tenantId));
  ipcMain.handle('get-auth-state', () => getAuthState());
  ipcMain.handle('logout', () => logout());
} catch (e) { console.log('[sso] auth module not available'); }

// File dialogs
const ALLOWED_EXTERNAL_URLS = [/^https:\/\/.*\.oraclecloud\.com/, /^https:\/\/github\.com/, /^https:\/\/docs\.oracle\.com/];
const allowedPaths = new Set();
ipcMain.handle('dialog:openFiles', async (event, options) => {
  const result = await dialog.showOpenDialog(overlayWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Documents', extensions: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'txt'] },
      { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'bmp'] },
      { name: 'All Files', extensions: ['*'] }
    ],
    ...options
  });
  if (!result.canceled && result.filePaths) {
    for (const fp of result.filePaths) { allowedPaths.add(path.dirname(fp)); allowedPaths.add(fp); }
  }
  return result;
});
ipcMain.handle('dialog:saveFile', async (event, options) => {
  const result = await dialog.showSaveDialog(overlayWindow, {
    filters: [{ name: 'PDF', extensions: ['pdf'] }, { name: 'Excel', extensions: ['xlsx'] }, { name: 'CSV', extensions: ['csv'] }],
    ...options
  });
  if (!result.canceled && result.filePath) { allowedPaths.add(path.dirname(result.filePath)); allowedPaths.add(result.filePath); }
  return result;
});
ipcMain.handle('dialog:showMessageBox', async (event, options) => {
  return await dialog.showMessageBox(overlayWindow, options);
});

function isPathAllowed(filePath) {
  const resolved = path.resolve(filePath);
  if (resolved.startsWith(path.join(require('os').tmpdir(), 'hcm-reconciliation-uploads'))) return true;
  for (const allowed of allowedPaths) {
    if (resolved.startsWith(path.resolve(allowed))) return true;
  }
  return false;
}
ipcMain.handle('file:read', async (event, filePath) => {
  try {
    if (!isPathAllowed(filePath)) return { success: false, error: 'Path not allowed' };
    return { success: true, data: fs.readFileSync(filePath).toString('base64') };
  } catch (error) { return { success: false, error: error.message }; }
});
ipcMain.handle('file:write', async (event, filePath, base64Data) => {
  try {
    if (!isPathAllowed(filePath)) return { success: false, error: 'Path not allowed' };
    fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
    return { success: true, filePath };
  } catch (error) { return { success: false, error: error.message }; }
});

// Shell open external
ipcMain.on('shell:openExternal', (event, url) => {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return;
    if (ALLOWED_EXTERNAL_URLS.some(pattern => pattern.test(url))) shell.openExternal(url);
  } catch {}
});

// API request proxy
ipcMain.handle('api:request', async (event, { method, url, data, headers }) => {
  try {
    const options = { method: method || 'GET', headers: { 'Content-Type': 'application/json', ...headers } };
    if (data && method !== 'GET') options.body = JSON.stringify(data);
    const response = await fetch(url, options);
    const result = await response.json();
    return { success: true, data: result, status: response.status };
  } catch (error) { return { success: false, error: error.message }; }
});

// Store config
const ALLOWED_CONFIG_KEYS = new Set(['settings']);
ipcMain.handle('store:get', (event, key) => {
  const configPath = path.join(app.getPath('userData'), 'config.json');
  try { return JSON.parse(fs.readFileSync(configPath, 'utf-8'))[key]; } catch { return null; }
});
ipcMain.handle('store:set', (event, key, value) => {
  if (!ALLOWED_CONFIG_KEYS.has(key)) return false;
  const configPath = path.join(app.getPath('userData'), 'config.json');
  let config = {};
  try { config = JSON.parse(fs.readFileSync(configPath, 'utf-8')); } catch {}
  config[key] = value;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return true;
});

// ===== App Lifecycle =====
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': ["default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self' http://localhost:* https://*.oraclecloud.com; frame-src http://localhost:*"],
      },
    });
  });

  const policy = loadPolicyConfig((p, enc) => fs.readFileSync(p, enc), process.platform);
  if (policy) {
    const settings = store.get('settings');
    store.set('settings', { ...settings, ...policy });
  }

  // Start servers
  const backendReady = startBackendServer();
  startBipServer();
  startDashboardServer();

  createOverlay();
  createTray();

  globalShortcut.register('CommandOrControl+Shift+S', () => {
    if (overlayWindow.isVisible()) overlayWindow.hide();
    else overlayWindow.show();
  });

  autoUpdater.checkForUpdatesAndNotify().catch((err) => {
    console.error('Auto-update check failed:', err);
  });
});

app.on('will-quit', () => { globalShortcut.unregisterAll(); });
app.on('before-quit', stopBackendServer);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') { stopBackendServer(); app.quit(); } });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createOverlay(); });
