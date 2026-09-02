# Chat Quality Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the six verified root causes behind "stupid" chat responses — conversation history that never actually persists, a person-selection crash, a name-display fallback with no real priority order, an invalid `PersonNumber` filter applied to reference/lookup endpoints, one endpoint's 403 discarding an entire batch of otherwise-successful data, and — the most severe — the LLM never being invoked at all whenever any structured Oracle data comes back.

**Architecture:** All fixes are inside the existing `src/renderer/index.js` / `src/main.js` / `src/preload/index.js`, plus three small new pure-logic modules (`name-resolver.js`, `endpoint-scoping.js`, `access-control.js`) extracted for unit testability, following the same small-module pattern already used for `hcm-discovery.js` and `model-check.js` in this file.

**Tech Stack:** No new dependencies — `vitest` and `@playwright/test` are already installed and configured (`npm run test:unit`, `npm run test:e2e`).

**Spec:** [docs/superpowers/specs/2026-09-02-chat-quality-root-cause-analysis.md](../specs/2026-09-02-chat-quality-root-cause-analysis.md)

## Global Constraints

- No new IPC surface may be a generic passthrough (e.g., `invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args)`). Every method added to `src/preload/index.js` must be specific and named, matching the existing pattern — a generic passthrough would let the renderer invoke *any* IPC channel, defeating the `contextIsolation`/minimal-attack-surface design already in place. This is the correct fix for the missing `window.savvy.invoke`, not a shortcut around it.
- All Oracle data fetches remain live (no new caching of person-level data) — the fixes in this plan only change *how* fetched data is scoped, filtered, and routed to the LLM, never *when* it's fetched.
- Apply tasks in the order below — Task 6 (always call the LLM) depends on Tasks 3 and 4 (correct data scoping/access-handling) having already landed, so the data it feeds the LLM is trustworthy.

---

### Task 1: Fix conversation-history persistence (Finding C)

**Files:**
- Modify: `src/main.js` (add two named IPC handlers)
- Modify: `src/preload/index.js` (expose two named methods)
- Modify: `src/renderer/index.js` (`loadInitialState`, both save-history call sites)

**Interfaces:**
- Produces: `window.savvy.getConversationHistory(): Promise<Array>`, `window.savvy.saveConversationHistory(history: Array): Promise<boolean>` — Task 6 uses `saveConversationHistory` for the fixed choose-person flow's history save too.

- [ ] **Step 1: Add the IPC handlers in `src/main.js`**

```javascript
ipcMain.handle('get-conversation-history', () => {
  return store.get('conversationHistory', []);
});
ipcMain.handle('set-conversation-history', (e, history) => {
  store.set('conversationHistory', history);
  return true;
});
```

- [ ] **Step 2: Expose them in `src/preload/index.js`**

Add to the `contextBridge.exposeInMainWorld('savvy', { ... })` object:
```javascript
  getConversationHistory: () => ipcRenderer.invoke('get-conversation-history'),
  saveConversationHistory: (history) => ipcRenderer.invoke('set-conversation-history', history),
```

- [ ] **Step 3: Fix `loadInitialState` in `src/renderer/index.js`**

Replace:
```javascript
  try {
    conversationHistory = JSON.parse(await window.savvy.invoke('get-conversation-history') || '[]');
  } catch { conversationHistory = []; }
```
with:
```javascript
  try {
    conversationHistory = await window.savvy.getConversationHistory() || [];
  } catch { conversationHistory = []; }
```

(The IPC bridge already structured-clones arrays/objects — the old `JSON.parse`/`JSON.stringify` round-trip was a symptom of the mismatched generic-invoke assumption, not a requirement.)

- [ ] **Step 4: Fix both save-history call sites in `src/renderer/index.js`**

Replace both occurrences of:
```javascript
try { await window.savvy.invoke('set-conversation-history', JSON.stringify(conversationHistory.slice(-100))); } catch {}
```
with:
```javascript
try { await window.savvy.saveConversationHistory(conversationHistory.slice(-100)); } catch {}
```

- [ ] **Step 5: Manual verification**

This touches the real Electron `electron-store` persistence layer end-to-end, which isn't practically unit-testable without a full Electron harness. Verify manually: send a message, close and relaunch the app, confirm the prior turn appears in the chat history on startup (the existing `DOMContentLoaded` replay loop at [src/renderer/index.js:1466-1477](../../../src/renderer/index.js) already re-renders whatever `conversationHistory` loads with).

- [ ] **Step 6: Commit**

```bash
git add src/main.js src/preload/index.js src/renderer/index.js
git commit -m "fix: replace non-existent window.savvy.invoke with named conversation-history IPC methods"
```

---

### Task 2: Fix the person-selection crash (Finding F)

**Files:**
- Modify: `src/renderer/index.js` (choose-person button click handler)

**Interfaces:** none new.

- [ ] **Step 1: Rename the shadowed variable and add the missing history save**

Replace the button click handler body (currently [src/renderer/index.js:615-654](../../../src/renderer/index.js)):
```javascript
      btn.addEventListener('click', async () => {
        const pn = btn.dataset.pn;
        const name = btn.dataset.name;
        const eps = JSON.parse(btn.dataset.eps);
        btn.disabled = true;
        btn.style.opacity = '0.5';
        const epDefs = eps.map(p => HCM_ENDPOINTS.find(e => e.path === p)).filter(Boolean);
        const person = { personNumber: pn, displayName: name };
        const result = await fetchDataForPerson(person, epDefs);
        if (result.type === 'data' && result.text) {
          // Show the data
          const htmlLines = result.text.split('\n').filter(l => l.startsWith('__HTML__'));
          let html = '';
          for (const line of htmlLines) {
            const parts = line.split('__');
            try {
              const items = JSON.parse(parts.slice(5).join('__'));
              html += buildFormattedList(parts[2], parts[3], items);
            } catch {}
          }
          if (html) {
            const dataDiv = document.createElement('div');
            dataDiv.className = 'msg bot';
            dataDiv.innerHTML = `<div class="msg-avatar">EQ</div><div class="msg-text">${html}</div>`;
            container.appendChild(dataDiv);
          }
          const llmText = result.text.split('\n').filter(l => !l.startsWith('__HTML__')).join('\n');
          const botMsg = addMessage('', 'bot');
          const sysPrompt2 = 'You are Savvy, an Oracle Fusion HCM assistant. Use the full data provided to answer. Always show person names, never raw IDs. Be brief.';
          const recentHist2 = conversationHistory.slice(-10).map(h => ({ role: h.role === 'bot' ? 'assistant' : 'user', content: h.content }));
          const reply = await callLLM([{ role: 'system', content: sysPrompt2 }, ...recentHist2, { role: 'user', content: llmText }], (chunk) => {
            botMsg.querySelector('.msg-text').innerHTML = formatMarkdown(fullText);
            document.getElementById('messages').scrollTop = document.getElementById('messages').scrollHeight;
          });
        } else if (result.type === 'no-data') {
          addMessage(result.text, 'bot');
        }
        container.scrollTop = container.scrollHeight;
      });
```
with:
```javascript
      btn.addEventListener('click', async () => {
        const pn = btn.dataset.pn;
        const name = btn.dataset.name;
        const eps = JSON.parse(btn.dataset.eps);
        btn.disabled = true;
        btn.style.opacity = '0.5';
        const epDefs = eps.map(p => HCM_ENDPOINTS.find(e => e.path === p)).filter(Boolean);
        const person = { personNumber: pn, displayName: name };
        const result = await fetchDataForPerson(person, epDefs);
        if (result.type === 'data' && result.text) {
          // Show the data
          const htmlLines = result.text.split('\n').filter(l => l.startsWith('__HTML__'));
          let html = '';
          for (const line of htmlLines) {
            const parts = line.split('__');
            try {
              const items = JSON.parse(parts.slice(5).join('__'));
              html += buildFormattedList(parts[2], parts[3], items);
            } catch {}
          }
          if (html) {
            const dataDiv = document.createElement('div');
            dataDiv.className = 'msg bot';
            dataDiv.innerHTML = `<div class="msg-avatar">EQ</div><div class="msg-text">${html}</div>`;
            container.appendChild(dataDiv);
          }
          const llmText = result.text.split('\n').filter(l => !l.startsWith('__HTML__')).join('\n');
          const botMsg = addMessage('', 'bot');
          const sysPrompt2 = 'You are Savvy, an Oracle Fusion HCM assistant. Use the full data provided to answer. Always show person names, never raw IDs. Be brief.';
          const recentHist2 = conversationHistory.slice(-10).map(h => ({ role: h.role === 'bot' ? 'assistant' : 'user', content: h.content }));
          let selectionText = '';
          const reply = await callLLM([{ role: 'system', content: sysPrompt2 }, ...recentHist2, { role: 'user', content: llmText }], (chunk) => {
            selectionText += chunk;
            botMsg.querySelector('.msg-text').innerHTML = formatMarkdown(selectionText);
            document.getElementById('messages').scrollTop = document.getElementById('messages').scrollHeight;
          });
          conversationHistory.push({ role: 'user', content: `Selected: ${name} (#${pn})`, timestamp: Date.now() });
          conversationHistory.push({ role: 'bot', content: selectionText || reply, timestamp: Date.now() });
          try { await window.savvy.saveConversationHistory(conversationHistory.slice(-100)); } catch {}
        } else if (result.type === 'no-data') {
          addMessage(result.text, 'bot');
        }
        container.scrollTop = container.scrollHeight;
      });
```

- [ ] **Step 2: Manual verification**

Ask a question naming a common first name likely to match multiple employees (e.g., "what is John's department") to trigger the multi-match selection UI, click one of the resulting buttons, and confirm the response streams in without a console error (previously: `ReferenceError: Cannot access 'fullText' before initialization`).

- [ ] **Step 3: Commit**

```bash
git add src/renderer/index.js
git commit -m "fix: resolve ReferenceError crash in person-selection handler, persist its conversation turn"
```

---

### Task 3: Fix the name-display fallback priority (Finding D)

**Files:**
- Create: `src/renderer/name-resolver.js`
- Modify: `src/renderer/index.js` (`formatItemAsHTML`)
- Test: `tests/unit/name-resolver.test.js`

**Interfaces:**
- Produces: `pickDisplayLabel(item: object): string | null` — searches for a genuinely name-like field across *all* keys before ever considering an ID/code/number field, unlike the current first-match-wins regex.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/unit/name-resolver.test.js
const { describe, it, expect } = require('vitest');
const { pickDisplayLabel } = require('../../src/renderer/name-resolver');

describe('pickDisplayLabel', () => {
  it('prefers DisplayName over an earlier-ordered PersonId field', () => {
    const item = { PersonId: '300000009119721', PersonNumber: 'NM1658', DisplayName: 'Jane Smith' };
    expect(pickDisplayLabel(item)).toBe('Jane Smith');
  });

  it('falls back to FirstName + LastName when DisplayName is absent', () => {
    const item = { PersonId: '300000009119721', FirstName: 'Jane', LastName: 'Smith' };
    expect(pickDisplayLabel(item)).toBe('Jane Smith');
  });

  it('only falls back to an ID/code/number field when no name-like field exists at all', () => {
    const item = { PersonId: '300000009119721', AssignmentStatusCode: 'ACTIVE' };
    expect(pickDisplayLabel(item)).toBe('300000009119721');
  });

  it('returns null for an item with no usable fields', () => {
    expect(pickDisplayLabel({ _links: [] })).toBe(null);
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `npm run test:unit`
Expected: FAIL — `src/renderer/name-resolver.js` does not exist.

- [ ] **Step 3: Implement `src/renderer/name-resolver.js`**

```javascript
// src/renderer/name-resolver.js
const NAME_FIELD_PATTERN = /^(display\s?name|full\s?name|employee\s?name|person\s?name|checklist\s?name)$/i;
const FALLBACK_FIELD_PATTERN = /person.?number|id|code|title/i;

function pickDisplayLabel(item) {
  const keys = Object.keys(item).filter((k) => !k.startsWith('_') && typeof item[k] !== 'object' && item[k] !== null && item[k] !== '');

  // Pass 1: a genuinely name-shaped field, checked across every key first.
  const nameKey = keys.find((k) => NAME_FIELD_PATTERN.test(k.replace(/([a-z])([A-Z])/g, '$1 $2')));
  if (nameKey) return String(item[nameKey]);

  // Pass 2: First/Last name pair.
  const firstKey = keys.find((k) => /^first\s?name$/i.test(k.replace(/([a-z])([A-Z])/g, '$1 $2')));
  const lastKey = keys.find((k) => /^last\s?name$/i.test(k.replace(/([a-z])([A-Z])/g, '$1 $2')));
  if (firstKey || lastKey) {
    const combined = `${firstKey ? item[firstKey] : ''} ${lastKey ? item[lastKey] : ''}`.trim();
    if (combined) return combined;
  }

  // Pass 3 (last resort only): an ID/code/number/title field, since no real name field exists.
  const fallbackKey = keys.find((k) => FALLBACK_FIELD_PATTERN.test(k));
  if (fallbackKey) return String(item[fallbackKey]);

  return null;
}

module.exports = { pickDisplayLabel };
```

- [ ] **Step 4: Run and confirm it passes**

Run: `npm run test:unit`
Expected: PASS

- [ ] **Step 5: Wire it into `formatItemAsHTML` in `src/renderer/index.js`**

Replace [src/renderer/index.js:453-469](../../../src/renderer/index.js):
```javascript
function formatItemAsHTML(path, item, idx) {
  const name = item.DisplayName || item.displayName
    || item.Name || item.name
    || item.AbsenceTypeName || item.absenceTypeName
    || item.EmployeeName || item.employeeName
    || item.ChecklistName || item.checklistName
    || item.FullName || item.fullName
    || item.PersonName || item.personName
    || ((item.FirstName || item.firstName || '') + ' ' + (item.LastName || item.lastName || '')).trim();
  if (name) return `<div class="data-row"><span class="data-idx">#${idx}</span><span class="data-field"><b>${escapeHtml(name)}</b></span></div>`;
  // Fallback: try to find any field that looks like an ID or label
  const keys = Object.keys(item).filter(k => !k.startsWith('_') && typeof item[k] !== 'object');
  if (keys.length === 0) return `<div class="data-row"><span class="data-idx">#${idx}</span></div>`;
  // Prefer PersonNumber or any field with "name" or "number" in key
  const labelKey = keys.find(k => /person.?number|name|id|code|title/i.test(k)) || keys[0];
  return `<div class="data-row"><span class="data-idx">#${idx}</span><span class="data-field"><b>${escapeHtml(item[labelKey])}</b></span></div>`;
}
```
with:
```javascript
const { pickDisplayLabel } = require('./name-resolver');

function formatItemAsHTML(path, item, idx) {
  const label = pickDisplayLabel(item) || '—';
  return `<div class="data-row"><span class="data-idx">#${idx}</span><span class="data-field"><b>${escapeHtml(label)}</b></span></div>`;
}
```

Also simplify `HTML_FORMATTERS['/workers']` ([src/renderer/index.js:476-483](../../../src/renderer/index.js)) to use the same helper instead of its own separate ad hoc name logic:
```javascript
  '/workers': (w, idx) => {
    const name = pickDisplayLabel(w) || '?';
    return `<div class="data-row"><span class="data-idx">#${idx}</span><span class="data-field"><b>${escapeHtml(name)}</b></span></div>`;
  },
```

- [ ] **Step 6: Rebuild the renderer bundle and run the unit tests**

Run: `node scripts/build-renderer.js && npm run test:unit`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/renderer/name-resolver.js src/renderer/index.js tests/unit/name-resolver.test.js
git commit -m "fix: prioritize name-like fields over ID/code fields in the display-label fallback"
```

---

### Task 4: Stop filtering reference/lookup endpoints by PersonNumber (Finding E)

**Files:**
- Create: `src/renderer/endpoint-scoping.js`
- Modify: `src/renderer/index.js` (`fetchDataForPerson`, `HCM_ENDPOINTS` entries)
- Test: `tests/unit/endpoint-scoping.test.js`

**Interfaces:**
- Produces: `isPersonScoped(endpointPath: string): boolean`, `scopeEndpointsToPerson(endpoints: {path: string}[]): { personScoped: object[]; referenceOnly: object[] }`. Task 6 uses `referenceOnly` to decide whether to mention "also see general Organizations/Locations/etc. data" versus silently dropping it.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/unit/endpoint-scoping.test.js
const { describe, it, expect } = require('vitest');
const { isPersonScoped, scopeEndpointsToPerson } = require('../../src/renderer/endpoint-scoping');

describe('isPersonScoped', () => {
  it('treats Workers, Absences, and Salaries as person-scoped', () => {
    expect(isPersonScoped('/workers')).toBe(true);
    expect(isPersonScoped('/absences')).toBe(true);
    expect(isPersonScoped('/salaries')).toBe(true);
  });

  it('treats Organizations, Locations, and Jobs as reference-only, not person-scoped', () => {
    expect(isPersonScoped('/organizations')).toBe(false);
    expect(isPersonScoped('/locations')).toBe(false);
    expect(isPersonScoped('/jobs')).toBe(false);
  });
});

describe('scopeEndpointsToPerson', () => {
  it('splits a mixed endpoint list into person-scoped and reference-only groups', () => {
    const endpoints = [{ path: '/workers', name: 'Workers' }, { path: '/organizations', name: 'Organizations' }];
    const { personScoped, referenceOnly } = scopeEndpointsToPerson(endpoints);
    expect(personScoped.map((e) => e.path)).toEqual(['/workers']);
    expect(referenceOnly.map((e) => e.path)).toEqual(['/organizations']);
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `npm run test:unit`
Expected: FAIL — `src/renderer/endpoint-scoping.js` does not exist.

- [ ] **Step 3: Implement `src/renderer/endpoint-scoping.js`**

```javascript
// src/renderer/endpoint-scoping.js
// Endpoints whose Oracle view object actually carries a PersonNumber/person-identifying
// attribute — safe to filter with `&q=PersonNumber='...'`. Everything else in HCM_ENDPOINTS
// is a reference/lookup table (Organizations, Locations, Jobs, Grades, *LOV endpoints, etc.)
// that has no such attribute — Oracle silently ignores an unrecognized filter attribute on
// many of these lookup view objects and returns the FULL unfiltered table instead of erroring,
// so these must never receive a person filter.
const PERSON_SCOPED_PATHS = new Set([
  '/workers', '/emps', '/publicWorkers', '/personNotes', '/hcmContacts', '/areasOfResponsibility',
  '/absences', '/absenceNoEntitlements',
  '/payrollRelationships', '/elementEntries', '/calculationEntries', '/payAdvances', '/planBalances',
  '/benefitEnrollments', '/benefitEnrollmentOpportunities',
  '/salaries', '/compensationPeerSalaryPercentiles', '/compensationStockProfiles',
  '/timeRecords', '/timeRecordGroups', '/timeAttributes', '/webClockEvents', '/scheduleRequests', '/attendanceViolations',
  '/performanceGoals', '/goalPlanAssignees', '/goalsProgressDetails', '/performanceEvaluations',
  '/talentPersonProfiles', '/talentRatings', '/talentFeedbackSuggestions', '/learnerLearningRecords',
  '/workerJourneys', '/workerJourneyTasks',
  '/recruitingJobApplications', '/recruitingMyJobApplications', '/recruitingCEInterviewScheduleDetails',
  '/documentRecords', '/communicateUIMyCommunications', '/checkInDocuments', '/allocatedChecklists',
  '/tasks', '/businessProcessNotifications', '/businessProcessTransactionManagementAsWorkers', '/statusChangeRequests',
  '/internetAccounts', '/userAccounts', '/emailAddrMigrations', '/documentDeliveryPreferences', '/careerInterests',
]);

function isPersonScoped(path) {
  return PERSON_SCOPED_PATHS.has(path);
}

function scopeEndpointsToPerson(endpoints) {
  const personScoped = endpoints.filter((ep) => isPersonScoped(ep.path));
  const referenceOnly = endpoints.filter((ep) => !isPersonScoped(ep.path));
  return { personScoped, referenceOnly };
}

module.exports = { isPersonScoped, scopeEndpointsToPerson, PERSON_SCOPED_PATHS };
```

- [ ] **Step 4: Run and confirm it passes**

Run: `npm run test:unit`
Expected: PASS

- [ ] **Step 5: Wire it into `fetchDataForPerson` in `src/renderer/index.js`**

Replace the top of `fetchDataForPerson` ([src/renderer/index.js:322-329](../../../src/renderer/index.js)):
```javascript
async function fetchDataForPerson(person, endpoints) {
  const results = [];
  for (const ep of endpoints) {
    try {
      let url = settings.oracleUrl.replace(/\/+$/, '') + '/hcmRestApi/resources/11.13.18.05' + ep.path + ep.params;
      if (person && ep.path !== '/absenceTypesLOV') {
        url += '&q=PersonNumber=\'' + encodeURIComponent(person.personNumber) + '\'';
      }
```
with:
```javascript
const { isPersonScoped } = require('./endpoint-scoping');

async function fetchDataForPerson(person, endpoints) {
  const results = [];
  const scopedEndpoints = person ? endpoints.filter((ep) => isPersonScoped(ep.path)) : endpoints;
  for (const ep of scopedEndpoints) {
    try {
      let url = settings.oracleUrl.replace(/\/+$/, '') + '/hcmRestApi/resources/11.13.18.05' + ep.path + ep.params;
      if (person) {
        url += '&q=PersonNumber=\'' + encodeURIComponent(person.personNumber) + '\'';
      }
```

(When a specific person is resolved, non-person-scoped reference endpoints — like `Organizations` matched only because "department" is one of its keywords — are dropped from this batch entirely rather than fetched unfiltered. The person's own `/workers` record already carries `DepartmentName`/`JobName`/`LocationName` as denormalized fields, which is what answers "what is X's department" correctly.)

- [ ] **Step 6: Rebuild and run the full unit suite**

Run: `node scripts/build-renderer.js && npm run test:unit`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/renderer/endpoint-scoping.js src/renderer/index.js tests/unit/endpoint-scoping.test.js
git commit -m "fix: never apply a PersonNumber filter to reference/lookup Oracle endpoints"
```

---

### Task 5: Stop one endpoint's 403 from discarding an entire batch (Finding B)

**Files:**
- Create: `src/renderer/access-control.js`
- Modify: `src/renderer/index.js` (`fetchDataForPerson`'s error handling)
- Test: `tests/unit/access-control.test.js`

**Interfaces:**
- Produces: `classifyOracleError(status: number): 'hard-stop' | 'soft-skip'` — 401 (bad credentials — nothing else will work either) hard-stops the whole batch as before; 403 (this specific resource forbidden for this user's Oracle role) now only skips that one endpoint and continues.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/unit/access-control.test.js
const { describe, it, expect } = require('vitest');
const { classifyOracleError } = require('../../src/renderer/access-control');

describe('classifyOracleError', () => {
  it('classifies 401 (authentication failure) as hard-stop', () => {
    expect(classifyOracleError(401)).toBe('hard-stop');
  });

  it('classifies 403 (forbidden for this resource) as soft-skip', () => {
    expect(classifyOracleError(403)).toBe('soft-skip');
  });

  it('classifies any other error status as soft-skip (recorded, batch continues)', () => {
    expect(classifyOracleError(404)).toBe('soft-skip');
    expect(classifyOracleError(500)).toBe('soft-skip');
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `npm run test:unit`
Expected: FAIL — `src/renderer/access-control.js` does not exist.

- [ ] **Step 3: Implement `src/renderer/access-control.js`**

```javascript
// src/renderer/access-control.js
function classifyOracleError(status) {
  return status === 401 ? 'hard-stop' : 'soft-skip';
}

module.exports = { classifyOracleError };
```

- [ ] **Step 4: Run and confirm it passes**

Run: `npm run test:unit`
Expected: PASS

- [ ] **Step 5: Wire it into `fetchDataForPerson`'s error handling in `src/renderer/index.js`**

Replace [src/renderer/index.js:331-343](../../../src/renderer/index.js):
```javascript
      const result = await window.savvy.oracleApi(url, settings.oracleUser, settings.oraclePass);
      console.log('[Renderer] Result:', ep.name, 'ok=' + result.ok, 'status=' + result.status, 'items=' + (result.data?.items?.length || 0));
      if (!result.ok) {
        // Strict access control — show clear error, no fallback
        if (result.status === 401) {
          return { type: 'access-denied', text: 'Authentication failed. Please check your Oracle credentials in Settings.' };
        }
        if (result.status === 403) {
          const who = person ? ' for ' + person.displayName : '';
          return { type: 'access-denied', text: 'Access denied. You do not have permission to view ' + ep.name.toLowerCase() + who + '. Contact your Oracle administrator.' };
        }
        throw new Error('HTTP ' + result.status + ' ' + (result.statusText || '') + (result.body ? ' — ' + result.body.slice(0, 200) : ''));
      }
```
with:
```javascript
const { classifyOracleError } = require('./access-control');

      const result = await window.savvy.oracleApi(url, settings.oracleUser, settings.oraclePass);
      console.log('[Renderer] Result:', ep.name, 'ok=' + result.ok, 'status=' + result.status, 'items=' + (result.data?.items?.length || 0));
      if (!result.ok) {
        if (classifyOracleError(result.status) === 'hard-stop') {
          return { type: 'access-denied', text: 'Authentication failed. Please check your Oracle credentials in Settings.' };
        }
        // soft-skip: record and move on to the next endpoint rather than discarding
        // everything already fetched in this batch.
        const who = person ? ' for ' + person.displayName : '';
        const reason = result.status === 403
          ? 'You do not have permission to view ' + ep.name.toLowerCase() + who + '.'
          : 'HTTP ' + result.status + ' ' + (result.statusText || '');
        results.push(`[NO ACCESS — ${ep.name}] ${reason}`);
        continue;
      }
```

(`require('./access-control')` should be added once near the top of the file alongside the other `require`s, not repeated inside the function — shown here in the diff location for clarity.)

- [ ] **Step 6: Rebuild and run the full unit suite**

Run: `node scripts/build-renderer.js && npm run test:unit`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/renderer/access-control.js src/renderer/index.js tests/unit/access-control.test.js
git commit -m "fix: a single endpoint's 403 no longer discards an entire batch of successful results"
```

---

### Task 6: Always invoke the LLM with the full data (Finding A — capstone fix)

**Files:**
- Modify: `src/renderer/index.js` (`sendMessage`)

**Interfaces:** none new — consumes the corrected data from Tasks 4 and 5, and the fixed persistence from Task 1.

- [ ] **Step 1: Remove the early-return shortcut in `sendMessage`**

Replace [src/renderer/index.js:726-753](../../../src/renderer/index.js):
```javascript
  // Show HTML data sections first if available
  const container = document.getElementById('messages');
  if (htmlSections) {
    const dataDiv = document.createElement('div');
    dataDiv.className = 'msg bot';
    dataDiv.innerHTML = `<div class="msg-avatar">EQ</div><div class="msg-text">${htmlSections}</div>`;
    container.appendChild(dataDiv);
    container.scrollTop = container.scrollHeight;
    // Data already shown — skip LLM call
    conversationHistory.push({ role: 'user', content: msg, timestamp: Date.now() });
    conversationHistory.push({ role: 'bot', content: '[Data displayed in formatted list]', timestamp: Date.now() });
    try { await window.savvy.invoke('set-conversation-history', JSON.stringify(conversationHistory.slice(-100))); } catch {}
    return;
  }

  const botMsg = addMessage('', 'bot');
  let fullText = '';

  const reply = await callLLM(messages, (chunk) => {
    fullText += chunk;
    botMsg.querySelector('.msg-text').innerHTML = formatMarkdown(fullText);
    document.getElementById('messages').scrollTop = document.getElementById('messages').scrollHeight;
  });

  // Save to conversation history
  conversationHistory.push({ role: 'user', content: msg, timestamp: Date.now() });
  conversationHistory.push({ role: 'bot', content: fullText || reply, timestamp: Date.now() });
  try { await window.savvy.invoke('set-conversation-history', JSON.stringify(conversationHistory.slice(-100))); } catch {}
```
with:
```javascript
  // Show the formatted data card first (if any) — but always continue on to ask the
  // LLM to answer the user's specific question using the full data already folded
  // into `fullMsg` above. Showing a name card is not the same as answering "what is
  // their department" — the LLM call is what actually answers the question asked.
  const container = document.getElementById('messages');
  if (htmlSections) {
    const dataDiv = document.createElement('div');
    dataDiv.className = 'msg bot';
    dataDiv.innerHTML = `<div class="msg-avatar">EQ</div><div class="msg-text">${htmlSections}</div>`;
    container.appendChild(dataDiv);
    container.scrollTop = container.scrollHeight;
  }

  const botMsg = addMessage('', 'bot');
  let fullText = '';

  const reply = await callLLM(messages, (chunk) => {
    fullText += chunk;
    botMsg.querySelector('.msg-text').innerHTML = formatMarkdown(fullText);
    document.getElementById('messages').scrollTop = document.getElementById('messages').scrollHeight;
  });

  // Save to conversation history — the real answer, not a placeholder
  conversationHistory.push({ role: 'user', content: msg, timestamp: Date.now() });
  conversationHistory.push({ role: 'bot', content: fullText || reply, timestamp: Date.now() });
  try { await window.savvy.saveConversationHistory(conversationHistory.slice(-100)); } catch {}
```

- [ ] **Step 2: Manual verification (this is the end-to-end behavior the whole plan exists to fix)**

Against a real Oracle instance and Ollama running locally: ask "What is the department of person number NM1658" (or an equivalent real person-number in your test tenant). Confirm: (a) a name card appears, (b) a *second* bot message appears below it giving a specific, data-grounded answer naming the actual department, (c) asking a follow-up like "what about their job title?" correctly resolves "their" using conversation history now that the bot's saved turn contains the real answer text rather than a placeholder.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/index.js
git commit -m "fix: always invoke the LLM to answer the specific question, not just show a data card"
```

---

## Self-Review Notes

- **Root-cause coverage**: every finding in the spec (A–F) has a corresponding task; the four items verified as already-correct (Oracle query quoting, alphanumeric person-number matching, absence over-matching, name-only display default) require no task, per the spec's explicit "no action needed" section.
- **Task ordering justification**: Task 6 (the capstone "always call the LLM" fix) is deliberately last — it depends on Task 4's endpoint scoping (so the LLM isn't fed a bogus full-Organizations-list dump) and Task 5's soft-skip access handling (so one forbidden endpoint doesn't still abort everything before the LLM is ever reached). Applying Task 6 first, before those data-correctness fixes, would just make the LLM's answers wrong in a *new* way rather than fixing the "no answer at all" problem correctly.
- **Type/interface consistency**: `pickDisplayLabel` (Task 3) is used identically in both call sites that previously had separate, inconsistent name-detection logic (`formatItemAsHTML` and `HTML_FORMATTERS['/workers']`) — consolidating them was necessary for the fix to be complete, not optional cleanup.
- **Preserved constraint**: no task introduces caching of person-level data — Task 4's endpoint-scoping change affects *which* endpoints are fetched, not whether results get cached; every fetch remains live per the spec's real-time-data note.
