const { app, BrowserWindow, ipcMain, screen, desktopCapturer, Tray, Menu, globalShortcut, session, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const Store = require('electron-store');
const { autoUpdater } = require('electron-updater');
const Sentry = require('@sentry/electron/main');
const { makeSecureStorage } = require('./main/secure-storage');
const { loadPolicyConfig } = require('./main/policy-config');

if (process.env.SENTRY_DSN) {
  Sentry.init({ dsn: process.env.SENTRY_DSN });
}
const secureStorage = makeSecureStorage(safeStorage);

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

let overlayWindow = null;
let tray = null;

function createOverlay() {
  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;
  const settings = store.get('settings');

  // Default position: centered vertically, offset slightly right
  const savedX = store.get('overlayX');
  const savedY = store.get('overlayY');
  const defaultW = store.get('overlayWidth') || 420;
  const defaultH = store.get('overlayHeight') || 750;
  // Auto-center if saved position is off-screen or in corner
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
    alwaysOnTop: settings.alwaysOnTop,
    resizable: true,
    skipTaskbar: true,
    hasShadow: false,
    minWidth: 360,
    minHeight: 500,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload', 'index.js'),
    },
  });

  overlayWindow.loadFile(path.join(__dirname, 'overlay.html'));
  overlayWindow.setVisibleOnAllWorkspaces(true);

  // Save position on move
  overlayWindow.on('move', () => {
    const [x, y] = overlayWindow.getPosition();
    store.set('overlayX', x);
    store.set('overlayY', y);
  });

  // Save size on resize - but only if not in bubble mode
  overlayWindow.on('resize', () => {
    if (!store.get('isBubbleMode', false)) {
      const [width, height] = overlayWindow.getSize();
      store.set('overlayWidth', width);
      store.set('overlayHeight', height);
    }
  });
}

function createTray() {
  tray = new Tray(path.join(__dirname, '..', 'assets', 'icon.png'));
  const settings = store.get('settings');
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show Overlay', click: () => overlayWindow && overlayWindow.show() },
    { label: 'Hide Overlay', click: () => overlayWindow && overlayWindow.hide() },
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

// IPC handlers
ipcMain.handle('get-settings', () => store.get('settings'));
ipcMain.handle('set-settings', (e, newSettings) => {
  const currentSettings = store.get('settings');
  const updatedSettings = { ...currentSettings, ...newSettings };
  store.set('settings', updatedSettings);
  return true;
});

// Oracle HCM REST API proxy — bypasses CORS by making requests from main process
ipcMain.handle('oracle-api', async (e, { url, user, pass }) => {
  return new Promise((resolve, reject) => {
    const auth = 'Basic ' + Buffer.from(user + ':' + pass).toString('base64');
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    const req = transport.get({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      headers: {
        Authorization: auth,
        Accept: 'application/json',
      },
      timeout: 15000,
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          resolve({ ok: false, status: res.statusCode, statusText: res.statusMessage, body: body.slice(0, 500) });
        } else {
          try {
            resolve({ ok: true, status: res.statusCode, data: JSON.parse(body) });
          } catch {
            resolve({ ok: false, status: res.statusCode, statusText: 'Invalid JSON', body: body.slice(0, 500) });
          }
        }
      });
    });
    req.on('error', (err) => {
      resolve({ ok: false, status: 0, statusText: err.message, body: '' });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, status: 0, statusText: 'Request timed out (15s)', body: '' });
    });
  });
});

ipcMain.handle('capture-screen', async () => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1920, height: 1080 }
    });
    if (sources.length > 0) {
      return sources[0].thumbnail.toDataURL();
    }
  } catch (err) {
    console.error('Screen capture failed:', err);
  }
  return null;
});

ipcMain.handle('get-window-sources', async () => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 1920, height: 1080 }
    });
    return sources.map(s => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() }));
  } catch (err) {
    console.error('Window capture failed:', err);
    return [];
  }
});

ipcMain.handle('capture-window', async (e, windowId) => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 1920, height: 1080 }
    });
    const source = sources.find(s => s.id === windowId);
    if (source) {
      return source.thumbnail.toDataURL();
    }
  } catch (err) {
    console.error('Window capture failed:', err);
  }
  return null;
});

ipcMain.on('close-overlay', () => {
  if (overlayWindow) overlayWindow.hide();
});

ipcMain.handle('set-overlay-size', (e, { width, height }) => {
  console.log('set-overlay-size called with:', width, height);
  if (overlayWindow) {
    overlayWindow.setSize(width, height);
    return true;
  }
  return false;
});

ipcMain.handle('get-overlay-position', () => {
  if (overlayWindow) {
    const [x, y] = overlayWindow.getPosition();
    return { x, y };
  }
  return null;
});

ipcMain.handle('set-overlay-position', (e, { x, y }) => {
  console.log('set-overlay-position called with:', x, y);
  if (overlayWindow) {
    overlayWindow.setPosition(x, y);
    return true;
  }
  return false;
});

ipcMain.handle('clear-bubble-mode', () => {
  store.set('isBubbleMode', false);
  return true;
});

ipcMain.handle('move-overlay-to-corner', () => {
  if (overlayWindow) {
    // Save current size to store before resizing
    const [currentWidth, currentHeight] = overlayWindow.getSize();
    store.set('overlayWidth', currentWidth);
    store.set('overlayHeight', currentHeight);
    
    // Save current position
    const [currentX, currentY] = overlayWindow.getPosition();
    store.set('overlayX', currentX);
    store.set('overlayY', currentY);
    
    // Set bubble mode flag to prevent resize handler from overwriting
    store.set('isBubbleMode', true);
    
    // Move to corner and resize for bubble
    const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;
    const bubbleX = screenW - 100;
    const bubbleY = screenH - 100;
    overlayWindow.setPosition(bubbleX, bubbleY);
    overlayWindow.setSize(80, 80);
    
    return true;
  }
  return false;
});

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

const { loginWithSso, getAuthState, logout } = require('./main/auth');
ipcMain.handle('login-with-sso', (e, { backendUrl, tenantId }) => loginWithSso(backendUrl, tenantId));
ipcMain.handle('get-auth-state', () => getAuthState());
ipcMain.handle('logout', () => logout());

const ALLOWED_UI_KEYS = ['isBubbleMode', 'isCollapsed', 'overlayWidth', 'overlayHeight', 'overlayX', 'overlayY'];
ipcMain.handle('get-ui-state', (e, key) => ALLOWED_UI_KEYS.includes(key) ? store.get(key) : null);
ipcMain.handle('set-ui-state', (e, { key, value }) => {
  if (!ALLOWED_UI_KEYS.includes(key)) return false;
  store.set(key, value);
  return true;
});

app.whenReady().then(() => {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': ["default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' http://localhost:* https://localhost:* http://127.0.0.1:* https://*"],
      },
    });
  });

  const policy = loadPolicyConfig((p, enc) => fs.readFileSync(p, enc), process.platform);
  if (policy) {
    const settings = store.get('settings');
    store.set('settings', { ...settings, ...policy });
  }

  createOverlay();
  createTray();

  // Register global shortcut to toggle overlay
  globalShortcut.register('CommandOrControl+Shift+S', () => {
    if (overlayWindow.isVisible()) overlayWindow.hide();
    else overlayWindow.show();
  });

  autoUpdater.checkForUpdatesAndNotify().catch((err) => {
    console.error('Auto-update check failed:', err);
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  // Keep running in tray
});
