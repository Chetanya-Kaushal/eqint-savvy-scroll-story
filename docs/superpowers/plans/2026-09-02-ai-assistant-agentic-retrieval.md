# AI Assistant Agentic Retrieval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat, single-keyword `autoFetchData` chat logic with a taxonomy-driven, multi-resource retrieval planner, a bounded one-retry "ask the system for more data" loop, screen-context/live-data priority rules, and an advisory anti-hallucination check — so the assistant fetches whatever Oracle data it needs itself and never states a fact it can't ground.

**Architecture:** Pure renderer-side logic change in `src/renderer/index.js`, plus two new small, independently-testable modules (`oracle-taxonomy.js`, `retrieval.js`). No new IPC channels, no backend changes — everything here calls the `backendClient` interface the Phase 2 plan already established (`fetchPersonData(resourcePath)`, `fetchReferenceData(category)`).

**Tech Stack:** No new dependencies — plain JS, `vitest` (already added by the Phase 0 plan) for unit tests.

**Spec:** [docs/superpowers/specs/2026-09-02-ai-assistant-behavior-design.md](../specs/2026-09-02-ai-assistant-behavior-design.md)

**Depends on:** the Phase 0 plan (renderer at `src/renderer/index.js`, bundled via esbuild) and the Phase 2 plan (`src/renderer/backend-client.js`'s `makeBackendClient`, with `fetchPersonData`/`fetchReferenceData` methods) — this plan modifies code those two plans already put in place. Apply after both.

## Global Constraints

- No fact-bearing keyword/resource mapping lives inline in `sendMessage` anymore — all of it goes through `src/renderer/oracle-taxonomy.js`, so adding a new Oracle module later means adding one taxonomy entry, not touching retrieval logic.
- The retrieval loop allows **at most one** additional LLM call per user message (Section 4 of the spec) — no unbounded loops, ever.
- The system prompt text in this plan's Task 4 is the literal final text from the spec's Section 6 — it is not paraphrased or shortened during implementation.

---

### Task 1: Oracle Fusion taxonomy module

**Files:**
- Create: `src/renderer/oracle-taxonomy.js`
- Test: `tests/unit/oracle-taxonomy.test.js`

**Interfaces:**
- Produces: `ORACLE_TAXONOMY` (array of `{ category, resourcePath, keywords }`), `matchTaxonomy(message: string): { category, resourcePath }[]` — Task 2's planner and Task 3's rewired `sendMessage` both call `matchTaxonomy` by this exact name; do not introduce a second matching function.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/unit/oracle-taxonomy.test.js
const { describe, it, expect } = require('vitest');
const { matchTaxonomy } = require('../../src/renderer/oracle-taxonomy');

describe('matchTaxonomy', () => {
  it('matches a single-category message', () => {
    const matches = matchTaxonomy('Show my absences this month');
    expect(matches).toEqual([{ category: 'absences', resourcePath: '/absences?onlyData=true&limit=10' }]);
  });

  it('matches multiple categories in one message', () => {
    const matches = matchTaxonomy("Compare my team's absences and payroll");
    const categories = matches.map((m) => m.category).sort();
    expect(categories).toEqual(['absences', 'employees', 'payroll']);
  });

  it('matches common synonyms, not just formal Oracle field names', () => {
    expect(matchTaxonomy('How much PTO do I have left?').map((m) => m.category)).toEqual(['absences']);
    expect(matchTaxonomy("What's my 401k status?").map((m) => m.category)).toEqual(['benefits']);
  });

  it('returns an empty array for a message matching no known category', () => {
    expect(matchTaxonomy('What is the capital of France?')).toEqual([]);
  });

  it('never returns duplicate categories even if several keywords for the same category match', () => {
    const matches = matchTaxonomy('Show my payroll, salary, and paycheck details');
    expect(matches).toEqual([{ category: 'payroll', resourcePath: '/payrollElements?onlyData=true&limit=10' }]);
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `npm run test:unit`
Expected: FAIL — `src/renderer/oracle-taxonomy.js` does not exist.

- [ ] **Step 3: Implement `src/renderer/oracle-taxonomy.js`**

```javascript
// src/renderer/oracle-taxonomy.js
const ORACLE_TAXONOMY = [
  { category: 'employees', resourcePath: '/workers?onlyData=true&limit=20', keywords: ['employee', 'employees', 'worker', 'workers', 'team', 'report', 'reports', 'person', 'people', 'staff', 'headcount', 'who works'] },
  { category: 'departments', resourcePath: '/departments?onlyData=true&limit=10', keywords: ['department', 'departments', 'org', 'organization', 'division'] },
  { category: 'absences', resourcePath: '/absences?onlyData=true&limit=10', keywords: ['absence', 'absences', 'leave', 'vacation', 'time off', 'pto', 'sick', 'holiday'] },
  { category: 'timeCards', resourcePath: '/timeCards?onlyData=true&limit=10', keywords: ['time card', 'timecard', 'timesheet', 'hours worked', 'clock in', 'clock out', 'attendance'] },
  { category: 'payroll', resourcePath: '/payrollElements?onlyData=true&limit=10', keywords: ['payroll', 'salary', 'pay', 'wage', 'earning', 'earnings', 'paycheck', 'payslip', 'net pay', 'gross pay'] },
  { category: 'compensation', resourcePath: '/salaries?onlyData=true&limit=10', keywords: ['compensation', 'comp', 'raise', 'bonus', 'merit increase'] },
  { category: 'benefits', resourcePath: '/benefitEnrollments?onlyData=true&limit=10', keywords: ['benefit', 'benefits', 'insurance', '401k', 'retirement', 'health plan', 'dental', 'vision plan', 'enrollment'] },
  { category: 'jobs', resourcePath: '/jobs?onlyData=true&limit=10', keywords: ['job', 'jobs', 'position', 'role', 'title', 'job family'] },
  { category: 'locations', resourcePath: '/locations?onlyData=true&limit=10', keywords: ['location', 'locations', 'office', 'site', 'address'] },
  { category: 'performance', resourcePath: '/performanceDocuments?onlyData=true&limit=10', keywords: ['performance', 'review', 'appraisal', 'rating'] },
  { category: 'goals', resourcePath: '/goals?onlyData=true&limit=10', keywords: ['goal', 'goals', 'objective', 'okr', 'kpi'] },
  { category: 'recruiting', resourcePath: '/recruitingRequisitionES?onlyData=true&limit=10', keywords: ['requisition', 'req', 'job opening', 'hiring', 'candidate'] },
  { category: 'learning', resourcePath: '/learningCourses?onlyData=true&limit=10', keywords: ['learning', 'course', 'courses', 'training', 'certification'] },
  { category: 'grades', resourcePath: '/grades?onlyData=true&limit=10', keywords: ['grade', 'grades', 'pay grade', 'band', 'level'] },
  { category: 'positions', resourcePath: '/positions?onlyData=true&limit=10', keywords: ['position', 'positions', 'org chart'] },
];

function matchTaxonomy(message) {
  const q = message.toLowerCase();
  const matches = [];
  for (const entry of ORACLE_TAXONOMY) {
    if (entry.keywords.some((k) => q.includes(k))) {
      matches.push({ category: entry.category, resourcePath: entry.resourcePath });
    }
  }
  return matches;
}

module.exports = { ORACLE_TAXONOMY, matchTaxonomy };
```

- [ ] **Step 4: Run and confirm it passes**

Run: `npm run test:unit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/oracle-taxonomy.js tests/unit/oracle-taxonomy.test.js
git commit -m "feat: add structured Oracle Fusion HCM keyword taxonomy with multi-category matching"
```

---

### Task 2: Retrieval planner (fetch all matched categories, format as [LIVE DATA])

**Files:**
- Create: `src/renderer/retrieval.js`
- Test: `tests/unit/retrieval.test.js`

**Interfaces:**
- Consumes: `matchTaxonomy` (Task 1), a `backendClient`-shaped object with `fetchPersonData(resourcePath)`/`fetchReferenceData(category)` (Phase 2 plan).
- Produces: `fetchForMessage(message, backendClient): Promise<string>` (returns an assembled `[LIVE DATA]` block, or `''` if nothing matched or all fetches were empty) and `fetchForDescription(description, backendClient): Promise<string>` (same, but taxonomy-matches a `NEED_DATA` description instead of the raw user message) — Task 3's `sendMessage` rewrite calls both by these exact names.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/unit/retrieval.test.js
const { describe, it, expect, vi } = require('vitest');
const { fetchForMessage, fetchForDescription } = require('../../src/renderer/retrieval');

function fakeBackendClient(itemsByPath) {
  return {
    fetchPersonData: vi.fn(async (path) => ({ items: itemsByPath[path] || [] })),
    fetchReferenceData: vi.fn(async () => ({ items: [] })),
  };
}

describe('fetchForMessage', () => {
  it('fetches every matched category and labels each block', async () => {
    const client = fakeBackendClient({
      '/absences?onlyData=true&limit=10': [{ AbsenceType: 'Vacation', StartDate: '2026-09-10', EndDate: '2026-09-12', AbsenceStatus: 'Approved' }],
    });
    const result = await fetchForMessage('Show my absences', client);
    expect(result).toContain('[LIVE DATA: absences]');
    expect(result).toContain('Vacation');
  });

  it('returns an empty string when nothing matches', async () => {
    const client = fakeBackendClient({});
    const result = await fetchForMessage('What is the capital of France?', client);
    expect(result).toBe('');
  });

  it('returns an empty string for a matched category with no records, rather than fabricating placeholder text', async () => {
    const client = fakeBackendClient({ '/absences?onlyData=true&limit=10': [] });
    const result = await fetchForMessage('Show my absences', client);
    expect(result).toBe('');
  });

  it('fetches multiple matched categories in one call', async () => {
    const client = fakeBackendClient({
      '/absences?onlyData=true&limit=10': [{ AbsenceType: 'Sick' }],
      '/payrollElements?onlyData=true&limit=10': [{ Name: 'Base Pay', Value: '5000', Currency: 'USD' }],
    });
    const result = await fetchForMessage("Compare my absences and payroll", client);
    expect(result).toContain('[LIVE DATA: absences]');
    expect(result).toContain('[LIVE DATA: payroll]');
  });
});

describe('fetchForDescription', () => {
  it('taxonomy-matches a NEED_DATA description instead of the raw user message', async () => {
    const client = fakeBackendClient({ '/benefitEnrollments?onlyData=true&limit=10': [{ BenefitPlanName: 'Dental PPO', EnrollmentStatus: 'Active' }] });
    const result = await fetchForDescription('the employee\'s current benefit enrollments', client);
    expect(result).toContain('[LIVE DATA: benefits]');
    expect(result).toContain('Dental PPO');
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `npm run test:unit`
Expected: FAIL — `src/renderer/retrieval.js` does not exist.

- [ ] **Step 3: Implement `src/renderer/retrieval.js`**

```javascript
// src/renderer/retrieval.js
const { matchTaxonomy } = require('./oracle-taxonomy');

function formatItems(items) {
  return items
    .map((item, i) => `${i + 1}. ` + Object.entries(item).map(([k, v]) => `${k}: ${v}`).join(' | '))
    .join('\n');
}

async function fetchMatches(matches, backendClient) {
  const blocks = [];
  for (const match of matches) {
    let data;
    try {
      data = await backendClient.fetchPersonData(match.resourcePath);
    } catch (err) {
      console.error(`Failed to fetch ${match.category}:`, err);
      continue;
    }
    const items = data.items || [];
    if (items.length === 0) continue; // matched category, but no data — say nothing rather than fabricate
    blocks.push(`[LIVE DATA: ${match.category}]\n${formatItems(items)}`);
  }
  return blocks.join('\n\n');
}

async function fetchForMessage(message, backendClient) {
  return fetchMatches(matchTaxonomy(message), backendClient);
}

async function fetchForDescription(description, backendClient) {
  return fetchMatches(matchTaxonomy(description), backendClient);
}

module.exports = { fetchForMessage, fetchForDescription };
```

- [ ] **Step 4: Run and confirm it passes**

Run: `npm run test:unit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/retrieval.js tests/unit/retrieval.test.js
git commit -m "feat: add multi-category Oracle data retrieval planner with no-fabrication empty-result handling"
```

---

### Task 3: NEED_DATA sentinel parsing + bounded one-retry loop

**Files:**
- Create: `src/renderer/need-data.js`
- Test: `tests/unit/need-data.test.js`

**Interfaces:**
- Produces: `parseNeedData(responseText): string | null` — returns the description inside a `[NEED_DATA: ...]` line if the response consists of exactly that sentinel, else `null`. Task 5 wires this into `sendMessage`'s round-1/round-2 logic.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/unit/need-data.test.js
const { describe, it, expect } = require('vitest');
const { parseNeedData } = require('../../src/renderer/need-data');

describe('parseNeedData', () => {
  it('extracts the description from a well-formed sentinel', () => {
    expect(parseNeedData('[NEED_DATA: the employee\'s current benefit enrollments]')).toBe("the employee's current benefit enrollments");
  });

  it('returns null for an ordinary answer', () => {
    expect(parseNeedData('Here are your absences: 1. Vacation, Sep 10-12, Approved')).toBe(null);
  });

  it('returns null when NEED_DATA appears mid-response rather than as the entire response', () => {
    expect(parseNeedData("Sure, here's what I found. [NEED_DATA: payroll]")).toBe(null);
  });

  it('trims surrounding whitespace before matching', () => {
    expect(parseNeedData('   [NEED_DATA: absences]  \n')).toBe('absences');
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `npm run test:unit`
Expected: FAIL — `src/renderer/need-data.js` does not exist.

- [ ] **Step 3: Implement `src/renderer/need-data.js`**

```javascript
// src/renderer/need-data.js
function parseNeedData(responseText) {
  const trimmed = responseText.trim();
  const match = trimmed.match(/^\[NEED_DATA:\s*(.+?)\]$/);
  return match ? match[1].trim() : null;
}

module.exports = { parseNeedData };
```

- [ ] **Step 4: Run and confirm it passes**

Run: `npm run test:unit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/need-data.js tests/unit/need-data.test.js
git commit -m "feat: add NEED_DATA sentinel parser for the bounded one-retry retrieval loop"
```

---

### Task 4: Advisory anti-hallucination grounding check

**Files:**
- Create: `src/renderer/grounding-check.js`
- Test: `tests/unit/grounding-check.test.js`

**Interfaces:**
- Produces: `checkGrounding(responseText, groundingBlocks: string[]): { grounded: boolean; suspiciousTerms: string[] }`. Task 5 calls this after every LLM response and logs (not blocks) on `grounded: false`.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/unit/grounding-check.test.js
const { describe, it, expect } = require('vitest');
const { checkGrounding } = require('../../src/renderer/grounding-check');

describe('checkGrounding', () => {
  it('reports grounded when every proper noun in the response appears in the grounding blocks', () => {
    const result = checkGrounding(
      'Jane Smith is in the Engineering department.',
      ['[LIVE DATA: employees]\n1. DisplayName: Jane Smith | Dept: Engineering']
    );
    expect(result.grounded).toBe(true);
    expect(result.suspiciousTerms).toEqual([]);
  });

  it('flags a proper noun that does not appear anywhere in the grounding blocks', () => {
    const result = checkGrounding(
      'John Doe is in the Marketing department.',
      ['[LIVE DATA: employees]\n1. DisplayName: Jane Smith | Dept: Engineering']
    );
    expect(result.grounded).toBe(false);
    expect(result.suspiciousTerms).toContain('John');
  });

  it('ignores common sentence-structure words and the assistant\'s own name', () => {
    const result = checkGrounding('Here is your data from Savvy.', []);
    expect(result.suspiciousTerms).not.toContain('Here');
    expect(result.suspiciousTerms).not.toContain('Savvy');
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `npm run test:unit`
Expected: FAIL — `src/renderer/grounding-check.js` does not exist.

- [ ] **Step 3: Implement `src/renderer/grounding-check.js`**

```javascript
// src/renderer/grounding-check.js
const COMMON_WORDS = new Set(['The', 'This', 'That', 'Here', 'Your', 'Savvy', 'Oracle', 'I']);

function checkGrounding(responseText, groundingBlocks) {
  const groundingText = groundingBlocks.join('\n').toLowerCase();
  const properNouns = responseText.match(/\b[A-Z][a-z]{2,}\b/g) || [];
  const suspicious = [...new Set(properNouns)].filter(
    (word) => !COMMON_WORDS.has(word) && !groundingText.includes(word.toLowerCase())
  );
  return { grounded: suspicious.length === 0, suspiciousTerms: suspicious };
}

module.exports = { checkGrounding };
```

- [ ] **Step 4: Run and confirm it passes**

Run: `npm run test:unit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/grounding-check.js tests/unit/grounding-check.test.js
git commit -m "feat: add advisory proper-noun grounding check for hallucination monitoring"
```

---

### Task 5: Rewire `sendMessage` to use the taxonomy, retrieval loop, and grounding check

**Files:**
- Modify: `src/renderer/index.js` (`sendMessage`, system prompt)

**Interfaces:**
- Consumes: `fetchForMessage`/`fetchForDescription` (Task 2), `parseNeedData` (Task 3), `checkGrounding` (Task 4).

- [ ] **Step 1: Replace the system prompt in `sendMessage`**

Replace the `sysPrompt` template literal (currently starting `You are Savvy, an Oracle Fusion HCM assistant. Oracle is always logged in...`) with the literal text from the spec's Section 6:

```javascript
  const sysPrompt = `You are Savvy, an Oracle Fusion HCM assistant embedded as a live overlay. Oracle is always logged in for this user.

Ground rules (non-negotiable):
1. Never invent data. Only state facts that appear in the [LIVE DATA], [REFERENCE DATA], [PAGE CONTEXT], or [HCM KNOWLEDGE] blocks provided below. If something isn't there, say plainly: "I couldn't find that in your Oracle HCM data" — do not guess a plausible-sounding name, number, or date.
2. Never ask the user to run a query, open an API, check a specific screen, or fetch anything themselves. You have direct access to their HCM data through the system that talks to you. If you need data you don't have yet, respond with EXACTLY one line: [NEED_DATA: <short description of what's missing>] and nothing else — the system will fetch it and give you a real answer to compose next turn. You get only one such request per question, so ask for the single most useful thing.
3. When [PAGE CONTEXT] (from the live screen) and [LIVE DATA] disagree, trust [LIVE DATA] — screen reading can be imprecise. Use [PAGE CONTEXT] only to understand which module or record the user means, never as a source of numbers or names.
4. Be direct and concise. Present data as a clean formatted list, never raw JSON.
5. If the question isn't about Oracle Fusion HCM or the current context, say so briefly and ask about Oracle Fusion instead.`;
```

- [ ] **Step 2: Replace the manual `autoFetchData`/`searchHcmApis`/`hcmDiscovery` block assembly with the taxonomy-driven planner**

Replace this section of `sendMessage` (the block that currently calls `autoFetchData`, `searchHcmApis`, `hcmDiscovery.searchContext`/`buildSummary`):
```javascript
  // Auto-fetch real data from Oracle HCM based on user intent
  const fetchedData = await autoFetchData(msg);
  if (fetchedData) {
    fullMsg = fetchedData + '\n\n' + fullMsg;
  }

  // Search HCM APIs based on user question
  const apiResults = searchHcmApis(msg);
  if (apiResults) {
    fullMsg = '[RELEVANT REST APIS]\n' + apiResults + '\n\n' + fullMsg;
  }

  const summary = hcmDiscovery ? hcmDiscovery.buildSummary() : '';
  const searchResult = hcmDiscovery ? hcmDiscovery.searchContext(msg) : '';
  if (searchResult) {
    fullMsg = '[MATCHING HCM DATA]\n' + searchResult + '\n\n' + fullMsg;
  } else if (summary) {
    fullMsg = '[ORGANIZATION SUMMARY]\n' + summary.substring(0, 3000) + '\n\n' + fullMsg;
  }
```
with:
```javascript
  const { fetchForMessage, fetchForDescription } = require('./retrieval');
  const liveData = await fetchForMessage(msg, backendClient);
  if (liveData) {
    fullMsg = liveData + '\n\n' + fullMsg;
  }
```

(The old `autoFetchData` function and its Oracle-specific branches are now fully superseded by Task 1/2's taxonomy and planner — delete `autoFetchData` from `src/renderer/index.js` entirely rather than leaving it unused.)

- [ ] **Step 3: Add the bounded one-retry loop around the `callLLM` call**

Replace:
```javascript
  const botMsg = addMessage('', 'bot');
  let fullText = '';

  const reply = await callLLM(messages, (chunk) => {
    fullText += chunk;
    botMsg.querySelector('.msg-text').textContent = fullText;
    document.getElementById('messages').scrollTop = document.getElementById('messages').scrollHeight;
  });
```
with:
```javascript
  const { parseNeedData } = require('./need-data');
  const { checkGrounding } = require('./grounding-check');

  const botMsg = addMessage('', 'bot');
  let fullText = '';

  let reply = await callLLM(messages, (chunk) => {
    fullText += chunk;
    botMsg.querySelector('.msg-text').textContent = fullText;
    document.getElementById('messages').scrollTop = document.getElementById('messages').scrollHeight;
  });

  const needDataDescription = parseNeedData(fullText);
  if (needDataDescription) {
    const additionalData = await fetchForDescription(needDataDescription, backendClient);
    const followUpMessages = [
      { role: 'system', content: sysPrompt + '\n\nYou already used your one data request for this question. Answer now using the data below — do not emit another [NEED_DATA] line.' },
      { role: 'user', content: (additionalData ? additionalData + '\n\n' : 'No additional data was found for that request.\n\n') + fullMsg },
    ];
    fullText = '';
    botMsg.querySelector('.msg-text').textContent = '';
    reply = await callLLM(followUpMessages, (chunk) => {
      fullText += chunk;
      botMsg.querySelector('.msg-text').textContent = fullText;
      document.getElementById('messages').scrollTop = document.getElementById('messages').scrollHeight;
    });
  }

  const grounding = checkGrounding(fullText || reply, [liveData, pageContext].filter(Boolean));
  if (!grounding.grounded) {
    console.warn('Potential ungrounded terms in assistant response:', grounding.suspiciousTerms);
  }
```

- [ ] **Step 4: Manual verification (the retrieval loop's model-facing behavior can't be fully asserted by unit tests alone)**

The unit tests in Tasks 1-4 cover every pure-logic piece (taxonomy matching, data fetching/formatting, sentinel parsing, grounding heuristic) in isolation. Whether `phi3:mini` actually emits a well-formed `[NEED_DATA: ...]` line when it lacks information is a model-behavior question, not a code-correctness one — verify manually by asking a question that requires data outside what taxonomy-matches the original message (e.g., a follow-up like "and what's their manager's name?" after an absences answer) and confirming the second round-trip fires and produces a grounded answer.

- [ ] **Step 5: Rebuild the renderer bundle and run the unit test suite**

Run: `node scripts/build-renderer.js && npm run test:unit`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/renderer/index.js
git commit -m "feat: rewire chat to use taxonomy-driven retrieval, bounded NEED_DATA loop, and grounding check"
```

---

## Self-Review Notes

- **Spec coverage**: Section 2's "never ask the user, use NEED_DATA instead" principle is enforced by Task 5's system prompt + loop; Section 3's taxonomy by Task 1; Section 4's bounded retrieval loop by Tasks 2-3 and their wiring in Task 5; Section 5's live-data-over-screen-context priority is stated directly in the system prompt (Task 5, Step 1) rather than needing separate code, since it's a model-instruction concern, not a data-structure one; Section 7's advisory grounding check by Task 4.
- **Type/interface consistency**: `matchTaxonomy`'s return shape (`{ category, resourcePath }[]`, Task 1) is consumed identically by `fetchMatches` in Task 2; `fetchForMessage`/`fetchForDescription` (Task 2) are called with the exact same `backendClient` shape Task 5 already has in scope from the Phase 2 plan's `initBackendClient()`.
- **No fabrication, enforced structurally, not just by prompt instruction**: Task 2's `fetchMatches` explicitly skips any matched category that returns zero items (`if (items.length === 0) continue`) rather than emitting an empty or placeholder `[LIVE DATA]` block — this means the model is never even shown a block that could be mistaken for "data exists but I'm not seeing it," which would otherwise invite it to guess at what might be there.
