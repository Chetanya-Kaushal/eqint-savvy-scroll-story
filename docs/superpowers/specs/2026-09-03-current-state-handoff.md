# Savvy Desktop — Current State Handoff (as of 2026-09-03)

This supersedes the earlier phased specs/plans in this folder wherever they conflict — those were written before live debugging against a real Oracle Fusion tenant surfaced the issues below. Treat this doc as the source of truth for what the app actually does today.

## What changed and why (chronological, most recent first)

| Commit | Root cause fixed |
|---|---|
| `6dd7367` | Identity resolution (`detectCurrentUser`) used `/userAccounts`, which 403s for self-service logins. Replaced with `/selfDetails` (works for every account type, no elevated privilege) + a lightweight `/workers?q=PersonNumber=...&fields=PersonId,PersonNumber` follow-up for the numeric PersonId. |
| `ec65946` | "Employment details" was misrouted to `/emps` (a 403-blocked resource) because of a bare `'emp'` keyword substring-matching "employ**men**t". Moved `'employment'` to `/workers`'s keyword list; narrowed `/emps` to `'employee list'` only. |
| `3885da0` | When a data-fetch ran but every endpoint returned zero records or access-denied, the raw status lines were still handed to the LLM as "context" — it fabricated a plausible-sounding permissions/privacy refusal instead of saying "not found." Fixed by short-circuiting straight to the real status lines, in plain language, whenever no `__HTML__` data block was produced. |
| `6298d99` | Same class of bug, one layer up: `detectCurrentUser` (previous version) used an invalid filter attribute, so it silently believed no login was ever linked to a person. |
| `edfc794` | LLM was still asked to "improvise" when no endpoint keyword matched at all, or when identity resolution failed cleanly (not a permissions issue) — it invented content instead of admitting it had nothing. Both cases now short-circuit to a deterministic message. |
| `e019757`, `68f62b6`, `81a641c`, `4b8d132`, `e398407`, `5e6aa9a`, `50ae0f8` and earlier | Pagination model, per-endpoint filter-attribute mismatches (Oracle's field casing is inconsistent per resource), gzip decompression, person-number/self-reference phrase detection, ID hiding. See individual commit messages for detail — each was root-caused against the live tenant, not guessed. |

**Working method used throughout, and expected to continue:** never assume an Oracle field/filter name — verify live against a real tenant with a disposable Playwright script (`diag.js`, deleted after use, never committed — it touches real credentials). Root-cause before fixing (systematic-debugging discipline): reproduce, trace to source, form one hypothesis, test minimally, verify live, then commit with the evidence in the message.

---

## Architecture

**Single source of truth: real-time Oracle data, fetched on demand per chat message. No caching, no "understanding scan" (that feature was removed — commit `29c6b27` — user explicitly rejected it as unnecessary; the app now always fetches live at chat time).**

### Message flow (`sendMessage()` in `src/renderer/index.js`)

1. `autoFetchData(userMessage)` runs first, always. It returns one of:
   - `{ type: 'error' }` — Oracle not configured.
   - `{ type: 'text' }` — no HCM_ENDPOINTS keyword matched the message at all.
   - `{ type: 'no-data' }` — identity or person-name/number resolution came back empty/ambiguous-but-empty.
   - `{ type: 'choose-person', persons: [...] }` — name search matched 2+ people; render selection buttons.
   - `{ type: 'access-denied' }` — hard-stop (401 only — bad credentials).
   - `{ type: 'data', text, results }` — one or more endpoints were queried. `results` is the raw per-endpoint status/record array; `text` also carries `__HTML__...` lines for any endpoint that actually returned ≥1 record.
2. **`text` / `no-data` / `access-denied`**: shown to the user verbatim, immediately. LLM is never consulted.
3. **`data` with no `__HTML__` block** (every endpoint returned 0 records or was denied): the raw `results` lines are cleaned into plain English and shown directly. LLM is never consulted. *(This is the `3885da0` fix — the most recently-discovered gap.)*
4. **`data` with a `__HTML__` block**: the real fetched-data card is rendered from whitelisted fields only (`HTML_FORMATTERS` / `buildPersonProfileHTML` / `renderDataBlock`) and shown as-is, followed by a fixed closing note. **The LLM is never asked to narrate real fetched data** — verified repeatedly that a small local model invents names/departments/dates/IDs when asked to turn real data into prose, regardless of prompt wording.
5. **Only remaining path that reaches the LLM**: general HCM knowledge questions where `autoFetchData` found nothing to fetch at all is *not* actually how it works (see step 2) — in practice the LLM is called only for genuinely open-ended follow-up chat once a data card has already been shown, or knowledge-base/REST-API-reference questions (`searchHcmApis`, `findKnowledge`) with no live data attached.

**Rule of thumb for opencode going forward: if a code path can produce a message with zero real facts backing it, it must never be handed to the LLM as free context. Always prefer a deterministic, template-based message over LLM narration when the app already knows the literal answer (including "nothing found" and "access denied").**

---

## LLM instructions (system prompt) — for reflecting data

This is the exact system prompt currently sent on every LLM call (`sendMessage()`, `src/renderer/index.js`). It only ever runs *after* real data (if any) has already been shown as a card — its job is conversational follow-up and general knowledge, never to originate factual claims about specific records:

```
You are Savvy, an Oracle Fusion HCM assistant. ONLY answer questions about Oracle Fusion HCM. Never answer questions unrelated to Oracle HCM.

CRITICAL RULES:
1. NEVER fabricate, guess, or make up data. Only show data fetched from the user's Oracle instance.
2. If Oracle credentials are not configured, tell the user to set them in Settings.
3. If an API call fails, show the actual error - never create fake data.
4. Only answer questions about: absences, employees, departments, locations, jobs, payroll, benefits, time cards, performance, learning, checklists.
5. If asked about anything else, respond: "I can only help with Oracle Fusion HCM questions."
6. When showing data, always indicate it comes from their Oracle system.
7. Never include instructions about how to use APIs - just show the data.
8. Be brief and direct. No extra words.
9. NEVER output raw JSON, curly braces, or anything that looks like code. If you catch yourself about to write "{", stop and rephrase the same information as a short sentence or bullet point instead.
10. NEVER show an internal system ID (PersonId, AssignmentId, PayrollRelationshipId, or any long numeric surrogate key) anywhere in your response - those are meaningless database keys, not something a person would recognize. A person's Person Number (a short code like "NM1658") is different - it's their actual business employee code, and you should state it plainly if asked "what is their person number" or similar, using the exact value provided. If a name is not available, say "this person" instead of showing an internal ID.
11. Use the full data provided to answer specific questions (department, job, location, etc.).
12. Write for someone with zero technical background - plain, everyday words only. No field names, no technical terms, no jargon. Explain things the way you'd explain them to a curious child: simply and warmly.
13. Keep each person's/record's facts strictly separate. Never blend a detail from one data block with a name or record from a different block, and never let a system field like CreatedBy or LastUpdatedBy (an audit trail of who touched the record, not who it's about) be mistaken for the actual person the record is about.
14. Conversation history is context, not a license to improvise. If an earlier turn mentioned a person, only reuse that identity for a follow-up ("his", "her", "their", "that person") if it's genuinely unambiguous from the immediately preceding exchange. If it's been several turns, the topic has shifted, or more than one person was discussed, do not guess who a pronoun refers to - ask "Which person do you mean - by name or employee number?" instead of picking one.
15. If the data needed to answer isn't in front of you - not fetched, not in this conversation, not in [HCM KNOWLEDGE] - say plainly that you don't have that information right now. A confident-sounding guess is a worse answer than an honest "I don't have that on file."
16. Before answering, silently check: is every specific fact I'm about to state (a name, a date, an amount, a status) traceable to a block actually shown above? If any single fact fails that check, cut it or replace it with "I don't have that on file" - do not soften a fabrication into "maybe" or "it looks like" instead of removing it.
```

**Design principle behind rules 9–16 (added across `68f62b6` and earlier):** prompt wording alone does not reliably stop a small local model (phi3:mini) from hallucinating when it's given real record data to narrate — that's *why* step 4 above bypasses the LLM entirely for real data and step 3 bypasses it for "nothing found." The system prompt only has to hold for pure conversational/knowledge turns, which is a much easier bar. **Do not relax steps 2–5 of the message-flow architecture and try to compensate with a longer system prompt — that was tried implicitly and failed; the fix that actually worked was removing the LLM from the loop for factual claims, not instructing it harder.**

---

## Identity resolution (current, correct architecture)

`detectCurrentUser()` runs once at load:
1. `GET /selfDetails?onlyData=true` with the configured credentials. Works for every account type, no elevated privilege needed.
   - `PersonNumber` present → this login is a real employee; store `currentUserPersonNumber` + `currentUserDisplayName`.
   - `PersonNumber: null` → admin/integration account with no linked employee record; "my X" queries will correctly ask for a specific person instead.
2. If a PersonNumber was found, a second lightweight call — `GET /workers?q=PersonNumber='<pn>'&fields=PersonId,PersonNumber&limit=1` (**no `expand`**) — resolves `currentUserPersonId` for the endpoints that filter by PersonId rather than PersonNumber.

**Known Oracle quirk to preserve, not "fix":** the same `/workers` resource, when queried WITH `expand=workRelationships.assignments`, can silently return an empty array for a self-service login even though the data genuinely exists (verified live — an admin login's identical query returns the real assignment). This is a per-account, per-resource **Oracle security-role restriction**, not a bug in this app — do not attempt to "route around" it by widening what the app requests; it needs an Oracle-side role/duty grant on the account (e.g. missing "View Own Work Relationship"). The app already reports this plainly rather than fabricating data.

---

## Endpoint scoping rules (`src/renderer/endpoint-scoping.js`)

- `PERSON_SCOPED_PATHS` — curated allowlist of ~30 endpoints live-verified to accept a person filter (`PersonNumber` or `PersonId`, per-endpoint via `personFilterField`/`personFilterUsesPersonId` on the `HCM_ENDPOINTS` entry). Everything not in this list is treated as a reference/lookup table and is **never** person-filtered, even when a person is resolved — several lookup view objects silently ignore an unrecognized filter attribute and return the *entire unfiltered table* instead of erroring, which would otherwise look like a data leak.
- A number of endpoints that look person-scoped by name were deliberately excluded after live-testing every plausible filter attribute and getting a 400: `/personNotes`, `/timeAttributes`, `/webClockEvents`, `/scheduleRequests`, `/goalsProgressDetails`, `/talentFeedbackSuggestions`, `/learnerLearningRecords`, `/workerJourneyTasks`, `/recruitingMyJobApplications`, `/tasks`, `/businessProcessNotifications`, `/businessProcessTransactionManagementAsWorkers`, `/statusChangeRequests`, `/emailAddrMigrations`, `/documentDeliveryPreferences`, `/recruitingCEInterviewScheduleDetails`. These still work as general unfiltered fetches when no person is resolved.
- **Rule for opencode:** never add a new `HCM_ENDPOINTS` entry with a guessed `personFilterField` — verify it live first (a 400 response means the attribute name is wrong for that specific resource; Oracle's casing is inconsistent per-resource, e.g. `PersonId` vs `personNumber` vs `CandidatePersonId`).
- **Rule for keywords:** avoid short substrings (the `'emp'` bug) — a keyword must not be a substring of an unrelated, commonly-typed word. Prefer whole words or specific phrases.

---

## Data safety rules already enforced in code (not just prompt)

- IDs never shown to the user: `PersonId`, `AssignmentId`, `PayrollRelationshipId`, `AbsenceTypeId`, `OrganizationId`, or any long numeric surrogate key — enforced both by the system prompt (rule 10) and by `pickDisplayLabel()` (`name-resolver.js`), which never falls back to an ID field and returns `null` (caller shows "this person"/"Team member") if no real name exists.
- `PersonNumber` (short business code like `NM1658`) is explicitly fine to show — it's the person's real employee code, not a database key.
- Every Oracle fetch includes `effectiveDate=<today>` so effective-dated records reflect the current date rather than Oracle's implicit default context.
- Pagination: first 20 records fetched, with a "Load more" button carrying the exact next-page URL (`offset` advanced) for on-demand background fetching — no blocking full-pagination loop (that caused a 45+ second hang and was reverted).

---

## Known open items (not yet fixed, out of scope of the above)

- No dedicated automated test covers `sendMessage()`'s DOM-coupled dispatch logic (steps 2–5 above) — verification has been live/manual via disposable Playwright scripts each time. If opencode adds a testing pass, this is the highest-value area to cover with a proper harness (would need to mock `window.savvy.oracleApi`).
- The Oracle tenant's own role/security configuration (e.g. the missing "View Own Work Relationship" grant noted above) is outside this app's control and should be flagged to whoever administers that tenant, not "fixed" in code.

---

## Restart & test checklist (run after every code change)

**1. Kill any already-running instance first.** Settings and conversation history persist via `electron-store` in the real userData directory, but a window left open from before your change is still running the OLD renderer bundle in memory — reloading it will not show your fix. Close every open app window before the next step.

**2. Rebuild + launch:**
```bash
npm start
```
This runs `prestart` (`node scripts/build-renderer.js`, esbuild-bundles `src/renderer/index.js` → `src/renderer.bundle.js`) automatically before `electron .`. If you only touched `src/main.js` or `src/preload/index.js`, `npm start` is still correct — those aren't bundled, they're loaded directly by Electron.

**3. Prerequisites the app expects to already be running/configured** (first run only, or after a fresh profile):
   - **Ollama** reachable at `http://localhost:11434` with the `phi3:mini` model pulled (`ollama pull phi3:mini`) — chat replies for non-data questions depend on this; a data-card response does not.
   - **Settings tab** filled in: Oracle URL, Oracle username, Oracle password. These persist across restarts once saved — no need to re-enter every time unless testing a different account.

**4. Automated tests — run both, every time, before considering a change done:**
```bash
npm run test:unit
npm run test:e2e
```
Expect 45 passed (unit) + 3 passed (e2e). Investigate any failure via systematic-debugging (root cause first) — do not skip a failing test to "just check if the fix generally works."

**5. Live verification against the real Oracle tenant** (required for anything touching `autoFetchData`, `fetchDataForPerson`, `HCM_ENDPOINTS`, or identity resolution — unit tests alone don't catch Oracle field/filter-name mismatches):
   - Write a disposable script at the project root, e.g. `diag.js`, using Playwright's `_electron.launch({ args: ['.'] })` — this launches the *real* app with the *real* persisted userData/settings, so no need to re-enter credentials if already configured.
   - Drive it via `win.evaluate(() => window.savvy.oracleApi(url, user, pass))` for raw endpoint probes, or fill `#userInput` + press Enter to exercise the full chat flow, then read `.msg.bot .msg-text` for the rendered response.
   - **Never commit this file.** Delete it (`rm diag.js`) as soon as you're done with it, in the same turn — it's a throwaway tool, not part of the codebase, and it touches live credentials.

**6. Manual smoke-test pass in the actual UI** (things regressions have hit before — worth a quick check after any renderer change):
   - Bubble mode: collapse to bubble, click to re-expand — window should reappear at its last real on-screen position, not off-screen.
   - Window edges render with no visible square/transparent boundary.
   - Send button responds on click and on Enter.
   - Clear button empties both the visible chat and the persisted conversation history (a reload should NOT bring old messages back).
   - Ask a `"Show my <X>"` question for whatever Oracle account is currently configured — confirm the response is either a real data card, a real "no access"/"not found" line, or a request to specify a person — never LLM prose that doesn't map to anything actually fetched.
   - Trigger a query that returns >20 records — confirm a "Load more" button appears and fetches the next page without blocking the UI.
   - Confirm no `PersonId`/`AssignmentId`/`OrganizationId`/`AbsenceTypeId` ever appears in a chat response; a `PersonNumber` (e.g. `NM1658`) is fine and expected.

**7. Before committing:** `git status` — confirm no stray `diag.js`, no credentials, nothing unintended staged. Commit with a message that states the root cause and how it was verified live, matching the style of the existing commit history (`git log --oneline` for reference).
