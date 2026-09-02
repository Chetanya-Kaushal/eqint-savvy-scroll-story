# SOC 2 Control Mapping — EQInt Savvy

## Trust Services Criteria Coverage

| Control | Category | Criteria | Implementation | Status |
|---------|----------|----------|----------------|--------|
| CC6.1 | Logical Access | System access is restricted to authorized users | JWT session tokens, `requireAuth` + `requireRole` RBAC guards on all routes | Implemented |
| CC6.2 | Logical Access | User credentials are protected | KMS envelope encryption for stored secrets (`field-encryption.ts`), `safeStorage` for desktop credentials | Implemented |
| CC6.3 | Logical Access | Access is revoked when no longer needed | JWT expiry, `POST /data/erase` endpoint, retention purge job | Implemented |
| CC6.6 | Logical Access | External encryption for data in transit | HTTPS enforced via CSP `upgrade-insecure-requests`, secure token store (`keytar`) | Implemented |
| CC6.7 | Logical Access | Encryption at rest for sensitive data | KMS-backed envelope encryption, field-level encrypt for Oracle passwords + OIDC secrets | Implemented |
| CC7.1 | System Operations | Security events are logged | Immutable audit log with SHA-256 hash chain (`audit/log.ts`) | Implemented |
| CC7.2 | System Operations | Security events are monitored | Audit log stored in Postgres, accessible to platform admins | Implemented |
| CC8.1 | Change Management | Changes are authorized | No production change pipeline yet | Not implemented |
| CC9.1 | Risk Mitigation | Data classification and handling | Per-user cache TTL, retention policy, data-subject erasure | Implemented |

## Data Protection Controls

### Encryption
- **At rest**: AES-256-GCM via KMS envelope encryption (`field-encryption.ts`)
- **In transit**: HTTPS enforced, secure WebDAV/REST connections
- **Desktop credentials**: OS-native `safeStorage` / `keytar` — never stored in plaintext

### Access Control
- **Backend RBAC**: Platform admin, tenant admin, employee roles
- **Auth**: OIDC SSO with PKCE flow, JWT session tokens
- **Desktop**: OAuth PKCE flow with `openid-client`

### Data Lifecycle
- **Retention**: Tenant-configurable `retentionDays` (default 365 days)
- **Purge**: Daily scheduled job deletes expired conversation entries and cache
- **Erasure**: `POST /data/erase` endpoint for GDPR/CCPA data subject requests

### Audit
- **Logging**: Every HCM proxy read, auth event, admin action logged
- **Immutability**: SHA-256 hash of each audit entry stored alongside the record
- **Scope**: Audit entries include tenant, actor, action, and scope

## Open Gaps

| Gap | Impact | Remediation Plan |
|-----|--------|------------------|
| No automated security scanning in CI | Vulnerabilities may ship undetected | Phase 4: Add SAST/DAST to GitHub Actions |
| No penetration testing program | Unknown attack surface | Phase 4: Add periodic pen test schedule |
| No formal incident response plan | Delayed breach response | Create IRP template in Phase 4 |
| No formal change management process | Unauthorized changes risk | Implement PR approval + staging gate |
| No SOC 2 Type II audit | No independent verification | Engage auditor after 6 months of evidence collection |
