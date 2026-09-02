# EQInt Savvy — Enterprise Transformation Design

**Status:** Approved by user, ready for implementation planning
**Date:** 2026-09-02
**Scope:** Architectural — transforms savvy-desktop from a single-user local prototype into a multi-tenant, enterprise-deployable product.

## 1. Executive Summary

EQInt Savvy is currently a single-user Electron overlay that sits on top of Oracle Fusion HCM, lets a user chat with a local Ollama LLM about their HR data, and optionally reads the screen via a vision model. It stores the user's Oracle username/password in plaintext, caches the entire org's HR/payroll data unencrypted on disk, runs the renderer with full Node access (`nodeIntegration: true`, `contextIsolation: false`), and has no tests, CI, signing, or update mechanism.

This document specifies the target architecture to make it enterprise-ready: a centrally brokered, multi-tenant backend platform sits between the hardened desktop client and Oracle HCM, two tiers of admin console govern the platform and each tenant, and Oracle's own native security model — not a reimplemented one — determines who can see which person-level HR records. The local Ollama LLM stays on the desktop for inference, preserving the "HR data never leaves the machine for AI processing" story even though the backend now holds synced reference data.

## 2. Current State Assessment

| Area | Current state | File(s) |
|---|---|---|
| Electron security | `nodeIntegration: true`, `contextIsolation: false` — renderer has full Node/fs access | [src/main.js:29-44](../../../src/main.js) |
| Oracle credentials | Plaintext username/password in `electron-store`, sent as Basic Auth | [src/main.js:5-19](../../../src/main.js), [src/overlay.js:174-207](../../../src/overlay.js) |
| PII at rest | Full org HR/payroll/benefits data cached unencrypted (`hcm-data.json`, ~11MB); conversation history in plaintext JSON | [src/overlay.js:79-86](../../../src/overlay.js), [src/hcm-discovery.js:144-231](../../../src/hcm-discovery.js) |
| Architecture | Single 911-line renderer file mixing UI, LLM calls, Oracle API calls, persistence | [src/overlay.js](../../../src/overlay.js) |
| Testing/CI | None | — |
| Packaging | electron-builder portable exe, no code signing, no auto-update | [package.json](../../../package.json) |
| Version control | Not a git repository | — |
| Multi-tenancy / admin | None — single local user, single hardcoded settings object | [src/main.js:5-20](../../../src/main.js) |

## 3. Goals

- Remove all Oracle credentials and raw HR PII from the desktop client.
- Support many customer organizations (tenants), each with their own Oracle Fusion instance, users, and data isolation.
- Respect Oracle's native HCM security profiles for person-level data — do not reimplement row-level security in custom code.
- Provide two admin tiers: platform (vendor) and tenant (customer IT/HR).
- Keep LLM inference local (Ollama) for the desktop chat/vision experience.
- Establish the security, testing, CI/CD, packaging, and observability baseline expected of an enterprise-distributed desktop application.
- Provide a phased migration path from the current prototype — no big-bang rewrite.

## 4. Non-Goals (this iteration)

- Building a full self-service billing/subscription system (only the hooks/interfaces for it).
- Supporting HCM systems other than Oracle Fusion.
- Mobile clients.
- Replacing Ollama with a cloud LLM gateway (explicitly rejected — local inference is a stated privacy requirement).

## 5. Target Architecture

```
┌───────────────────────┐          ┌───────────────────────────────────┐          ┌──────────────────────┐
│   Desktop Client       │  HTTPS   │   Backend Platform (multi-tenant)  │  OAuth2/  │   Oracle Fusion HCM   │
│   (hardened Electron)  │◄────────►│                                     │  IDCS     │   (per tenant)        │
│                         │  JWT     │  - Auth/SSO gateway (OIDC)          │◄─────────►│                       │
│  - preload + contextIso │          │  - Reference-data sync engine       │           └──────────────────────┘
│  - Local Ollama LLM     │          │  - Per-user token-exchange proxy    │
│  - No Oracle creds      │          │    (person-level data)              │
│  - No plaintext PII     │          │  - Encrypted data store (Postgres)  │
└───────────────────────┘          │  - RBAC/policy engine               │
                                     │  - Immutable audit log              │
                                     │  - Platform admin console + API     │
                                     │  - Tenant admin console + API       │
                                     └───────────────────────────────────┘
```

### 5.1 Data tiering (resolves "full sync" vs. "native Oracle security" tension)

Two data classes are handled differently:

1. **Reference/structural data** — departments, locations, jobs, grades, positions, org hierarchy. Low sensitivity, identical for every viewer within a tenant. Synced on a schedule by a per-tenant Oracle service account into the backend's encrypted store. Cacheable, supports offline/degraded-Oracle scenarios.
2. **Person-level data** — workers, absences, payroll, compensation, performance, benefits, learning records. High sensitivity, visibility governed by Oracle's native HCM security profiles (Person Security Profile, manager hierarchy, area of responsibility). The backend does **not** reimplement this logic. Instead:
   - The backend performs an OAuth2 token-exchange / identity-propagation flow (via Oracle IDCS, or the customer's existing Fusion SSO federation) so each request to Oracle executes **as the specific end-user**.
   - Oracle enforces visibility natively; the backend proxies the request and applies a short-TTL, per-user cache (never a global cache) for performance.
   - **Fallback for tenants without IDCS/OAuth identity propagation configured**: person-level access falls back to the per-tenant service account plus backend-enforced RBAC, with this degraded mode explicitly flagged in the tenant admin console and audit log (compliance caveat: "person-level access control is app-enforced, not Oracle-native, for this tenant").

### 5.2 Identity model

- **End users** authenticate to the desktop client via their organization's SSO (OIDC Authorization Code + PKCE), never via a local Oracle credential.
- **Platform admins** (EQInt/vendor staff) use a standalone credential system independent of any customer IdP, with mandatory MFA. Full cross-tenant visibility: tenant provisioning/suspension, platform health, billing hooks, and a meta-audit log of vendor-side access to any tenant's data, requiring a logged justification for break-glass access.
- **Tenant admins** (customer IT/HR) authenticate via their own organization's SSO with an admin-role claim (or SCIM-provisioned admin group), scoped strictly to their own tenant: configure the Oracle connection (service account for reference data + IDCS/OAuth app registration for identity propagation), manage user/role assignments, set sync schedule and retention within platform-allowed bounds, view only their tenant's audit log.
- Both admin consoles are separate web applications — the Electron desktop client carries no admin capability.

### 5.3 Backend data store

- Postgres, encryption at rest via KMS-managed keys; field-level encryption for the most sensitive columns (compensation, benefits/medical, government IDs).
- Tenant isolation: schema-per-tenant if the expected customer count is small/large-account-oriented; row-level security by `tenant_id` if the customer base will be many smaller tenants. Decide at implementation-planning time based on actual go-to-market shape.
- Retention & erasure: configurable retention per data category (e.g., terminated-employee records purged per applicable local labor law), documented data-subject-erasure workflow for GDPR Art. 17 / CCPA deletion requests.
- Immutable, append-only audit log: every read/write recorded with actor, scope, timestamp, and (for platform-admin break-glass) justification.
- Compliance posture: this architecture is SOC 2 Type II-shaped. The implementation plan should map each component (auth gateway, encryption, audit log, access reviews) to the relevant SOC 2 trust service criteria so the build produces compliance evidence as a byproduct, not an afterthought.

## 6. Desktop Client Refactor

Target module layout (replaces the current single-file [src/overlay.js](../../../src/overlay.js)):

```
src/
  main/
    index.js          # app lifecycle, window/tray creation (from current main.js)
    ipc-handlers.js    # validated IPC contract
    auth.js            # OIDC/PKCE flow, token storage via OS credential vault (keytar)
    updater.js          # auto-update logic
  preload/
    index.js            # contextBridge-exposed API surface only
  renderer/
    chat/                # chat pane, streaming render
    screen-read/          # window capture + vision flow
    settings/              # tenant/user-facing settings (no Oracle creds)
    state/                  # small state store, no global mutable vars
  shared/
    backend-client.js       # typed client for backend API (replaces callOracleApi)
    llm-client.js            # Ollama chat + vision calls (replaces callLLM/detectVisionModel)
```

Security changes required in `main/index.js`: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` (replacing [src/main.js:41-42](../../../src/main.js)), a strict CSP in `overlay.html`, no `remote` module, and IPC payload validation on every handler (today's handlers in [src/main.js:91-203](../../../src/main.js) take unvalidated renderer input directly).

Functional changes: `callOracleApi` ([src/overlay.js:174-207](../../../src/overlay.js)) is removed entirely and replaced by `backend-client.js`, which calls the brokered backend using the user's SSO session token — never Basic Auth with a raw password. The intent-routing logic in `autoFetchData` ([src/overlay.js:210-310](../../../src/overlay.js)) is conceptually retained (it's a reasonable lightweight router) but its fetch calls redirect through the backend client. Conversation history moves from a plaintext file ([src/overlay.js:79-86](../../../src/overlay.js)) to backend-stored, per-user, encrypted storage; the desktop only holds an in-memory/session cache.

LLM integration (`llm-client.js`) is functionally unchanged from today's Ollama chat/vision flow ([src/overlay.js:125-171](../../../src/overlay.js), [src/overlay.js:540-616](../../../src/overlay.js)) — only its data source changes, from local JSON files to the backend client.

## 7. Testing Strategy

- **Unit**: intent router, backend-client request/response mapping, IPC contract validation, backend RBAC/token-exchange logic.
- **Integration**: desktop client against a mocked backend; backend against a mocked Oracle REST API (including simulated IDCS token-exchange).
- **End-to-end**: Electron shell smoke tests (open overlay, authenticate, send chat message, verify streamed render) via Playwright's Electron support.
- **Security regression tests**: assert `contextIsolation` is enabled, `nodeIntegration` is disabled, CSP header/meta is present, and no IPC handler accepts unvalidated shapes — fail the build on regression.
- **Compliance-adjacent tests**: audit log write-on-every-access, retention-policy purge job correctness, per-user cache TTL expiry.

## 8. CI/CD, Packaging & Distribution

- Pipeline (GitHub Actions or equivalent): lint → typecheck → unit/integration tests → build (Win/macOS/Linux) → code-sign → publish to staged release channel (internal → beta tenants → GA).
- Recommend migrating to TypeScript given the current dynamic, untyped IPC and backend-client surface.
- Code signing: Authenticode (Windows), notarization (macOS) — both currently absent.
- Auto-update via `electron-updater` against a private release feed.
- Enterprise deployment: MSI wrapper for Intune/SCCM silent install, with tenant ID and backend URL pushed via central policy rather than manually entered per user (replacing the current Settings-tab manual entry of Oracle URL/credentials).

## 9. Observability

- Structured logging (main + renderer) shipped to the backend's log pipeline — not local files as today.
- Crash reporting (Sentry or Electron's built-in crashReporter) wired to the backend.
- Opt-in client telemetry (feature usage, error rates) with PII scrubbing before anything leaves the desktop, configurable per tenant.

## 10. Rollout Phasing

1. **Phase 0 — Security stopgap** (immediate, no backend dependency): enable `contextIsolation`/`sandbox`, add preload + CSP, stop writing plaintext PII to disk. Highest severity, lowest effort — should not wait on the rest of the rearchitecture.
2. **Phase 1 — Backend skeleton**: auth gateway, reference-data sync engine, basic platform + tenant admin consoles. Desktop temporarily keeps local Oracle creds behind a feature flag for continuity.
3. **Phase 2 — Identity cutover**: desktop OIDC login; IDCS/OAuth token-exchange for person-level data; remove local Oracle credential storage entirely.
4. **Phase 3 — Full data layer + compliance controls**: encryption-at-rest specifics, retention/erasure workflows, audit log, SOC 2 control mapping.
5. **Phase 4 — Packaging/CI/CD/observability + enterprise distribution**: signing, auto-update, MSI/Intune, telemetry.

## 11. Risk Register

| Risk | Mitigation |
|---|---|
| Customer Oracle tenant lacks IDCS/OAuth identity propagation | Documented fallback: service-account + backend RBAC, explicitly flagged as degraded/non-native in tenant admin console and audit log |
| Backend becomes a larger breach target than today's scattered laptops | Encryption at rest, immutable audit log, retention/erasure controls, SOC 2-mapped access reviews (Section 5.3) |
| Migrating existing users' local conversation history/settings without data loss | Phase 1/2 migration script to import existing `conversation-history.json`/settings into the new backend store before local storage is deprecated |
| Ollama/local-model version drift across enterprise machines | Lightweight model-version check added in Phase 4, surfaced in tenant admin console |
| Schema-per-tenant vs. row-level-security decision made too early/late | Explicitly deferred to implementation planning, informed by actual go-to-market tenant-count expectations |

## 12. Open Questions for Implementation Planning

- Expected tenant count/shape (few large tenants vs. many small ones) — decides schema-per-tenant vs. RLS (Section 5.3).
- Target enterprise identity providers to support first (Okta, Azure AD, Ping) for the OIDC gateway.
- Whether platform-admin MFA uses TOTP, WebAuthn, or both.
- Retention period defaults per data category, pending legal/compliance input per target customer geographies.
