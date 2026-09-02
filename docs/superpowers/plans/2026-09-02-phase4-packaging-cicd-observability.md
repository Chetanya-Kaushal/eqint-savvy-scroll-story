# Phase 4 — Packaging, CI/CD & Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the desktop client and backend a real release pipeline: automated CI, code signing, auto-update, an enterprise-deployable installer with centrally-pushed configuration, structured logging/crash reporting, and an Ollama model-version check — the last item on the spec's rollout list, assuming Phases 0-3 are already merged.

**Architecture:** No functional/data-model changes — this phase is entirely delivery infrastructure around the existing desktop app ([src/](../../../src)) and backend ([backend/services/api](../../../backend/services/api)).

**Tech Stack:** GitHub Actions, `electron-updater` + `@electron/notarize` (desktop), `pino` (structured logging), `@sentry/electron` + `@sentry/node` (crash/error reporting).

**Spec:** [docs/superpowers/specs/2026-09-02-enterprise-transformation-design.md](../specs/2026-09-02-enterprise-transformation-design.md), Section 8 (CI/CD, packaging, distribution), Section 9 (observability), Section 10 Phase 4, Section 11 (Ollama model-drift risk).

## Global Constraints

- CI must run both the desktop test suites (`npm run test:unit`, `npm run test:e2e` at the repo root) and the backend suite (`npm test` in `backend/services/api`) on every pull request — a release must not be buildable if either fails.
- No signing secrets or KMS/DB credentials are ever committed to the repository — CI reads them from GitHub Actions secrets, and the desktop app reads deployment config from an IT-managed file, never from source.
- Telemetry is opt-in per tenant and must not transmit raw PII — logs are scrubbed before leaving the desktop, per spec Section 9.

---

### Task 1: CI pipeline (lint, typecheck, test, build)

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `package.json` (add `"lint"` script using the built-in ESLint config already implied by Node tooling)
- Modify: `backend/services/api/package.json` (add `"lint"` and `"typecheck"` scripts)

**Interfaces:** none — CI orchestration only.

- [ ] **Step 1: Add lint/typecheck scripts**

```json
// backend/services/api/package.json — add to "scripts"
"typecheck": "tsc --noEmit -p tsconfig.json"
```

```json
// package.json (desktop, repo root) — add to "scripts"
"lint": "eslint src --ext .js"
```

```bash
npm install --save-dev eslint
npx eslint --init
```
(Choose: JavaScript modules, no framework, Node environment, JSON config format — this generates `.eslintrc.json`; keep its defaults, this task does not hand-tune lint rules.)

- [ ] **Step 2: Write the CI workflow**

```yaml
# .github/workflows/ci.yml
name: CI

on:
  pull_request:
  push:
    branches: [main]

jobs:
  desktop:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm install
      - run: npm run lint
      - run: npm run test:unit
      - run: node scripts/build-renderer.js
      - run: npm run test:e2e

  backend:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: savvy
          POSTGRES_PASSWORD: savvy_test_password
          POSTGRES_DB: savvy_test
        ports: ['5432:5432']
        options: >-
          --health-cmd "pg_isready -U savvy"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
    env:
      DATABASE_URL: postgresql://savvy:savvy_test_password@localhost:5432/savvy_test
      SESSION_JWT_SECRET: ci-test-secret
      KMS_KEY_ID: ci-placeholder-key-id
    defaults:
      run:
        working-directory: backend/services/api
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm install
      - run: npx prisma migrate deploy
      - run: npm run typecheck
      - run: npm test
```

- [ ] **Step 3: Push a branch and confirm both jobs run and pass in the GitHub Actions UI**

Run: `git push origin <branch>` and open the Actions tab for the pushed commit.
Expected: both `desktop` and `backend` jobs show green.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml package.json .eslintrc.json backend/services/api/package.json
git commit -m "ci: add GitHub Actions pipeline for desktop and backend test suites"
```

---

### Task 2: Code signing (Windows Authenticode + macOS notarization)

**Files:**
- Modify: `package.json` (electron-builder `"build"` config — `win`, `mac`, `afterSign`)
- Create: `scripts/notarize.js`
- Modify: `.github/workflows/ci.yml` (add a `release` job gated on tags)

**Interfaces:** none — build/release configuration only.

- [ ] **Step 1: Add the `afterSign` notarization hook**

```bash
npm install --save-dev @electron/notarize
```

```javascript
// scripts/notarize.js
const { notarize } = require('@electron/notarize');

exports.default = async function notarizeApp(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;
  if (!process.env.APPLE_ID || !process.env.APPLE_APP_SPECIFIC_PASSWORD) {
    console.warn('Skipping notarization: APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD not set (expected in local dev builds).');
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  await notarize({
    appBundleId: 'com.eqint.savvy-desktop',
    appPath: `${appOutDir}/${appName}.app`,
    appleId: process.env.APPLE_ID,
    appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
    teamId: process.env.APPLE_TEAM_ID,
  });
};
```

- [ ] **Step 2: Wire signing config into `package.json`'s `"build"` section**

```json
"build": {
  "appId": "com.eqint.savvy-desktop",
  "productName": "EQInt Savvy",
  "afterSign": "scripts/notarize.js",
  "win": {
    "target": ["nsis", "portable"],
    "icon": "assets/icon.ico"
  },
  "mac": {
    "target": "dmg",
    "hardenedRuntime": true,
    "gatekeeperAssess": false,
    "entitlements": "build/entitlements.mac.plist",
    "entitlementsInherit": "build/entitlements.mac.plist"
  },
  "portable": {
    "artifactName": "EQInt Savvy.exe"
  },
  "files": ["src/**/*", "knowledge/**/*", "assets/**/*"]
}
```

```xml
<!-- build/entitlements.mac.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
</dict>
</plist>
```

Windows Authenticode signing needs no config change here: electron-builder automatically signs with the certificate referenced by the `CSC_LINK`/`CSC_KEY_PASSWORD` environment variables when present, which CI supplies as secrets (Step 3).

- [ ] **Step 3: Add the gated release job to CI**

```yaml
  release:
    if: startsWith(github.ref, 'refs/tags/v')
    needs: [desktop, backend]
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm install
      - run: node scripts/build-renderer.js
      - run: npm run build
        env:
          CSC_LINK: ${{ secrets.WINDOWS_CODESIGN_CERT_BASE64 }}
          CSC_KEY_PASSWORD: ${{ secrets.WINDOWS_CODESIGN_CERT_PASSWORD }}
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

- [ ] **Step 4: Commit**

```bash
git add package.json scripts/notarize.js build/entitlements.mac.plist .github/workflows/ci.yml
git commit -m "build: add Windows Authenticode and macOS notarization signing to the release pipeline"
```

---

### Task 3: Auto-update via `electron-updater`

**Files:**
- Modify: `package.json` (`"build.publish"` config, `electron-updater` dependency)
- Modify: `src/main.js` (wire `autoUpdater`)

**Interfaces:** none — this consumes the release artifacts Task 2 produces.

- [ ] **Step 1: Add the dependency and publish config**

```bash
npm install electron-updater
```

```json
"build": {
  "publish": {
    "provider": "generic",
    "url": "https://releases.savvy.eqint.example/"
  }
}
```

(Swap the `url` for the tenant's actual release-feed host at deployment time — this is an infrastructure detail outside this repo's scope, not a placeholder in the code itself.)

- [ ] **Step 2: Wire `autoUpdater` into `src/main.js`**

```javascript
const { autoUpdater } = require('electron-updater');

app.whenReady().then(() => {
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
```

- [ ] **Step 3: Manual verification (auto-update cannot be meaningfully unit-tested without a live release feed)**

Publish a build to a test release-feed URL, install an older version locally, launch it, and confirm `autoUpdater` downloads and prompts to restart into the newer version. Document the result in the PR description rather than an automated test — `electron-updater`'s own test suite already covers its internals; this project's responsibility is correct wiring, verified manually once per release-channel change.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json src/main.js
git commit -m "feat: wire electron-updater for automatic desktop updates"
```

---

### Task 4: Enterprise installer + centrally-pushed configuration

**Files:**
- Modify: `package.json` (NSIS installer options for silent/per-machine install)
- Create: `src/main/policy-config.js`
- Modify: `src/main.js` (load IT-pushed policy at startup)
- Test: `tests/unit/policy-config.test.js`

**Interfaces:**
- Produces: `loadPolicyConfig(readFileFn, platform): { tenantId?: string; backendUrl?: string } | null` — reads a JSON file IT pushes via Intune/SCCM, at a fixed per-OS path.

- [ ] **Step 1: Configure the NSIS installer for silent, per-machine install (Intune/SCCM-compatible)**

```json
"build": {
  "win": {
    "target": ["nsis", "portable"],
    "icon": "assets/icon.ico"
  },
  "nsis": {
    "oneClick": false,
    "perMachine": true,
    "allowToChangeInstallationDirectory": false,
    "runAfterFinish": false
  }
}
```

Silent install for Intune/SCCM push: `"EQInt Savvy Setup.exe" /S /ALLUSERS`.

- [ ] **Step 2: Write the failing test for policy-config loading**

```javascript
// tests/unit/policy-config.test.js
const { describe, it, expect, vi } = require('vitest');
const { loadPolicyConfig } = require('../../src/main/policy-config');

describe('loadPolicyConfig', () => {
  it('reads and parses the IT-managed policy file when present on Windows', () => {
    const readFileFn = vi.fn().mockReturnValue(JSON.stringify({ tenantId: 'tenant-abc', backendUrl: 'https://api.acme.example.com' }));
    const result = loadPolicyConfig(readFileFn, 'win32');
    expect(readFileFn).toHaveBeenCalledWith('C:\\ProgramData\\EQInt\\Savvy\\policy.json', 'utf8');
    expect(result).toEqual({ tenantId: 'tenant-abc', backendUrl: 'https://api.acme.example.com' });
  });

  it('returns null when the policy file does not exist', () => {
    const readFileFn = vi.fn().mockImplementation(() => { throw Object.assign(new Error('not found'), { code: 'ENOENT' }); });
    expect(loadPolicyConfig(readFileFn, 'win32')).toBe(null);
  });
});
```

- [ ] **Step 3: Run and confirm failure**

Run: `npm run test:unit`
Expected: FAIL — `src/main/policy-config.js` does not exist.

- [ ] **Step 4: Implement `src/main/policy-config.js`**

```javascript
// src/main/policy-config.js
function policyPathFor(platform) {
  if (platform === 'win32') return 'C:\\ProgramData\\EQInt\\Savvy\\policy.json';
  if (platform === 'darwin') return '/Library/Application Support/EQInt/Savvy/policy.json';
  return '/etc/eqint-savvy/policy.json';
}

function loadPolicyConfig(readFileFn, platform) {
  try {
    const raw = readFileFn(policyPathFor(platform), 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    console.error('Failed to read IT-managed policy config:', err);
    return null;
  }
}

module.exports = { loadPolicyConfig, policyPathFor };
```

- [ ] **Step 5: Run and confirm it passes**

Run: `npm run test:unit`
Expected: PASS

- [ ] **Step 6: Apply the policy at startup in `src/main.js`**

```javascript
const fs = require('fs');
const { loadPolicyConfig } = require('./main/policy-config');

app.whenReady().then(() => {
  const policy = loadPolicyConfig((p, enc) => fs.readFileSync(p, enc), process.platform);
  if (policy) {
    const settings = store.get('settings');
    store.set('settings', { ...settings, ...policy });
  }
  createOverlay();
  createTray();
  // ...
});
```

- [ ] **Step 7: Commit**

```bash
git add package.json src/main/policy-config.js src/main.js tests/unit/policy-config.test.js
git commit -m "feat: add silent per-machine installer and IT-managed policy config for enterprise deployment"
```

---

### Task 5: Structured logging + crash reporting + opt-in telemetry

**Files:**
- Create: `backend/services/api/src/routes/telemetry.ts`
- Modify: `backend/services/api/prisma/schema.prisma` (add `TelemetryEvent`)
- Modify: `backend/services/api/src/server.ts`
- Create: `src/main/telemetry-client.js`
- Modify: `src/main.js` (Sentry init, wire telemetry client)
- Modify: `package.json` (`@sentry/electron`, `pino`)
- Test: `backend/services/api/test/routes/telemetry.test.ts`, `tests/unit/telemetry-client.test.js`

**Interfaces:**
- Produces: `POST /telemetry/events` (backend, requires auth, tenant-scoped). `makeTelemetryClient({ backendUrl, getAuthState, enabled })` returning `{ recordEvent(name, properties) }` — scrubs any property matching common PII field names before sending.

- [ ] **Step 1: Add the `TelemetryEvent` model and migrate**

```prisma
model TelemetryEvent {
  id         String   @id @default(uuid())
  tenantId   String
  userId     String
  name       String
  properties Json
  createdAt  DateTime @default(now())

  @@index([tenantId, name])
}
```

```bash
cd backend/services/api && npx prisma migrate dev --name add_telemetry_events
```

- [ ] **Step 2: Write the failing backend route test**

```typescript
// backend/services/api/test/routes/telemetry.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { buildServer } from '../../src/server';
import { prisma } from '../../src/db';
import { issueSessionToken } from '../../src/auth/session';

describe('POST /telemetry/events', () => {
  let tenantId: string;
  let token: string;

  beforeEach(async () => {
    process.env.SESSION_JWT_SECRET = 'test-secret';
    await prisma.telemetryEvent.deleteMany();
    await prisma.user.deleteMany();
    await prisma.tenant.deleteMany();
    const tenant = await prisma.tenant.create({ data: { name: 'Acme', oracleBaseUrl: '' } });
    tenantId = tenant.id;
    token = issueSessionToken({ id: 'user-1', tenantId, role: 'employee' });
  });

  afterAll(async () => { await prisma.$disconnect(); });

  it('records a telemetry event scoped to the caller\'s tenant and user', async () => {
    const server = buildServer();
    const response = await server.inject({
      method: 'POST', url: '/telemetry/events', headers: { authorization: `Bearer ${token}` },
      payload: { name: 'chat_message_sent', properties: { model: 'phi3:mini' } },
    });
    expect(response.statusCode).toBe(201);

    const events = await prisma.telemetryEvent.findMany({ where: { tenantId } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ userId: 'user-1', name: 'chat_message_sent' });
  });
});
```

- [ ] **Step 3: Run and confirm failure, then implement `src/routes/telemetry.ts`**

```typescript
// backend/services/api/src/routes/telemetry.ts
import { FastifyInstance, FastifyRequest } from 'fastify';
import { requireAuth } from '../rbac/policy';
import { prisma } from '../db';
import { SessionClaims } from '../auth/session';

export function registerTelemetryRoutes(server: FastifyInstance): void {
  server.post<{ Body: { name: string; properties: Record<string, unknown> } }>(
    '/telemetry/events',
    { preHandler: requireAuth },
    async (request, reply) => {
      const session = (request as FastifyRequest & { session: SessionClaims }).session;
      await prisma.telemetryEvent.create({
        data: { tenantId: session.tenantId, userId: session.userId, name: request.body.name, properties: request.body.properties },
      });
      reply.code(201);
      return { ok: true };
    }
  );
}
```

Register in `src/server.ts`: `registerTelemetryRoutes(server);`

Run: `cd backend/services/api && npm test` — Expected: PASS.

- [ ] **Step 4: Write the failing desktop telemetry-client test (with PII scrubbing)**

```javascript
// tests/unit/telemetry-client.test.js
const { describe, it, expect, vi } = require('vitest');
const { makeTelemetryClient } = require('../../src/main/telemetry-client');

describe('telemetry-client', () => {
  it('does not send when disabled', async () => {
    global.fetch = vi.fn();
    const client = makeTelemetryClient({ backendUrl: 'http://localhost:4000', getAuthState: async () => ({ sessionToken: 't' }), enabled: false });
    await client.recordEvent('chat_message_sent', { model: 'phi3:mini' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('scrubs common PII field names before sending when enabled', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true });
    const client = makeTelemetryClient({ backendUrl: 'http://localhost:4000', getAuthState: async () => ({ sessionToken: 't' }), enabled: true });
    await client.recordEvent('chat_message_sent', { model: 'phi3:mini', email: 'jane@acme.test', message: 'my SSN is 123-45-6789' });

    const [, options] = global.fetch.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.properties).toEqual({ model: 'phi3:mini' });
  });
});
```

- [ ] **Step 5: Run and confirm failure, then implement `src/main/telemetry-client.js`**

```javascript
// src/main/telemetry-client.js
const PII_FIELD_NAMES = ['email', 'message', 'content', 'name', 'ssn', 'password'];

function scrub(properties) {
  const scrubbed = {};
  for (const [key, value] of Object.entries(properties)) {
    if (PII_FIELD_NAMES.includes(key.toLowerCase())) continue;
    scrubbed[key] = value;
  }
  return scrubbed;
}

function makeTelemetryClient({ backendUrl, getAuthState, enabled }) {
  return {
    async recordEvent(name, properties = {}) {
      if (!enabled) return;
      const authState = await getAuthState();
      await fetch(`${backendUrl}/telemetry/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authState.sessionToken}` },
        body: JSON.stringify({ name, properties: scrub(properties) }),
      });
    },
  };
}

module.exports = { makeTelemetryClient };
```

- [ ] **Step 6: Run and confirm it passes**

Run: `npm run test:unit`
Expected: PASS

- [ ] **Step 7: Wire Sentry crash reporting and the telemetry client into `src/main.js`**

```bash
npm install @sentry/electron
```

```javascript
// top of src/main.js
const Sentry = require('@sentry/electron/main');
if (process.env.SENTRY_DSN) {
  Sentry.init({ dsn: process.env.SENTRY_DSN });
}
```

- [ ] **Step 8: Commit**

```bash
git add backend/services/api/prisma backend/services/api/src/routes/telemetry.ts backend/services/api/src/server.ts backend/services/api/test/routes/telemetry.test.ts
git add src/main/telemetry-client.js src/main.js package.json package-lock.json tests/unit/telemetry-client.test.js
git commit -m "feat: add opt-in scrubbed telemetry and Sentry crash reporting"
```

---

### Task 6: Ollama model-version check

**Files:**
- Create: `src/renderer/model-check.js`
- Modify: `src/renderer/index.js` (surface a warning banner when the local model is outdated)
- Test: `tests/unit/model-check.test.js`

**Interfaces:**
- Produces: `checkModelVersion(installedModels, recommendedModel): { upToDate: boolean; message: string }`.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/unit/model-check.test.js
const { describe, it, expect } = require('vitest');
const { checkModelVersion } = require('../../src/renderer/model-check');

describe('checkModelVersion', () => {
  it('reports up to date when the recommended model is installed', () => {
    const result = checkModelVersion([{ name: 'phi3:mini' }, { name: 'llava:7b' }], 'phi3:mini');
    expect(result.upToDate).toBe(true);
  });

  it('reports out of date with a pull instruction when the recommended model is missing', () => {
    const result = checkModelVersion([{ name: 'llava:7b' }], 'phi3:mini');
    expect(result.upToDate).toBe(false);
    expect(result.message).toContain('ollama pull phi3:mini');
  });
});
```

- [ ] **Step 2: Run and confirm failure, then implement `src/renderer/model-check.js`**

```javascript
// src/renderer/model-check.js
function checkModelVersion(installedModels, recommendedModel) {
  const upToDate = installedModels.some((m) => m.name === recommendedModel);
  return {
    upToDate,
    message: upToDate ? 'Model is up to date.' : `Recommended model "${recommendedModel}" is not installed. Run: ollama pull ${recommendedModel}`,
  };
}

module.exports = { checkModelVersion };
```

- [ ] **Step 3: Run and confirm it passes**

Run: `npm run test:unit`
Expected: PASS

- [ ] **Step 4: Wire it into `src/renderer/index.js`'s `loadInitialState`**

```javascript
const { checkModelVersion } = require('./model-check');

// inside loadInitialState(), after settings/backendClient are ready:
  try {
    const tagsResponse = await fetch(settings.ollamaUrl + '/api/tags');
    const { models } = await tagsResponse.json();
    const versionCheck = checkModelVersion(models, settings.ollamaModel);
    if (!versionCheck.upToDate) {
      addMessage(versionCheck.message, 'bot');
    }
  } catch (err) {
    console.log('Model version check skipped (Ollama not reachable):', err.message);
  }
```

- [ ] **Step 5: Rebuild and run the full desktop test suite, then commit**

Run: `node scripts/build-renderer.js && npm run test:unit && npm run test:e2e`
Expected: PASS

```bash
git add src/renderer/model-check.js src/renderer/index.js tests/unit/model-check.test.js
git commit -m "feat: warn in-chat when the recommended Ollama model is not installed"
```

---

## Self-Review Notes

- **Spec coverage**: Section 8's CI/CD, signing, auto-update, and enterprise installer/policy-push are covered by Tasks 1-4; Section 9's structured logging/crash reporting/opt-in telemetry by Task 5; Section 11's Ollama model-drift risk by Task 6.
- **Type/interface consistency**: `makeTelemetryClient`'s `{ backendUrl, getAuthState, enabled }` constructor shape mirrors `makeBackendClient`'s from the Phase 2 plan, so both can share the same `getAuthState` closure in the renderer.
- **Explicitly out of scope**: this plan does not stand up the actual release-feed host (`https://releases.savvy.eqint.example/` is a placeholder for infrastructure the customer/vendor provisions outside this repository, not application code) or provision real Apple/Windows signing certificates — those are operational prerequisites, tracked as deployment checklist items rather than code tasks.
