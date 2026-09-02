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
