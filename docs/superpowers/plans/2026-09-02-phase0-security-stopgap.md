# Phase 0 — Electron Security Stopgap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the existing Electron app (renderer isolation, CSP, at-rest encryption) with no dependency on the future backend — the highest-severity, lowest-effort fix from the enterprise transformation spec.

**Architecture:** No architectural change — this phase hardens the current single-process/renderer split in place. It adds a `preload` script as the only bridge between renderer and Node/Electron APIs, moves all file I/O into the main process, and encrypts PII at rest using Electron's OS-backed `safeStorage` API. No backend, no network changes.

**Tech Stack:** Electron 30 (already in use), `@playwright/test` + `playwright` (new — Electron security regression tests), `esbuild` (new — renderer bundling), `vitest` (new — unit tests for pure logic), Electron's built-in `safeStorage` module (no new dependency).

**Spec:** [docs/superpowers/specs/2026-09-02-enterprise-transformation-design.md](../specs/2026-09-02-enterprise-transformation-design.md), Section 10 "Phase 0 — Security stopgap" and Section 6 "Desktop Client Refactor".

## Global Constraints

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` on every `BrowserWindow` — no exceptions.
- The renderer (`src/renderer/**`) must never call `require()` for Node/Electron built-ins directly — all such access goes through `window.savvy.*` exposed by `src/preload/index.js`.
- No PII (HR data, conversation history, credentials) may be written to disk in plaintext once this phase is complete, on platforms where `safeStorage.isEncryptionAvailable()` returns true. Where it returns false, the code must log a visible warning rather than silently writing plaintext.
- Existing IPC channel names in `src/main.js` (`get-settings`, `set-settings`, `capture-screen`, `get-window-sources`, `capture-window`, `close-overlay`, `set-overlay-size`, `get-overlay-position`, `set-overlay-position`, `clear-bubble-mode`, `move-overlay-to-corner`) keep their existing signatures — only new handlers are added in this phase, none are renamed.

---

### Task 1: Playwright Electron test harness + failing security-regression test

**Files:**
- Create: `playwright.config.js`
- Create: `tests/security/electron-hardening.test.js`
- Modify: `package.json` (add `devDependencies` and a `test:e2e` script)

**Interfaces:**
- Produces: a Playwright Electron test harness other phases' e2e tests will extend. Launch pattern: `electron.launch({ args: [path.join(__dirname, '..', '..', 'src', 'main.js')] })`.

- [ ] **Step 1: Add test dependencies**

```bash
npm install --save-dev @playwright/test playwright
```

- [ ] **Step 2: Create the Playwright config**

```javascript
// playwright.config.js
module.exports = {
  testDir: './tests',
  timeout: 30000,
  retries: 0,
  reporter: 'list',
};
```

- [ ] **Step 3: Write the failing test**

```javascript
// tests/security/electron-hardening.test.js
const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const path = require('path');

test('renderer has no direct Node access (contextIsolation + no nodeIntegration)', async () => {
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..', 'src', 'main.js')] });
  const window = await app.firstWindow();

  const hasRequire = await window.evaluate(() => typeof window.require !== 'undefined');
  expect(hasRequire).toBe(false);

  const hasProcess = await window.evaluate(() => typeof window.process !== 'undefined' && typeof window.process.versions?.node !== 'undefined');
  expect(hasProcess).toBe(false);

  await app.close();
});
```

- [ ] **Step 4: Add the test script to package.json**

```json
"scripts": {
  "start": "electron .",
  "build": "electron-builder --win",
  "build:portable": "electron-builder --win portable",
  "test:e2e": "playwright test tests/"
}
```

- [ ] **Step 5: Run the test and confirm it fails**

Run: `npm run test:e2e`
Expected: FAIL — `hasRequire` evaluates to `true` because [src/main.js:41-42](../../../src/main.js) currently sets `nodeIntegration: true, contextIsolation: false`.

- [ ] **Step 6: Commit**

```bash
git add playwright.config.js tests/security/electron-hardening.test.js package.json package-lock.json
git commit -m "test: add failing Electron hardening security-regression test"
```

---

### Task 2: Harden BrowserWindow + introduce the preload bridge

**Files:**
- Modify: `src/main.js:1-2` (add `session` to the electron import), `src/main.js:40-43` (webPreferences)
- Create: `src/preload/index.js`
- Test: `tests/security/electron-hardening.test.js` (from Task 1, now expected to pass)

**Interfaces:**
- Consumes: nothing new.
- Produces: `window.savvy` global in the renderer, with these methods (all thin wrappers around existing IPC channels from [src/main.js:91-203](../../../src/main.js)): `getSettings()`, `setSettings(settings)`, `captureScreen()`, `getWindowSources()`, `captureWindow(windowId)`, `closeOverlay()`, `setOverlaySize({width, height})`, `getOverlayPosition()`, `setOverlayPosition({x, y})`, `clearBubbleMode()`, `moveOverlayToCorner()`. Later tasks in this plan add more methods to this same object — do not create a second bridge.

- [ ] **Step 1: Create the preload script**

```javascript
// src/preload/index.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('savvy', {
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSettings: (settings) => ipcRenderer.invoke('set-settings', settings),
  captureScreen: () => ipcRenderer.invoke('capture-screen'),
  getWindowSources: () => ipcRenderer.invoke('get-window-sources'),
  captureWindow: (windowId) => ipcRenderer.invoke('capture-window', windowId),
  closeOverlay: () => ipcRenderer.send('close-overlay'),
  setOverlaySize: (size) => ipcRenderer.invoke('set-overlay-size', size),
  getOverlayPosition: () => ipcRenderer.invoke('get-overlay-position'),
  setOverlayPosition: (pos) => ipcRenderer.invoke('set-overlay-position', pos),
  clearBubbleMode: () => ipcRenderer.invoke('clear-bubble-mode'),
  moveOverlayToCorner: () => ipcRenderer.invoke('move-overlay-to-corner'),
});
```

- [ ] **Step 2: Harden webPreferences and wire the preload in `src/main.js`**

Change the top import (line 1) from:
```javascript
const { app, BrowserWindow, ipcMain, screen, desktopCapturer, Tray, Menu, globalShortcut } = require('electron');
```
to:
```javascript
const { app, BrowserWindow, ipcMain, screen, desktopCapturer, Tray, Menu, globalShortcut, session } = require('electron');
```

Change the `webPreferences` block (currently `src/main.js:40-43`) from:
```javascript
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
```
to:
```javascript
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload', 'index.js'),
    },
```

- [ ] **Step 3: Run the Task 1 test and confirm it now passes**

Run: `npm run test:e2e`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/main.js src/preload/index.js
git commit -m "fix: enable contextIsolation/sandbox, disable nodeIntegration, add preload bridge"
```

---

### Task 3: Content-Security-Policy + remove inline event handlers

**Files:**
- Modify: `src/main.js` (add CSP header registration inside `app.whenReady()`)
- Modify: `src/overlay.html:326`, `src/overlay.html:433` (remove inline `onerror` attributes)
- Modify: `src/overlay.html:head` (add CSP meta tag as defense-in-depth)
- Test: `tests/security/electron-hardening.test.js` (add a CSP assertion)

**Interfaces:**
- Consumes: `session` import added in Task 2.
- Produces: nothing new consumed by later tasks.

- [ ] **Step 1: Write the failing test addition**

Add to `tests/security/electron-hardening.test.js` (new test in the same file):
```javascript
test('page declares a restrictive Content-Security-Policy', async () => {
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..', 'src', 'main.js')] });
  const window = await app.firstWindow();

  const csp = await window.evaluate(() =>
    document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content || null
  );
  expect(csp).toContain("script-src 'self'");

  await app.close();
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm run test:e2e`
Expected: FAIL — no CSP meta tag exists yet in `src/overlay.html`.

- [ ] **Step 3: Add the CSP meta tag to `src/overlay.html`**

Insert immediately after `<meta charset="utf-8">` (line 4):
```html
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' http://localhost:11434 http://127.0.0.1:11434">
```

- [ ] **Step 4: Add the matching HTTP header in `src/main.js`, inside `app.whenReady().then(() => { ... })` before `createOverlay()`**

```javascript
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': ["default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' http://localhost:11434 http://127.0.0.1:11434"],
      },
    });
  });
```

- [ ] **Step 5: Remove the inline `onerror` handlers (CSP without `'unsafe-inline'` script-src blocks inline event handler attributes)**

In `src/overlay.html:326`, change:
```html
<div class="logo"><img src="../assets/icon.png" alt="EQInt" onerror="this.style.display='none';this.parentNode.innerHTML='<span style=\'font-weight:700;font-size:12px;\'>EQ</span>'" /></div>
```
to:
```html
<div class="logo"><img src="../assets/icon.png" alt="EQInt" class="brand-icon" data-fallback-size="12px" data-fallback-color="inherit" /></div>
```

In `src/overlay.html:433`, change:
```html
<img src="../assets/icon.png" alt="EQInt" onerror="this.style.display='none';this.parentNode.innerHTML='<span style=\'font-weight:700;font-size:16px;color:white;\'>EQ</span>'" />
```
to:
```html
<img src="../assets/icon.png" alt="EQInt" class="brand-icon" data-fallback-size="16px" data-fallback-color="white" />
```

The equivalent behavior moves into `src/renderer/index.js` in Task 4, using `addEventListener('error', ...)` instead of an inline attribute — this task alone leaves the icons broken if the image 404s, which is acceptable since Task 4 (in the same PR sequence) restores the fallback via the bundle.

- [ ] **Step 6: Run the tests and confirm both pass**

Run: `npm run test:e2e`
Expected: PASS (2 tests)

- [ ] **Step 7: Commit**

```bash
git add src/main.js src/overlay.html tests/security/electron-hardening.test.js
git commit -m "fix: add Content-Security-Policy header and meta tag, remove inline event handlers"
```

---

### Task 4: Move file I/O to main process, bundle the renderer with esbuild

**Files:**
- Create: `src/renderer/index.js` (adapted from `src/overlay.js`)
- Create: `src/renderer/hcm-discovery.js` (moved from `src/hcm-discovery.js`, unchanged content)
- Delete: `src/overlay.js`, `src/hcm-discovery.js`
- Modify: `src/main.js` (add new IPC handlers for knowledge base, HCM data, conversation history, and UI state)
- Modify: `src/preload/index.js` (expose the new handlers)
- Modify: `src/overlay.html:442` (script src) and the `<img class="brand-icon">` fallback wiring
- Create: `scripts/build-renderer.js`
- Modify: `package.json` (esbuild devDependency, `prestart`/`start` scripts, `.gitignore` entry for the bundle output)
- Test: `tests/e2e/app-boots.test.js`

**Interfaces:**
- Consumes: `window.savvy.*` from Task 2's preload.
- Produces: `window.savvy.loadKnowledgeBase()`, `window.savvy.loadHcmData()`, `window.savvy.saveHcmData(data)`, `window.savvy.getConversationHistory()`, `window.savvy.saveConversationHistory(history)`, `window.savvy.getUiState(key)`, `window.savvy.setUiState(key, value)` — Task 5 wraps the storage side of these with encryption but does not change these method signatures.

- [ ] **Step 1: Write the failing boot smoke test**

```javascript
// tests/e2e/app-boots.test.js
const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const path = require('path');

test('app boots and renders the chat tab', async () => {
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..', 'src', 'main.js')] });
  const window = await app.firstWindow();
  await window.waitForSelector('#chatInput');
  const chatTabVisible = await window.isVisible('#tab-chat');
  expect(chatTabVisible).toBe(true);
  await app.close();
});
```

- [ ] **Step 2: Run it to confirm current baseline still passes (renderer hasn't moved yet)**

Run: `npm run test:e2e`
Expected: PASS — this is a baseline check before the refactor, not a red step; it protects against regressions in the steps below.

- [ ] **Step 3: Add the new main-process IPC handlers**

Add near the top of `src/main.js` (after the existing `require`s):
```javascript
const fs = require('fs');
```

Add alongside the existing `ipcMain.handle` calls in `src/main.js`:
```javascript
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

ipcMain.handle('load-hcm-data', () => {
  try {
    const dataPath = path.join(__dirname, '..', 'hcm-data.json');
    if (fs.existsSync(dataPath)) return JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  } catch (err) { console.error('Failed to load HCM data:', err); }
  return null;
});

ipcMain.handle('save-hcm-data', (e, data) => {
  try {
    const dataPath = path.join(__dirname, '..', 'hcm-data.json');
    fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));
    return true;
  } catch (err) { console.error('Failed to save HCM data:', err); return false; }
});

ipcMain.handle('get-conversation-history', () => {
  try {
    const historyPath = path.join(__dirname, '..', 'conversation-history.json');
    if (fs.existsSync(historyPath)) return JSON.parse(fs.readFileSync(historyPath, 'utf8'));
  } catch (err) { console.error('Failed to load conversation history:', err); }
  return [];
});

ipcMain.handle('save-conversation-history', (e, history) => {
  try {
    const historyPath = path.join(__dirname, '..', 'conversation-history.json');
    const trimmed = history.slice(-50);
    fs.writeFileSync(historyPath, JSON.stringify(trimmed, null, 2));
    return true;
  } catch (err) { console.error('Failed to save conversation history:', err); return false; }
});

const ALLOWED_UI_KEYS = ['isBubbleMode', 'isCollapsed', 'overlayWidth', 'overlayHeight', 'overlayX', 'overlayY'];
ipcMain.handle('get-ui-state', (e, key) => ALLOWED_UI_KEYS.includes(key) ? store.get(key) : null);
ipcMain.handle('set-ui-state', (e, { key, value }) => {
  if (!ALLOWED_UI_KEYS.includes(key)) return false;
  store.set(key, value);
  return true;
});
```

- [ ] **Step 4: Expose the new handlers in `src/preload/index.js`**

Add to the `contextBridge.exposeInMainWorld('savvy', { ... })` object:
```javascript
  loadKnowledgeBase: () => ipcRenderer.invoke('load-knowledge-base'),
  loadHcmData: () => ipcRenderer.invoke('load-hcm-data'),
  saveHcmData: (data) => ipcRenderer.invoke('save-hcm-data', data),
  getConversationHistory: () => ipcRenderer.invoke('get-conversation-history'),
  saveConversationHistory: (history) => ipcRenderer.invoke('save-conversation-history', history),
  getUiState: (key) => ipcRenderer.invoke('get-ui-state', key),
  setUiState: (key, value) => ipcRenderer.invoke('set-ui-state', key, value),
```

- [ ] **Step 5: Move `src/hcm-discovery.js` to `src/renderer/hcm-discovery.js` unchanged**

```bash
mkdir -p src/renderer
git mv src/hcm-discovery.js src/renderer/hcm-discovery.js
```

No content changes — it has no Node dependencies (only `fetch`/`URL`), so it bundles into the renderer as-is via esbuild.

- [ ] **Step 6: Create `src/renderer/index.js` from `src/overlay.js`, replacing all direct Node/Electron/Store access with `window.savvy` calls**

```bash
git mv src/overlay.js src/renderer/index.js
```

Then apply these replacements inside `src/renderer/index.js`:

Replace the top of the file (former lines 1-20):
```javascript
const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');
const Store = require('electron-store');
const { HCMDiscovery } = require('./hcm-discovery');

const store = new Store();
let settings = store.get('settings', {
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: 'phi3:mini',
  oracleUrl: '',
  oracleUser: '',
  oraclePass: '',
  alwaysOnTop: true,
});

let hcmDiscovery = null;
let hcmData = null;
let knowledgeBase = [];
let conversationHistory = [];
```
with:
```javascript
const { HCMDiscovery } = require('./hcm-discovery');

let settings = {
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: 'phi3:mini',
  oracleUrl: '',
  oracleUser: '',
  oraclePass: '',
  alwaysOnTop: true,
};

let hcmDiscovery = null;
let hcmData = null;
let hcmApis = null;
let knowledgeBase = [];
let conversationHistory = [];

async function loadInitialState() {
  settings = await window.savvy.getSettings();
  const kb = await window.savvy.loadKnowledgeBase();
  hcmApis = kb.hcmApis;
  knowledgeBase = kb.knowledgeBase;
  hcmData = await window.savvy.loadHcmData();
  if (hcmData) hcmDiscovery = new HCMDiscovery(settings);
  conversationHistory = await window.savvy.getConversationHistory();
}
```

Remove the old `loadHcmApis()` function (former lines 23-32) and its call site — it's replaced by `loadInitialState()` above. Remove the old top-level `try { ... }` blocks that loaded `hcm-data.json`, `knowledge/hcm.json`, and `conversation-history.json` synchronously (former lines 54-77) — same reason.

Replace `saveConversationHistory` (former lines 79-86):
```javascript
function saveConversationHistory() {
  try {
    const historyPath = path.join(__dirname, '..', 'conversation-history.json');
    const trimmedHistory = conversationHistory.slice(-50);
    fs.writeFileSync(historyPath, JSON.stringify(trimmedHistory, null, 2));
  } catch(e) { console.log('Failed to save conversation history:', e); }
}
```
with:
```javascript
async function saveConversationHistory() {
  await window.savvy.saveConversationHistory(conversationHistory);
}
```

Replace the `runDiscovery` function's HCM data cache write (former lines 422-425):
```javascript
    try {
      const dataPath = path.join(__dirname, '..', 'hcm-data.json');
      fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));
    } catch(e) { console.log('Failed to cache HCM data:', e); }
```
with:
```javascript
    await window.savvy.saveHcmData(data);
```

Replace every remaining `ipcRenderer.invoke(...)` / `ipcRenderer.send(...)` call with the matching `window.savvy.*` call (same argument shapes): `ipcRenderer.invoke('get-window-sources')` → `window.savvy.getWindowSources()`, `ipcRenderer.invoke('capture-window', source.id)` → `window.savvy.captureWindow(source.id)`, `ipcRenderer.send('close-overlay')` → `window.savvy.closeOverlay()`, `ipcRenderer.invoke('move-overlay-to-corner')` → `window.savvy.moveOverlayToCorner()`, `ipcRenderer.invoke('clear-bubble-mode')` → `window.savvy.clearBubbleMode()`, `ipcRenderer.invoke('set-overlay-size', restoreSize)` → `window.savvy.setOverlaySize(restoreSize)`, `ipcRenderer.invoke('set-overlay-position', restorePos)` → `window.savvy.setOverlayPosition(restorePos)`.

Replace every `store.get(key, default)` / `store.set(key, value)` call (in `toggleCollapse`, `expandFromBubble`, `loadSettings`) with `await window.savvy.getUiState(key)` / `await window.savvy.setUiState(key, value)` — this makes those three functions `async`; update their call sites to `await` them (the DOMContentLoaded handler already treats them as fire-and-forget button-click callbacks, so mark those callbacks `async` too).

Replace the settings-save handler's `store.set('settings', settings)` with `await window.savvy.setSettings(settings)`.

At the end of the file, replace the `document.addEventListener('DOMContentLoaded', () => { ... })` opening with `document.addEventListener('DOMContentLoaded', async () => { await loadInitialState(); ... })`, keeping the rest of the handler body, and add the `brand-icon` fallback wiring (replacing the inline `onerror` removed in Task 3):
```javascript
  document.querySelectorAll('.brand-icon').forEach(img => {
    img.addEventListener('error', () => {
      img.style.display = 'none';
      const span = document.createElement('span');
      span.style.cssText = `font-weight:700;font-size:${img.dataset.fallbackSize};color:${img.dataset.fallbackColor};`;
      span.textContent = 'EQ';
      img.parentNode.appendChild(span);
    });
  });
```

- [ ] **Step 7: Add the esbuild bundler**

```bash
npm install --save-dev esbuild
```

```javascript
// scripts/build-renderer.js
const esbuild = require('esbuild');

esbuild.buildSync({
  entryPoints: ['src/renderer/index.js'],
  bundle: true,
  outfile: 'src/renderer.bundle.js',
  platform: 'browser',
  target: 'chrome122',
});
console.log('Renderer bundle built: src/renderer.bundle.js');
```

- [ ] **Step 8: Point `src/overlay.html` at the bundle**

Change `src/overlay.html:442` from:
```html
<script src="overlay.js"></script>
```
to:
```html
<script src="renderer.bundle.js"></script>
```

- [ ] **Step 9: Wire the build into `package.json` and ignore the generated bundle**

```json
"scripts": {
  "prestart": "node scripts/build-renderer.js",
  "start": "electron .",
  "build:portable": "electron-builder --win portable",
  "build": "npm run prestart && electron-builder --win",
  "test:e2e": "playwright test tests/"
}
```

Add to `.gitignore`: `src/renderer.bundle.js`

- [ ] **Step 10: Build the renderer and run all tests**

Run: `node scripts/build-renderer.js && npm run test:e2e`
Expected: PASS (all 3 tests: contextIsolation, CSP, app-boots)

- [ ] **Step 11: Commit**

```bash
git add src/renderer src/main.js src/preload/index.js src/overlay.html scripts/build-renderer.js package.json package-lock.json .gitignore tests/e2e/app-boots.test.js
git rm src/overlay.js src/hcm-discovery.js
git commit -m "refactor: move renderer file I/O to main process, bundle renderer with esbuild"
```

---

### Task 5: Encrypt at-rest PII with Electron `safeStorage`

**Files:**
- Create: `src/main/secure-storage.js`
- Create: `tests/unit/secure-storage.test.js`
- Modify: `src/main.js` (wire `secure-storage.js` into the `get-settings`/`set-settings`/`load-hcm-data`/`save-hcm-data`/`get-conversation-history`/`save-conversation-history` handlers added in Task 4)
- Modify: `package.json` (add `vitest` devDependency and `test:unit` script)

**Interfaces:**
- Produces: `makeSecureStorage(safeStorage)` returning `{ writeEncryptedFile(filePath, obj), readEncryptedFile(filePath), encryptField(value), decryptField(value) }`. Phase 3's retention/erasure work reuses this module for any new PII files it introduces — it should not reimplement encryption.

- [ ] **Step 1: Add the unit test dependency**

```bash
npm install --save-dev vitest
```

- [ ] **Step 2: Write the failing unit tests**

```javascript
// tests/unit/secure-storage.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it, expect, beforeEach, afterEach } = require('vitest');
const { makeSecureStorage } = require('../../src/main/secure-storage');

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (str) => Buffer.from(str, 'utf8').reverse(),
    decryptString: (buf) => Buffer.from(buf).reverse().toString('utf8'),
  };
}

describe('secure-storage', () => {
  let tmpFile;
  beforeEach(() => { tmpFile = path.join(os.tmpdir(), `secure-storage-test-${Date.now()}.json`); });
  afterEach(() => { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); });

  it('round-trips an object through writeEncryptedFile/readEncryptedFile', () => {
    const { writeEncryptedFile, readEncryptedFile } = makeSecureStorage(fakeSafeStorage());
    const original = { employees: [{ name: 'Jane Doe', salary: 120000 }] };
    writeEncryptedFile(tmpFile, original);
    expect(readEncryptedFile(tmpFile)).toEqual(original);
  });

  it('never writes plaintext PII to disk when encryption is available', () => {
    const { writeEncryptedFile } = makeSecureStorage(fakeSafeStorage());
    writeEncryptedFile(tmpFile, { employees: [{ name: 'Jane Doe', salary: 120000 }] });
    const raw = fs.readFileSync(tmpFile, 'utf8');
    expect(raw.includes('Jane Doe')).toBe(false);
    expect(raw.includes('120000')).toBe(false);
  });

  it('falls back to plaintext when encryption is unavailable, and readEncryptedFile still round-trips it', () => {
    const unavailable = { ...fakeSafeStorage(), isEncryptionAvailable: () => false };
    const { writeEncryptedFile, readEncryptedFile } = makeSecureStorage(unavailable);
    const original = { employees: [{ name: 'Jane Doe' }] };
    writeEncryptedFile(tmpFile, original);
    expect(readEncryptedFile(tmpFile)).toEqual(original);
  });

  it('encryptField/decryptField round-trip a single string value', () => {
    const { encryptField, decryptField } = makeSecureStorage(fakeSafeStorage());
    const encrypted = encryptField('super-secret-password');
    expect(encrypted).not.toBe('super-secret-password');
    expect(decryptField(encrypted)).toBe('super-secret-password');
  });

  it('readEncryptedFile returns null for a missing file', () => {
    const { readEncryptedFile } = makeSecureStorage(fakeSafeStorage());
    expect(readEncryptedFile(path.join(os.tmpdir(), 'does-not-exist.json'))).toBe(null);
  });
});
```

- [ ] **Step 3: Add the test script and run to confirm failure**

Add to `package.json` scripts: `"test:unit": "vitest run"`

Run: `npm run test:unit`
Expected: FAIL — `src/main/secure-storage.js` does not exist yet.

- [ ] **Step 4: Implement `src/main/secure-storage.js`**

```javascript
// src/main/secure-storage.js
const fs = require('fs');

function makeSecureStorage(safeStorage) {
  function writeEncryptedFile(filePath, obj) {
    const json = JSON.stringify(obj);
    const enc = safeStorage.isEncryptionAvailable();
    if (!enc) console.warn(`OS-level encryption unavailable; writing ${filePath} in plaintext as a fallback.`);
    const payload = enc ? safeStorage.encryptString(json).toString('base64') : json;
    fs.writeFileSync(filePath, JSON.stringify({ enc, payload }));
  }

  function readEncryptedFile(filePath) {
    if (!fs.existsSync(filePath)) return null;
    const wrapper = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!wrapper.enc) return JSON.parse(wrapper.payload);
    return JSON.parse(safeStorage.decryptString(Buffer.from(wrapper.payload, 'base64')));
  }

  function encryptField(value) {
    if (!value) return value;
    if (!safeStorage.isEncryptionAvailable()) {
      console.warn('OS-level encryption unavailable; storing field in plaintext as a fallback.');
      return value;
    }
    return 'enc:' + safeStorage.encryptString(value).toString('base64');
  }

  function decryptField(value) {
    if (!value || !value.startsWith('enc:')) return value || '';
    try {
      return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'));
    } catch (err) {
      console.error('Failed to decrypt stored field:', err);
      return '';
    }
  }

  return { writeEncryptedFile, readEncryptedFile, encryptField, decryptField };
}

module.exports = { makeSecureStorage };
```

- [ ] **Step 5: Run the unit tests and confirm they pass**

Run: `npm run test:unit`
Expected: PASS (5 tests)

- [ ] **Step 6: Wire `secure-storage.js` into `src/main.js`'s handlers**

Add near the top of `src/main.js`:
```javascript
const { safeStorage } = require('electron');
const { makeSecureStorage } = require('./main/secure-storage');
const secureStorage = makeSecureStorage(safeStorage);
```

Replace the `get-settings`/`set-settings` handlers added originally at `src/main.js:91-97` with:
```javascript
ipcMain.handle('get-settings', () => {
  const settings = store.get('settings');
  return { ...settings, oraclePass: secureStorage.decryptField(settings.oraclePass) };
});
ipcMain.handle('set-settings', (e, newSettings) => {
  const currentSettings = store.get('settings');
  const updatedSettings = { ...currentSettings, ...newSettings };
  if (newSettings.oraclePass !== undefined) {
    updatedSettings.oraclePass = secureStorage.encryptField(newSettings.oraclePass);
  }
  store.set('settings', updatedSettings);
  return true;
});
```

Replace the `load-hcm-data`/`save-hcm-data` handlers from Task 4 with:
```javascript
ipcMain.handle('load-hcm-data', () => {
  try {
    return secureStorage.readEncryptedFile(path.join(__dirname, '..', 'hcm-data.json'));
  } catch (err) { console.error('Failed to load HCM data:', err); return null; }
});
ipcMain.handle('save-hcm-data', (e, data) => {
  try {
    secureStorage.writeEncryptedFile(path.join(__dirname, '..', 'hcm-data.json'), data);
    return true;
  } catch (err) { console.error('Failed to save HCM data:', err); return false; }
});
```

Replace the `get-conversation-history`/`save-conversation-history` handlers from Task 4 with:
```javascript
ipcMain.handle('get-conversation-history', () => {
  try {
    return secureStorage.readEncryptedFile(path.join(__dirname, '..', 'conversation-history.json')) || [];
  } catch (err) { console.error('Failed to load conversation history:', err); return []; }
});
ipcMain.handle('save-conversation-history', (e, history) => {
  try {
    secureStorage.writeEncryptedFile(path.join(__dirname, '..', 'conversation-history.json'), history.slice(-50));
    return true;
  } catch (err) { console.error('Failed to save conversation history:', err); return false; }
});
```

- [ ] **Step 7: Delete any pre-existing plaintext PII files from previous runs so they don't linger unencrypted**

```bash
rm -f "hcm-data.json" "conversation-history.json"
```

- [ ] **Step 8: Run the full test suite**

Run: `npm run test:unit && node scripts/build-renderer.js && npm run test:e2e`
Expected: PASS (5 unit tests, 3 e2e tests)

- [ ] **Step 9: Commit**

```bash
git add src/main.js src/main/secure-storage.js tests/unit/secure-storage.test.js package.json package-lock.json
git commit -m "fix: encrypt HR data, conversation history, and Oracle password at rest via safeStorage"
```

---

## Self-Review Notes

- **Spec coverage**: Section 10 Phase 0 items — "Electron hardening" (Tasks 1-3), "stop writing plaintext PII to disk" (Task 5) — both covered. Section 6's preload/contextBridge/CSP/renderer-module-boundary requirements are covered by Tasks 2-4.
- **Type/interface consistency**: `window.savvy.*` method names introduced in Task 2 are reused verbatim in Task 4 and not renamed; `makeSecureStorage`'s returned function names (`writeEncryptedFile`, `readEncryptedFile`, `encryptField`, `decryptField`) are the same names used in both the unit test (Task 5, Step 2) and the wiring (Task 5, Step 6).
- **Out of scope for this phase, by design**: removing Oracle credentials entirely (Phase 2), replacing local Oracle REST calls with the backend client (Phase 1/2), and the `oracleUrl`/`oracleUser`/`oraclePass` fields in `overlay.html`'s Settings tab still exist post-Phase-0 — they're only encrypted at rest here, not removed. Removal happens in the Phase 2 plan once the backend and SSO login exist.
