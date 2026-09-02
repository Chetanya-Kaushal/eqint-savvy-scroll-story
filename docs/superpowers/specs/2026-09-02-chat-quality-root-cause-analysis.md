# Chat Quality Root-Cause Analysis

**Status:** Investigation complete — verified against the actual current codebase (not assumptions)
**Date:** 2026-09-02
**Method:** Read `src/renderer/index.js` (1478 lines), `src/main.js`, `src/preload/index.js` in full; ran a live Node test of the actual URL-encoding behavior; grepped for every referenced IPC channel to confirm it's actually registered.

## Important note before the findings

This investigation is against the **real current state** of the repo, which has diverged substantially from the code discussed earlier in this conversation. The file that used to be a simple `src/overlay.js` is now `src/renderer/index.js` at 1478 lines, with a 97-endpoint `HCM_ENDPOINTS` table, person-number resolution, HTML formatters, and an access-control layer — none of which existed when the earlier Phase 0–4 / visual-design / agentic-retrieval plans in this conversation were written. **Those earlier plans target code paths and function names that no longer exist in this form** (e.g., `callOracleApi`, `autoFetchData`'s old single-branch shape). They are not wrong in intent, but they need to be re-targeted against the current file before opencode applies them — treat that as a prerequisite, not an assumption.

## Verified findings

### Finding A (new, most severe): the LLM is never called when any data is found

**Evidence:** [src/renderer/index.js:726-739](../../../src/renderer/index.js)
```javascript
if (htmlSections) {
  ...
  container.appendChild(dataDiv);
  ...
  conversationHistory.push({ role: 'bot', content: '[Data displayed in formatted list]', timestamp: Date.now() });
  try { await window.savvy.invoke('set-conversation-history', ...); } catch {}
  return;   // <-- callLLM is never reached
}

const botMsg = addMessage('', 'bot');
let fullText = '';
const reply = await callLLM(messages, ...);   // only reached when htmlSections is EMPTY
```

`htmlSections` is built from any `__HTML__`-prefixed line in `fetchedData.text`, which [fetchDataForPerson](../../../src/renderer/index.js:322-360) emits for **every endpoint that returns ≥1 record**. So the instant any Oracle endpoint matches with data — which is the common case — the code shows a generic name-only card (`formatItemAsHTML`/`HTML_FORMATTERS`) and returns *before ever calling `callLLM`*. The "send full raw data to LLM for accurate answers" fix (commit `2a78b35`) is real code that's simply unreachable for any query where data was actually found.

**This is the direct explanation for issue #4** ("What is the department of person number NM1658" never gets answered) — the app isn't answering wrong, it's not answering *at all*; it shows a name card and stops. It also explains why "no conversation memory" (issue #5) feels broken even mid-session: the bot's own conversation-history entry for these turns is the literal string `'[Data displayed in formatted list]'`, not the actual data — so a follow-up like "what about their department?" has nothing useful in history to resolve "their" against, independent of the persistence bug in Finding C below.

### Finding B (new): one endpoint's 401/403 discards every other endpoint's already-fetched data

**Evidence:** [src/renderer/index.js:333-343](../../../src/renderer/index.js)
```javascript
for (const ep of endpoints) {
  ...
  if (!result.ok) {
    if (result.status === 401) {
      return { type: 'access-denied', text: '...' };   // aborts the WHOLE function
    }
    if (result.status === 403) {
      return { type: 'access-denied', text: '...' };   // aborts the WHOLE function
    }
    ...
  }
  results.push(...)  // successful results from earlier endpoints in this same loop
}
```

`fetchDataForPerson` loops over every matched endpoint (a single query like "employee payroll info" can match both `Workers` and `Payroll Relationships`). If endpoint #1 succeeds and endpoint #2 comes back 403 (the Oracle account has no payroll-view privilege — common and expected for most users), the function `return`s immediately with `access-denied`, throwing away endpoint #1's already-successful results. **This is exactly issue #6** ("terminal shows Oracle returning data successfully, but chat displays Access denied") — the terminal log is from the *successful* endpoint; the visible "Access denied" is from a *different* endpoint in the same batch that the user's Oracle role simply isn't authorized for.

### Finding C (confirms issue #5, with the real root cause): conversation-history persistence is completely broken

**Evidence:**
- [src/renderer/index.js:45](../../../src/renderer/index.js) calls `window.savvy.invoke('get-conversation-history')`
- [src/renderer/index.js:737](../../../src/renderer/index.js) and [:753](../../../src/renderer/index.js) call `window.savvy.invoke('set-conversation-history', ...)`
- [src/preload/index.js](../../../src/preload/index.js) exposes **no `invoke` method at all** — only specific named methods (`getSettings`, `oracleApi`, `getUiState`, etc.)
- `grep -n "ipcMain\.\(handle\|on\)" src/main.js` returns **no `get-conversation-history` or `set-conversation-history` handler** anywhere in the file

`window.savvy.invoke` is `undefined`. Every call throws `TypeError: window.savvy.invoke is not a function`, synchronously, before any IPC round-trip. Both call sites are wrapped in bare `try { } catch {}`, so this fails silently on every single app start and every single message. Net effect: `conversationHistory` is always `[]` on startup, and nothing ever persists across a restart — the multi-turn-memory commit (`352057b`) added code that calls a bridge method that was never actually added to the preload script. (Within a single session, `conversationHistory.push(...)` at [:751-752](../../../src/renderer/index.js) still works in memory, so short-term recall isn't *totally* dead — but combined with Finding A, most of what gets pushed as the "bot" turn is the placeholder string, not real content.)

### Finding D (confirms issue #3, with the real root cause): the name-fallback has no priority order

**Evidence:** [src/renderer/index.js:463-468](../../../src/renderer/index.js)
```javascript
const keys = Object.keys(item).filter(k => !k.startsWith('_') && typeof item[k] !== 'object');
if (keys.length === 0) return ...;
const labelKey = keys.find(k => /person.?number|name|id|code|title/i.test(k)) || keys[0];
```

`.find()` returns the *first* key (in the object's natural key order, which for a JSON API response is whatever order Oracle serialized the fields in) that matches *any* alternative in the regex. Oracle's `/workers?onlyData=true` response very commonly puts `PersonId` earlier in the field order than `DisplayName` — and `PersonId` matches the `id` alternative just as validly as `DisplayName` matches the `name` alternative. There's no actual priority between "name" and "id" in this regex; it's first-match-wins by field order, not best-match-wins by semantic preference. When `DisplayName` genuinely isn't present in the payload (as the user's own diagnosis already established for the `?onlyData=true` mode), this fallback frequently picks `PersonId` — a raw numeric ID — and displays it as the label, exactly matching the reported symptom.

### Finding E (new): reference/lookup endpoints get an invalid `PersonNumber` filter appended

**Evidence:** [src/renderer/index.js:326-329](../../../src/renderer/index.js)
```javascript
let url = ... + ep.path + ep.params;
if (person && ep.path !== '/absenceTypesLOV') {
  url += '&q=PersonNumber=\'' + encodeURIComponent(person.personNumber) + '\'';
}
```

Only `/absenceTypesLOV` is excluded from the automatic `PersonNumber` filter — every other matched endpoint gets it, including reference/lookup resources that have no `PersonNumber` attribute at all: `Organizations`, `Locations`, `Jobs`, `Grades`, `Positions`, `Business Units`, `Countries`, `Legal Employers`, `Job Families`, and a dozen other `*LOV`/reference endpoints in `HCM_ENDPOINTS`. Oracle Fusion's ADF BC REST layer commonly **silently ignores** a filter on an attribute a resource doesn't recognize (rather than erroring) for exactly these kinds of lookup/reference view objects — which means a query like "what is person NM1658's department" that also keyword-matches `Organizations` (because "department" is one of its keywords) fetches the **entire unfiltered Organizations list**, not anything scoped to the person. **This is the precise mechanism behind issue #4's reported symptom** ("shows a list of all organizations instead of the specific person's department").

The deeper design problem underneath this: "what department is person X in" isn't actually an Organizations-list question at all — `DepartmentName` is already a field on the `/workers` record for that person (visible in `FORMATTERS['/workers']` at [:398](../../../src/renderer/index.js)). The `HCM_ENDPOINTS` keyword table has no way to distinguish "the user wants to browse the Organizations reference list" from "the user wants a specific person's department attribute" — both currently trigger the same `Organizations` endpoint fetch.

### Finding F (new, previously unreported): the person-selection button handler crashes

**Evidence:** [src/renderer/index.js:641-648](../../../src/renderer/index.js)
```javascript
const llmText = result.text.split('\n').filter(l => !l.startsWith('__HTML__')).join('\n');
const botMsg = addMessage('', 'bot');
const sysPrompt2 = '...';
const recentHist2 = conversationHistory.slice(-10).map(...);
const reply = await callLLM([...], (chunk) => {
  botMsg.querySelector('.msg-text').innerHTML = formatMarkdown(fullText);   // <-- fullText
  ...
});
```

`fullText` is never declared inside this click handler. `sendMessage()` (the enclosing function) does declare `let fullText = '';`, but only at [:742](../../../src/renderer/index.js) — *after* the `choose-person` branch's `return` at [:655](../../../src/renderer/index.js). Because that `return` fires before the `let fullText` statement ever executes, the closure captures a `fullText` binding that is permanently stuck in the temporal dead zone for that invocation. When a user is shown a "found N matching employees, please select one" prompt (a real, reachable path — the person-name-search branch at [:304-311](../../../src/renderer/index.js) triggers it whenever a name search finds more than one match) and clicks a button, this callback throws `ReferenceError: Cannot access 'fullText' before initialization` inside an unguarded async event handler — the streaming response silently never renders. This is a distinct, previously undiagnosed bug: multi-match person selection is currently broken.

## Verified as already correct — no action needed

- **Oracle query quoting** (issue #2): confirmed via direct test that `new URL(...)`'s `.search` accessor automatically percent-encodes the raw apostrophes in `q=PersonNumber='NM290'` into `q=PersonNumber=%27NM290%27` before the request goes out in [src/main.js:131-145](../../../src/main.js). This is exactly correct for Oracle's ADF BC query syntax. No further work needed here.
- **Alphanumeric person-number matching** (issue #1): confirmed the current regex chain at [src/renderer/index.js:243-245](../../../src/renderer/index.js) correctly matches `NM290`-style IDs, and `fetchDataForPerson` applies the resolved person's filter to `/workers` (not skipped). Structurally fixed; agrees with the "needs real-world testing" status — nothing further to change in code.
- **Absence over-matching** (issue #7): the `/absences` endpoint's keyword list ([:774](../../../src/renderer/index.js)) is already narrow (all genuinely absence-related terms), and the explicit-mention guard at [:220-224](../../../src/renderer/index.js) is redundant-but-harmless. No evidence of an ongoing problem.
- **Name-only display default** (issue #8): confirmed working as intended by `HTML_FORMATTERS`/`formatItemAsHTML` — though see Finding A: this is currently the *only* thing the user ever sees for a data-bearing query, which is the actual complaint, not the name-only rendering itself.

## Minor cleanup (not a behavioral bug)

`getModuleInfo()` ([src/renderer/index.js:115-123](../../../src/renderer/index.js)) is dead code — it's never called anywhere, and the `hcmModules` object it reads from ([:20](../../../src/renderer/index.js)) is declared but never populated. Safe to delete; not contributing to any reported symptom.

## Real-time data note

Per the request to keep this centered on real-time Oracle data: nothing in these findings involves stale caching. `discoveryData` (the 5-minute auto-refresh snapshot) is only ever consulted as a last-resort fallback when zero endpoints keyword-match a query ([:227-228](../../../src/renderer/index.js)) — every person-specific or endpoint-matched query already goes live through `window.savvy.oracleApi` on each call. The fix plan below preserves this; none of the fixes introduce caching of person-level data.
