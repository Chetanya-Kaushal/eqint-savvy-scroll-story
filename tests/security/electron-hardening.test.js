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
