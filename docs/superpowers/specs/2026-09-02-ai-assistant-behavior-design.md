# AI Assistant Behavior Design — Agentic Oracle Fusion Retrieval

**Status:** Ready for implementation planning
**Date:** 2026-09-02
**Scope:** Bounded — upgrades the existing chat/retrieval logic in the desktop client's renderer. Depends on the Phase 0 plan (file restructure to `src/renderer/index.js`) and the Phase 2 plan (`backendClient.fetchPersonData`/`fetchReferenceData` replacing direct Oracle calls) having landed first — this spec assumes that architecture exists and builds the assistant's reasoning behavior on top of it.

## 1. Problem With the Current Behavior

Today's system prompt ([src/overlay.js:324-330](../../../src/overlay.js)) and `autoFetchData` ([src/overlay.js:210-310](../../../src/overlay.js)) are a flat if/else chain over ~10 hardcoded keywords, each triggering exactly one fixed Oracle endpoint. This has three real problems: (1) a question needing two data types (e.g., "compare my team's absences and payroll") only ever triggers the first matching branch; (2) if the matched data turns out insufficient, the model has no way to ask for more — it just answers from what little it got; (3) nothing stops the model from filling gaps with plausible-sounding but invented names, numbers, or dates, and nothing tells it to prefer freshly-fetched data over a possibly-misread screenshot.

## 2. Core Behavioral Principles

1. **The user never operates the data layer.** The assistant never tells the user to "run this query," "check the Absences page," or "look up the employee ID" — it has its own access to Oracle data through the backend, and it uses it. If the current context doesn't have what's needed, the assistant asks the *system* for it (Section 4), not the user.
2. **Zero fabrication.** Every fact stated — a name, a date, a dollar amount, a status — must be traceable to a `[LIVE DATA]`, `[REFERENCE DATA]`, `[PAGE CONTEXT]`, or `[HCM KNOWLEDGE]` block actually present in that turn's prompt. If it isn't there after the retrieval loop in Section 4 completes, the assistant says so plainly rather than guessing.
3. **Live data outranks screen reading.** The vision-derived `[PAGE CONTEXT]` (from screen capture, Section 5) can misread text (OCR-style errors are expected). When it conflicts with freshly-fetched `[LIVE DATA]`, the fetched data wins; `[PAGE CONTEXT]` is used to figure out *which module the user means*, not as a source of facts.
4. **One extra round-trip, not an open-ended agent loop.** The assistant gets exactly one opportunity to say "I need more data" per user message (Section 4) — this keeps the local-model latency bounded and avoids runaway tool-call loops with a small model that might never converge.

## 3. Oracle Fusion Domain Taxonomy

Replace the current ~10-entry hardcoded keyword list with a structured, extensible taxonomy covering the modules an HCM assistant is actually asked about, including common synonyms real users type (not just the formal Oracle field names):

| Category | Resource path | Example keywords/synonyms |
|---|---|---|
| `employees` | `/workers` | employee, worker, team, report(s), person, people, staff, headcount, "who works" |
| `departments` | `/departments` | department, org, organization, division |
| `absences` | `/absences` | absence, leave, vacation, time off, PTO, sick, holiday |
| `timeCards` | `/timeCards` | time card, timesheet, hours worked, clock in/out, attendance |
| `payroll` | `/payrollElements` | payroll, salary, pay, wage, earning(s), paycheck, payslip, net/gross pay |
| `compensation` | `/salaries` | compensation, comp, raise, bonus, merit increase |
| `benefits` | `/benefitEnrollments` | benefit(s), insurance, 401k, retirement, health/dental/vision plan |
| `jobs` | `/jobs` | job, position, role, title, job family |
| `locations` | `/locations` | location, office, site, address |
| `performance` | `/performanceDocuments` | performance, review, appraisal, rating |
| `goals` | `/goals` | goal, objective, OKR, KPI |
| `recruiting` | `/recruitingRequisitionES` | requisition, req, job opening, hiring, candidate |
| `learning` | `/learningCourses` | learning, course, training, certification |
| `grades` | `/grades` | grade, pay grade, band, level |
| `positions` | `/positions` | position (headcount-planning sense), org chart |

Unlike today's implementation, a single message can match *multiple* categories (e.g., "absences and payroll" matches both), and every match is fetched before the first LLM call.

## 4. Agentic Retrieval Loop

```
user message
   │
   ▼
taxonomy match → fetch all matched categories via backendClient (parallel)
   │
   ▼
assemble prompt: [PAGE CONTEXT] + [LIVE DATA: category...] + [HCM KNOWLEDGE] + user message
   │
   ▼
call local LLM (round 1)
   │
   ├─ response starts with "[NEED_DATA: <description>]" ──▶ taxonomy-match the description,
   │                                                          fetch the newly-identified category,
   │                                                          append it as another [LIVE DATA] block,
   │                                                          call the LLM once more (round 2, forced
   │                                                          to answer — no further NEED_DATA allowed)
   │
   └─ ordinary answer ──▶ show to user
```

This gives the model, which may not reliably support native function-calling on a small local model like `phi3:mini`, a simple, deterministic escape hatch: emit one recognizable line, get one more chance with better data, then must answer from whatever it has — including explicitly saying data wasn't found.

## 5. Live Screen-Share Fusion

The vision-derived page read (already implemented in [src/overlay.js:540-616](../../../src/overlay.js)) stays the mechanism for understanding *what the user is looking at* — which module, which record — but stops being treated as a data source once real data is available for that context. Concretely: `[PAGE CONTEXT]` is always included when present, but the system prompt (Section 6) explicitly instructs the model to prefer `[LIVE DATA]` for any factual claim and use `[PAGE CONTEXT]` only for intent disambiguation (e.g., "explain this field" needs the screen read since there's no keyword to taxonomy-match against).

## 6. System Prompt

```
You are Savvy, an Oracle Fusion HCM assistant embedded as a live overlay. Oracle is always logged in for this user.

Ground rules (non-negotiable):
1. Never invent data. Only state facts that appear in the [LIVE DATA], [REFERENCE DATA], [PAGE CONTEXT], or [HCM KNOWLEDGE] blocks provided below. If something isn't there, say plainly: "I couldn't find that in your Oracle HCM data" — do not guess a plausible-sounding name, number, or date.
2. Never ask the user to run a query, open an API, check a specific screen, or fetch anything themselves. You have direct access to their HCM data through the system that talks to you. If you need data you don't have yet, respond with EXACTLY one line: [NEED_DATA: <short description of what's missing>] and nothing else — the system will fetch it and give you a real answer to compose next turn. You get only one such request per question, so ask for the single most useful thing.
3. When [PAGE CONTEXT] (from the live screen) and [LIVE DATA] disagree, trust [LIVE DATA] — screen reading can be imprecise. Use [PAGE CONTEXT] only to understand which module or record the user means, never as a source of numbers or names.
4. Be direct and concise. Present data as a clean formatted list, never raw JSON.
5. If the question isn't about Oracle Fusion HCM or the current context, say so briefly and ask about Oracle Fusion instead.
```

## 7. Anti-Hallucination Guardrail (Advisory, Not a Hard Block)

A lightweight heuristic — extract capitalized proper-noun-like tokens from the response and check whether each appears somewhere in that turn's grounding blocks — flags likely fabrication for logging, not for blocking the response outright. This is deliberately advisory: a naive capitalized-word check will have false positives (plurals, sentence-initial words, department names that got pluralized differently than stored). Treat it as a monitoring signal that feeds into the same audit-log pipeline the Phase 3 plan already established for compliance logging, not as a mechanism that silently rewrites or suppresses answers.

## 8. Out of Scope

Native LLM function/tool-calling (some larger Ollama-served models support this) is not used here — the `[NEED_DATA: ...]` sentinel-line approach is deliberately model-agnostic and works even with small non-tool-calling models like `phi3:mini`, which is the default configured model. If a future model swap enables reliable native tool-calling, that would replace Section 4's mechanism, but is a separate decision, not bundled into this pass.
