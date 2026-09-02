# Phase 3 — Full Data Layer Compliance Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the backend's persistence of HR/payroll PII (introduced in the Phase 1 and Phase 2 plans) defensible under a real compliance review: KMS-backed field encryption instead of an env-var key, a per-user short-TTL cache for person-level proxy responses (closing the gap between the spec's caching requirement and Phase 2's live-only proxy), a retention/purge job, a data-subject erasure workflow, and a tamper-proof audit log.

**Architecture:** No new services — all changes are inside `backend/services/api`, building on the Prisma schema and routes from the Phase 1 and Phase 2 plans.

**Tech Stack:** Adds `@aws-sdk/client-kms` (swap-in for AWS; the KMS client is injected so another provider's SDK can be substituted without changing calling code) and `node-cron` (already present from Phase 1) for the purge job.

**Spec:** [docs/superpowers/specs/2026-09-02-enterprise-transformation-design.md](../specs/2026-09-02-enterprise-transformation-design.md), Section 5.1 (per-user short-TTL cache), Section 5.3 (encryption at rest, retention & erasure, immutable audit log, SOC 2 posture).

## Global Constraints

- Every new table storing tenant- or user-scoped data includes `tenantId` and/or `userId`, consistent with Phase 1/2 tables.
- `writeAuditLog` ([backend/services/api/src/audit/log.ts](../../../backend/services/api/src/audit/log.ts)) remains the only way to write audit entries — this phase adds DB-level protection so nothing, including a compromised application code path, can silently rewrite history.
- Erasure requests anonymize the `User` row and delete the user's `ConversationEntry`/`PersonDataCache` rows, but never touch `AuditLog` rows — audit/security records are retained under a documented legal-obligation basis (GDPR Art. 17(3)), not erased. This is a deliberate, documented exception, not an oversight.

---

### Task 1: KMS-backed envelope encryption

**Files:**
- Modify: `backend/services/api/src/security/field-encryption.ts`
- Modify: `backend/services/api/src/routes/tenant-admin.ts`, `backend/services/api/src/auth/token-exchange.ts`, `backend/services/api/src/routes/data.ts` (await the now-async calls)
- Modify: `backend/services/api/package.json` (add `@aws-sdk/client-kms`)
- Test: `backend/services/api/test/security/field-encryption.test.ts`

**Interfaces:**
- Produces: `encryptField(kms, value): Promise<string>`, `decryptField(kms, value): Promise<string>` — signature change from Phase 1 (now async and KMS-client-first) is intentional; every caller is updated in this task, not left inconsistent.

- [ ] **Step 1: Add the KMS SDK**

```bash
cd backend/services/api && npm install @aws-sdk/client-kms
```

- [ ] **Step 2: Write the failing test using a fake KMS client**

```typescript
// backend/services/api/test/security/field-encryption.test.ts
import { describe, it, expect } from 'vitest';
import { encryptField, decryptField, KmsProvider } from '../../src/security/field-encryption';

function fakeKms(): KmsProvider {
  const fixedKey = Buffer.alloc(32, 9);
  return {
    generateDataKey: async () => ({ plaintextKey: fixedKey, wrappedKey: Buffer.from('wrapped-fixed-key') }),
    decryptDataKey: async () => fixedKey,
  };
}

describe('field-encryption with KMS envelope', () => {
  it('round-trips a value through encryptField/decryptField', async () => {
    const kms = fakeKms();
    const encrypted = await encryptField(kms, 'super-secret-password');
    expect(encrypted).not.toContain('super-secret-password');
    expect(await decryptField(kms, encrypted)).toBe('super-secret-password');
  });
});
```

- [ ] **Step 3: Run and confirm failure**

Run: `cd backend/services/api && npm test`
Expected: FAIL — `KmsProvider`/new signatures don't exist yet.

- [ ] **Step 4: Rewrite `src/security/field-encryption.ts`**

```typescript
// backend/services/api/src/security/field-encryption.ts
import crypto from 'crypto';
import { KMSClient, GenerateDataKeyCommand, DecryptCommand } from '@aws-sdk/client-kms';

export interface KmsProvider {
  generateDataKey(): Promise<{ plaintextKey: Buffer; wrappedKey: Buffer }>;
  decryptDataKey(wrappedKey: Buffer): Promise<Buffer>;
}

export function makeAwsKmsProvider(keyId: string): KmsProvider {
  const client = new KMSClient({});
  return {
    async generateDataKey() {
      const result = await client.send(new GenerateDataKeyCommand({ KeyId: keyId, KeySpec: 'AES_256' }));
      return { plaintextKey: Buffer.from(result.Plaintext!), wrappedKey: Buffer.from(result.CiphertextBlob!) };
    },
    async decryptDataKey(wrappedKey: Buffer) {
      const result = await client.send(new DecryptCommand({ CiphertextBlob: wrappedKey, KeyId: keyId }));
      return Buffer.from(result.Plaintext!);
    },
  };
}

// Envelope format written to the DB: base64(wrappedKeyLength(4 bytes) + wrappedKey + iv(12) + authTag(16) + ciphertext)
export async function encryptField(kms: KmsProvider, value: string): Promise<string> {
  const { plaintextKey, wrappedKey } = await kms.generateDataKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', plaintextKey, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const wrappedKeyLength = Buffer.alloc(4);
  wrappedKeyLength.writeUInt32BE(wrappedKey.length);

  return Buffer.concat([wrappedKeyLength, wrappedKey, iv, authTag, encrypted]).toString('base64');
}

export async function decryptField(kms: KmsProvider, value: string): Promise<string> {
  const raw = Buffer.from(value, 'base64');
  const wrappedKeyLength = raw.readUInt32BE(0);
  let offset = 4;
  const wrappedKey = raw.subarray(offset, offset + wrappedKeyLength);
  offset += wrappedKeyLength;
  const iv = raw.subarray(offset, offset + 12);
  offset += 12;
  const authTag = raw.subarray(offset, offset + 16);
  offset += 16;
  const encrypted = raw.subarray(offset);

  const plaintextKey = await kms.decryptDataKey(wrappedKey);
  const decipher = crypto.createDecipheriv('aes-256-gcm', plaintextKey, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}
```

- [ ] **Step 5: Run and confirm the test passes**

Run: `cd backend/services/api && npm test`
Expected: FAIL still — call sites elsewhere now break because they import the old sync signature. Proceed to Step 6 before re-running.

- [ ] **Step 6: Add a shared KMS provider singleton and update all call sites**

```typescript
// backend/services/api/src/security/kms-provider.ts
import { makeAwsKmsProvider, KmsProvider } from './field-encryption';

export const kmsProvider: KmsProvider = makeAwsKmsProvider(process.env.KMS_KEY_ID!);
```

In `backend/services/api/src/routes/tenant-admin.ts`: import `kmsProvider` from `../security/kms-provider`, change both `encryptField(...)` call sites to `await encryptField(kmsProvider, ...)`, and mark the enclosing route handlers `async` (they already are).

In `backend/services/api/src/auth/token-exchange.ts`: change `decryptField(tenant.oidcTokenExchangeClientSecret)` to `await decryptField(kmsProvider, tenant.oidcTokenExchangeClientSecret)`.

In `backend/services/api/src/routes/data.ts`'s `/hcm-proxy/*` handler: change `decryptField(tenant.oracleServicePass!)` to `await decryptField(kmsProvider, tenant.oracleServicePass!)`.

- [ ] **Step 6b: Update the Phase 2 test files that call the old sync `encryptField` signature directly**

Two test files from the Phase 2 plan call `encryptField(value)` directly (not just through a route) and will break under the new `encryptField(kms, value): Promise<string>` signature — a TypeScript arg-count error, and if bypassed, a stored `Promise` object instead of ciphertext. Fix both:

In `backend/services/api/test/auth/token-exchange.test.ts`, add `import { kmsProvider } from '../../src/security/kms-provider';` and change `oidcTokenExchangeClientSecret: encryptField('idp-secret')` to `oidcTokenExchangeClientSecret: await encryptField(kmsProvider, 'idp-secret')` (the enclosing `it(...)` callback is already `async`).

In `backend/services/api/test/routes/data.test.ts`, replace every `(await import('../../src/security/field-encryption')).encryptField('secret')` / `encryptField('svc-pass')` call with `await encryptField(kmsProvider, 'secret')` / `await encryptField(kmsProvider, 'svc-pass')`, adding a top-of-file `import { encryptField } from '../../src/security/field-encryption'; import { kmsProvider } from '../../src/security/kms-provider';` instead of the inline dynamic `import()`.

- [ ] **Step 7: Run the full backend test suite**

Run: `cd backend/services/api && npm test`
Expected: PASS (set `KMS_KEY_ID` to any placeholder string in `.env` for tests that don't exercise `makeAwsKmsProvider` directly — the unit test in this task uses the fake provider and never touches AWS).

- [ ] **Step 8: Commit**

```bash
git add backend/services/api/src/security backend/services/api/src/routes/tenant-admin.ts backend/services/api/src/auth/token-exchange.ts backend/services/api/src/routes/data.ts backend/services/api/package.json backend/services/api/package-lock.json backend/services/api/test/security
git commit -m "feat: replace env-var field encryption with KMS-backed envelope encryption"
```

---

### Task 2: Per-user short-TTL cache for person-level proxy responses

**Files:**
- Modify: `backend/services/api/prisma/schema.prisma` (add `PersonDataCache`)
- Modify: `backend/services/api/src/routes/data.ts` (`/hcm-proxy/*` reads/writes the cache)
- Test: add cases to `backend/services/api/test/routes/data.test.ts`

**Interfaces:**
- Produces: `PersonDataCache` model (`userId`, `resourcePath`, `data`, `expiresAt`). Task 3's purge job deletes expired rows from this table by name.

- [ ] **Step 1: Add the model and migrate**

```prisma
model PersonDataCache {
  id           String   @id @default(uuid())
  userId       String
  resourcePath String
  data         Json
  expiresAt    DateTime

  @@unique([userId, resourcePath])
  @@index([expiresAt])
}
```

```bash
cd backend/services/api && npx prisma migrate dev --name add_person_data_cache
```

- [ ] **Step 2: Write the failing cache-hit test**

Add to `backend/services/api/test/routes/data.test.ts`:
```typescript
describe('/hcm-proxy/* caching', () => {
  it('serves a second identical request from cache without calling Oracle again', async () => {
    await prisma.tenant.update({ where: { id: tenantId }, data: { oracleBaseUrl: 'https://acme.example.com', oracleServiceUser: 'svc', oracleServicePass: await encryptField(kmsProvider, 'svc-pass') } });

    let oracleCallCount = 0;
    global.fetch = vi.fn(async (url: string) => {
      if (url === 'https://acme.example.com/hcmRestApi/resources/11.13.18.05/absences') {
        oracleCallCount += 1;
        return { ok: true, status: 200, json: async () => ({ items: [{ id: 1 }] }) } as Response;
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const server = buildServer();
    await server.inject({ method: 'GET', url: '/hcm-proxy/absences', headers: { authorization: `Bearer ${token}` } });
    await server.inject({ method: 'GET', url: '/hcm-proxy/absences', headers: { authorization: `Bearer ${token}` } });

    expect(oracleCallCount).toBe(1);
  });
});
```

(Add the necessary `import { encryptField } from '../../src/security/field-encryption'; import { kmsProvider } from '../../src/security/kms-provider';` to the top of the test file.)

- [ ] **Step 3: Run and confirm failure**

Run: `cd backend/services/api && npm test`
Expected: FAIL — the second request re-calls Oracle (`oracleCallCount` is 2).

- [ ] **Step 4: Add cache read/write to the `/hcm-proxy/*` handler in `src/routes/data.ts`**

```typescript
  const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  server.all<{ Params: { '*': string } }>('/hcm-proxy/*', { preHandler: requireAuth }, async (request, reply) => {
    const session = (request as FastifyRequest & { session: SessionClaims }).session;
    const resourcePath = '/' + request.params['*'];

    if (request.method === 'GET') {
      const cached = await prisma.personDataCache.findUnique({ where: { userId_resourcePath: { userId: session.userId, resourcePath } } });
      if (cached && cached.expiresAt > new Date()) {
        return cached.data;
      }
    }

    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: session.tenantId } });
    const ssoIdToken = request.headers['x-sso-id-token'] as string | undefined;

    let accessToken: string | null = null;
    let mode = 'degraded_service_account';
    if (ssoIdToken) {
      accessToken = await exchangeForOracleAccessToken(session.tenantId, ssoIdToken);
      if (accessToken) mode = 'native';
    }

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (accessToken) {
      headers.Authorization = `Bearer ${accessToken}`;
    } else {
      headers.Authorization = 'Basic ' + Buffer.from(`${tenant.oracleServiceUser}:${await decryptField(kmsProvider, tenant.oracleServicePass!)}`).toString('base64');
    }

    const oracleResponse = await fetch(`${tenant.oracleBaseUrl}/hcmRestApi/resources/11.13.18.05${resourcePath}`, { headers });
    const responseData = await oracleResponse.json();

    if (request.method === 'GET' && oracleResponse.ok) {
      await prisma.personDataCache.upsert({
        where: { userId_resourcePath: { userId: session.userId, resourcePath } },
        create: { userId: session.userId, resourcePath, data: responseData, expiresAt: new Date(Date.now() + CACHE_TTL_MS) },
        update: { data: responseData, expiresAt: new Date(Date.now() + CACHE_TTL_MS) },
      });
    }

    await writeAuditLog({ tenantId: session.tenantId, actor: session.userId, action: 'hcm_proxy_read', scope: `${mode}:${resourcePath}` });
    reply.code(oracleResponse.status);
    return responseData;
  });
```

- [ ] **Step 5: Run and confirm all tests pass**

Run: `cd backend/services/api && npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add backend/services/api/prisma backend/services/api/src/routes/data.ts backend/services/api/test/routes/data.test.ts
git commit -m "feat: add 5-minute per-user cache for hcm-proxy reads"
```

---

### Task 3: Retention policy + scheduled purge job

**Files:**
- Modify: `backend/services/api/prisma/schema.prisma` (add `retentionDays` to `Tenant`)
- Create: `backend/services/api/src/retention/purge.ts`
- Modify: `backend/services/api/src/sync/scheduler.ts` (register the purge job)
- Test: `backend/services/api/test/retention/purge.test.ts`

**Interfaces:**
- Produces: `runRetentionPurge(): Promise<{ conversationEntriesDeleted: number; expiredCacheEntriesDeleted: number }>`.

- [ ] **Step 1: Add the field and migrate**

```prisma
  retentionDays Int @default(365)
```
(added to the `Tenant` model)

```bash
cd backend/services/api && npx prisma migrate dev --name add_tenant_retention_days
```

- [ ] **Step 2: Write the failing test**

```typescript
// backend/services/api/test/retention/purge.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { prisma } from '../../src/db';
import { runRetentionPurge } from '../../src/retention/purge';

describe('runRetentionPurge', () => {
  let tenantId: string;
  let userId: string;

  beforeEach(async () => {
    await prisma.conversationEntry.deleteMany();
    await prisma.personDataCache.deleteMany();
    await prisma.user.deleteMany();
    await prisma.tenant.deleteMany();
    const tenant = await prisma.tenant.create({ data: { name: 'Acme', oracleBaseUrl: '', retentionDays: 30 } });
    tenantId = tenant.id;
    const user = await prisma.user.create({ data: { tenantId, email: 'jane@acme.test', role: 'employee', ssoSubject: 'sub-1' } });
    userId = user.id;
  });

  afterAll(async () => { await prisma.$disconnect(); });

  it('deletes conversation entries older than the tenant retention window', async () => {
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    const recent = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    await prisma.conversationEntry.create({ data: { userId, role: 'user', content: 'old message', createdAt: old } });
    await prisma.conversationEntry.create({ data: { userId, role: 'user', content: 'recent message', createdAt: recent } });

    const result = await runRetentionPurge();
    expect(result.conversationEntriesDeleted).toBe(1);

    const remaining = await prisma.conversationEntry.findMany();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].content).toBe('recent message');
  });

  it('deletes expired PersonDataCache rows regardless of tenant retention window', async () => {
    await prisma.personDataCache.create({ data: { userId, resourcePath: '/absences', data: {}, expiresAt: new Date(Date.now() - 1000) } });
    await prisma.personDataCache.create({ data: { userId, resourcePath: '/jobs', data: {}, expiresAt: new Date(Date.now() + 60000) } });

    const result = await runRetentionPurge();
    expect(result.expiredCacheEntriesDeleted).toBe(1);

    const remaining = await prisma.personDataCache.findMany();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].resourcePath).toBe('/jobs');
  });
});
```

- [ ] **Step 3: Run and confirm failure**

Run: `cd backend/services/api && npm test`
Expected: FAIL — `src/retention/purge.ts` does not exist.

- [ ] **Step 4: Implement `src/retention/purge.ts`**

```typescript
// backend/services/api/src/retention/purge.ts
import { prisma } from '../db';

export async function runRetentionPurge(): Promise<{ conversationEntriesDeleted: number; expiredCacheEntriesDeleted: number }> {
  const tenants = await prisma.tenant.findMany({ include: { users: true } });
  let conversationEntriesDeleted = 0;

  for (const tenant of tenants) {
    const cutoff = new Date(Date.now() - tenant.retentionDays * 24 * 60 * 60 * 1000);
    const userIds = tenant.users.map((u) => u.id);
    if (userIds.length === 0) continue;
    const result = await prisma.conversationEntry.deleteMany({ where: { userId: { in: userIds }, createdAt: { lt: cutoff } } });
    conversationEntriesDeleted += result.count;
  }

  const expiredCache = await prisma.personDataCache.deleteMany({ where: { expiresAt: { lt: new Date() } } });

  return { conversationEntriesDeleted, expiredCacheEntriesDeleted: expiredCache.count };
}
```

- [ ] **Step 5: Run and confirm it passes**

Run: `cd backend/services/api && npm test`
Expected: PASS

- [ ] **Step 6: Register the purge job in the scheduler**

Add to `backend/services/api/src/sync/scheduler.ts`:
```typescript
import { runRetentionPurge } from '../retention/purge';

// inside startScheduler():
  cron.schedule('30 2 * * *', async () => {
    try {
      const result = await runRetentionPurge();
      console.log('Retention purge complete:', result);
    } catch (err) {
      console.error('Retention purge failed:', err);
    }
  });
```

- [ ] **Step 7: Commit**

```bash
git add backend/services/api/prisma backend/services/api/src/retention backend/services/api/src/sync/scheduler.ts backend/services/api/test/retention
git commit -m "feat: add per-tenant retention purge job for conversation history and expired person-data cache"
```

---

### Task 4: Immutable audit log + data-subject erasure endpoint

**Files:**
- Create: raw-SQL Prisma migration for the `AuditLog` immutability trigger
- Create: `backend/services/api/src/routes/erasure.ts`
- Modify: `backend/services/api/src/server.ts`
- Test: `backend/services/api/test/audit/immutability.test.ts`, `backend/services/api/test/routes/erasure.test.ts`

**Interfaces:**
- Produces: `POST /tenants/:tenantId/users/:userId/erase` (tenant_admin only).

- [ ] **Step 1: Write the failing immutability test**

```typescript
// backend/services/api/test/audit/immutability.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { prisma } from '../../src/db';

describe('AuditLog immutability', () => {
  let logId: string;

  beforeEach(async () => {
    await prisma.tenant.deleteMany();
    const tenant = await prisma.tenant.create({ data: { name: 'Acme', oracleBaseUrl: '' } });
    const log = await prisma.auditLog.create({ data: { tenantId: tenant.id, actor: 'u1', action: 'test', scope: 'test' } });
    logId = log.id;
  });

  afterAll(async () => { await prisma.$disconnect(); });

  it('rejects an UPDATE against an existing AuditLog row', async () => {
    await expect(prisma.auditLog.update({ where: { id: logId }, data: { action: 'tampered' } })).rejects.toThrow();
  });

  it('rejects a DELETE against an existing AuditLog row', async () => {
    await expect(prisma.auditLog.delete({ where: { id: logId } })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd backend/services/api && npm test`
Expected: FAIL — no DB-level protection exists yet, so both operations currently succeed.

- [ ] **Step 3: Create the migration with a hand-written trigger**

```bash
cd backend/services/api && npx prisma migrate dev --create-only --name immutable_audit_log
```

Edit the generated `backend/services/api/prisma/migrations/<timestamp>_immutable_audit_log/migration.sql` to contain:
```sql
CREATE OR REPLACE FUNCTION prevent_audit_log_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AuditLog rows are immutable and cannot be updated or deleted';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_mutation();

CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_mutation();
```

```bash
npx prisma migrate dev
```

- [ ] **Step 4: Run and confirm the immutability tests pass**

Run: `cd backend/services/api && npm test`
Expected: PASS

- [ ] **Step 5: Write the failing erasure-route test**

```typescript
// backend/services/api/test/routes/erasure.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { buildServer } from '../../src/server';
import { prisma } from '../../src/db';
import { issueSessionToken } from '../../src/auth/session';

describe('POST /tenants/:tenantId/users/:userId/erase', () => {
  let tenantId: string;
  let userId: string;
  let adminToken: string;

  beforeEach(async () => {
    process.env.SESSION_JWT_SECRET = 'test-secret';
    await prisma.conversationEntry.deleteMany();
    await prisma.personDataCache.deleteMany();
    await prisma.user.deleteMany();
    await prisma.tenant.deleteMany();
    const tenant = await prisma.tenant.create({ data: { name: 'Acme', oracleBaseUrl: '' } });
    tenantId = tenant.id;
    const user = await prisma.user.create({ data: { tenantId, email: 'jane@acme.test', role: 'employee', ssoSubject: 'sub-1' } });
    userId = user.id;
    await prisma.conversationEntry.create({ data: { userId, role: 'user', content: 'hello' } });
    await prisma.personDataCache.create({ data: { userId, resourcePath: '/absences', data: {}, expiresAt: new Date(Date.now() + 60000) } });
    adminToken = issueSessionToken({ id: 'admin-1', tenantId, role: 'tenant_admin' });
  });

  afterAll(async () => { await prisma.$disconnect(); });

  it('deletes conversation history and cache, anonymizes the user, and leaves audit logs untouched', async () => {
    const server = buildServer();
    const response = await server.inject({
      method: 'POST', url: `/tenants/${tenantId}/users/${userId}/erase`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(response.statusCode).toBe(200);

    expect(await prisma.conversationEntry.findMany({ where: { userId } })).toHaveLength(0);
    expect(await prisma.personDataCache.findMany({ where: { userId } })).toHaveLength(0);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.email).toMatch(/^erased-/);

    const auditLogs = await prisma.auditLog.findMany({ where: { tenantId, action: 'data_subject_erasure' } });
    expect(auditLogs).toHaveLength(1);
  });
});
```

- [ ] **Step 6: Run and confirm failure**

Run: `cd backend/services/api && npm test`
Expected: FAIL — the route doesn't exist.

- [ ] **Step 7: Implement `src/routes/erasure.ts`**

```typescript
// backend/services/api/src/routes/erasure.ts
import { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'crypto';
import { requireRole } from '../rbac/policy';
import { prisma } from '../db';
import { writeAuditLog } from '../audit/log';
import { SessionClaims } from '../auth/session';

export function registerErasureRoutes(server: FastifyInstance): void {
  server.post<{ Params: { tenantId: string; userId: string } }>(
    '/tenants/:tenantId/users/:userId/erase',
    { preHandler: requireRole('tenant_admin') },
    async (request, reply) => {
      const session = (request as FastifyRequest & { session: SessionClaims }).session;
      if (session.tenantId !== request.params.tenantId) {
        return reply.code(403).send({ error: 'Cannot erase a user in a different tenant' });
      }

      const { userId } = request.params;
      await prisma.conversationEntry.deleteMany({ where: { userId } });
      await prisma.personDataCache.deleteMany({ where: { userId } });
      await prisma.user.update({
        where: { id: userId },
        data: { email: `erased-${randomUUID()}@deleted.invalid`, ssoSubject: `erased-${randomUUID()}` },
      });

      // AuditLog rows referencing this user are intentionally NOT deleted or modified —
      // retained under GDPR Art. 17(3) legal-obligation/security exception, and protected
      // from mutation by the immutable-audit-log trigger added earlier in this phase.
      await writeAuditLog({ tenantId: request.params.tenantId, actor: session.userId, action: 'data_subject_erasure', scope: userId });

      return { ok: true };
    }
  );
}
```

Register in `src/server.ts`: `registerErasureRoutes(server);`

- [ ] **Step 8: Run and confirm all tests pass**

Run: `cd backend/services/api && npm test`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add backend/services/api/prisma/migrations backend/services/api/src/routes/erasure.ts backend/services/api/src/server.ts backend/services/api/test/audit/immutability.test.ts backend/services/api/test/routes/erasure.test.ts
git commit -m "feat: make AuditLog immutable at the database level and add data-subject erasure endpoint"
```

---

### Task 5: SOC 2 control-mapping document

**Files:**
- Create: `backend/docs/soc2-control-mapping.md`

**Interfaces:** none — documentation deliverable.

- [ ] **Step 1: Write the control mapping**

```markdown
# SOC 2 Control Mapping — Savvy Backend Platform

| Trust Service Criterion | Control | Implementation |
|---|---|---|
| CC6.1 — Logical access controls | Role-based access enforced per request | `requireRole`/`requireAuth` ([src/rbac/policy.ts](../services/api/src/rbac/policy.ts)) |
| CC6.1 — Restricted admin access | Platform admin credentials isolated from customer IdPs | `PlatformAdmin` table + `requirePlatformAdmin` ([src/routes/platform-admin.ts](../services/api/src/routes/platform-admin.ts)) |
| CC6.6 — Encryption of data at rest | KMS-backed envelope encryption for Oracle credentials and OIDC secrets | `src/security/field-encryption.ts` |
| CC6.6 — Encryption in transit | TLS required for desktop↔backend and backend↔Oracle | Deployment requirement, enforced by Phase 4's infra config |
| CC7.2 — Audit logging | Immutable, append-only log of every tenant-scoped read/write | `writeAuditLog` + DB trigger (`prevent_audit_log_mutation`) |
| CC7.2 — Security monitoring | Structured logs and crash reporting shipped centrally | Phase 4 plan (observability) |
| A1.2 — Availability / capacity | Scheduled sync and purge jobs with per-tenant error isolation | `src/sync/scheduler.ts` |
| C1.1 — Confidentiality of sensitive data | Person-level data proxied per-user with native Oracle security enforcement where available | `src/auth/token-exchange.ts`, `/hcm-proxy/*` |
| P (Privacy) — Data retention | Per-tenant configurable retention window, scheduled purge | `src/retention/purge.ts` |
| P (Privacy) — Right to erasure | Data-subject erasure endpoint, documented audit-log retention exception | `src/routes/erasure.ts` |

This mapping is a starting point for a real SOC 2 Type II audit, not a substitute for one — an external auditor will require evidence (logs, tickets, access reviews) over a observation period, which this document does not itself provide.
```

- [ ] **Step 2: Commit**

```bash
git add backend/docs/soc2-control-mapping.md
git commit -m "docs: add SOC 2 control mapping for the backend platform"
```

---

## Self-Review Notes

- **Spec coverage**: Section 5.3's encryption-at-rest, retention/erasure, immutable audit log, and SOC 2 mapping are covered by Tasks 1, 3, 4, 5 respectively. The Section 5.1 per-user short-TTL cache — flagged as a gap left open by the Phase 2 plan — is closed by Task 2.
- **Type/interface consistency**: `KmsProvider`'s two methods (`generateDataKey`, `decryptDataKey`) are used identically in the fake test double (Task 1) and the real AWS-backed implementation; `PersonDataCache`'s `userId_resourcePath` compound unique key (from the `@@unique([userId, resourcePath])` in Task 2) is referenced with that exact Prisma-generated name in both Task 2 and Task 4's routes.
- **Explicitly out of scope for this phase**: choosing schema-per-tenant vs. row-level-security (spec's open question, Section 12) — this phase's tables still use a plain `tenantId` foreign key column, which works under either model, so the choice can still be made later without another migration of this phase's tables.
