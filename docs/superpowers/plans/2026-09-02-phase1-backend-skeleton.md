# Phase 1 — Backend Platform Skeleton (Slice 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the first working vertical slice of the multi-tenant backend platform: an auth gateway with OIDC login, a Postgres-backed data layer, an audit log, RBAC, one working reference-data sync job (departments), and minimal platform-admin and tenant-admin consoles that can create a tenant and configure its Oracle connection.

**Architecture:** A new `backend/` workspace (npm workspaces monorepo) sibling to the existing `src/` desktop app. `services/api` is a Fastify + TypeScript + Prisma REST API backed by Postgres. `apps/platform-admin` and `apps/tenant-admin` are separate Next.js apps, each calling `services/api`. The desktop client is **not** touched in this phase — it still uses local Oracle credentials until the Phase 2 plan cuts it over. This is deliberately scoped to slice 1 only: person-level data proxying/token-exchange (spec Section 5.1), field-level encryption of sensitive columns, and full compliance controls are out of scope here and covered by the Phase 2 and Phase 3 plans.

**Tech Stack:** Node.js 20+, TypeScript, Fastify, Prisma (Postgres), `openid-client` (OIDC), `jsonwebtoken` (session tokens), `node-cron` (sync scheduling), `vitest` (backend tests), Next.js 14 + TypeScript (both admin consoles), Docker Compose (local Postgres for dev/test).

**Spec:** [docs/superpowers/specs/2026-09-02-enterprise-transformation-design.md](../specs/2026-09-02-enterprise-transformation-design.md), Sections 5 ("Target Architecture"), 5.1 ("Data tiering"), 5.2 ("Identity model"), 5.3 ("Backend data store"), Section 10 Phase 1.

## Global Constraints

- All backend code lives under `backend/`, never under `src/` (which stays the desktop client's root).
- Every backend service is TypeScript, strict mode (`"strict": true` in `tsconfig.json`).
- Every table that stores tenant-scoped data has a `tenantId` column, even in this slice, so Phase 3's row-level-security work doesn't require a schema migration to retrofit it.
- No Oracle service-account password may be stored in plaintext in Postgres — reuse the encrypt/decrypt pattern from [src/main/secure-storage.js](../../../src/main/secure-storage.js) conceptually, but implemented server-side against a KMS-backed key (this slice uses a local symmetric key from an env var as a stand-in; Phase 3 replaces it with real KMS).
- Platform-admin credentials are never validated against any customer's IdP — they are a separate `PlatformAdmin` table with `bcrypt`-hashed passwords, per spec Section 5.2.

---

### Task 1: Monorepo scaffold + Postgres + Prisma schema

**Files:**
- Create: `backend/package.json` (workspace root)
- Create: `backend/docker-compose.yml`
- Create: `backend/services/api/package.json`
- Create: `backend/services/api/tsconfig.json`
- Create: `backend/services/api/prisma/schema.prisma`
- Create: `backend/services/api/vitest.config.ts`
- Create: `backend/.env.example`

**Interfaces:**
- Produces: Prisma models `Tenant`, `User`, `PlatformAdmin`, `ReferenceRecord`, `AuditLog` — every later task and later phase's plans reference these exact model/field names. Do not rename them without updating this plan's downstream references.

- [ ] **Step 1: Create the workspace root**

```json
// backend/package.json
{
  "name": "savvy-backend",
  "private": true,
  "workspaces": ["services/*", "apps/*"]
}
```

- [ ] **Step 2: Add local Postgres for dev/test**

```yaml
# backend/docker-compose.yml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: savvy
      POSTGRES_PASSWORD: savvy_dev_password
      POSTGRES_DB: savvy
    ports:
      - "5432:5432"
    volumes:
      - savvy_pg_data:/var/lib/postgresql/data
volumes:
  savvy_pg_data:
```

```bash
# backend/.env.example
DATABASE_URL="postgresql://savvy:savvy_dev_password@localhost:5432/savvy"
SESSION_JWT_SECRET="replace-with-a-long-random-string"
FIELD_ENCRYPTION_KEY="replace-with-a-32-byte-base64-key"
OIDC_ISSUER_URL="https://example-idp.test/.well-known/openid-configuration"
OIDC_CLIENT_ID="savvy-desktop"
OIDC_CLIENT_SECRET="replace-with-idp-issued-secret"
OIDC_REDIRECT_URI="http://localhost:4000/auth/callback"
```

- [ ] **Step 3: Scaffold the API service package**

```json
// backend/services/api/package.json
{
  "name": "@savvy/api",
  "version": "1.0.0",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "prisma:migrate": "prisma migrate dev",
    "prisma:generate": "prisma generate"
  },
  "dependencies": {
    "fastify": "^4.28.0",
    "@prisma/client": "^5.20.0",
    "openid-client": "^5.6.5",
    "jsonwebtoken": "^9.0.2",
    "node-cron": "^3.0.3"
  },
  "devDependencies": {
    "prisma": "^5.20.0",
    "typescript": "^5.6.0",
    "tsx": "^4.19.0",
    "vitest": "^2.1.0",
    "@types/jsonwebtoken": "^9.0.7",
    "@types/node": "^20.16.0",
    "light-my-request": "^5.13.0"
  }
}
```

```json
// backend/services/api/tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

```typescript
// backend/services/api/vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
  },
});
```

- [ ] **Step 4: Write the Prisma schema**

```prisma
// backend/services/api/prisma/schema.prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Tenant {
  id                String            @id @default(uuid())
  name              String
  oracleBaseUrl     String
  oracleServiceUser String?
  oracleServicePass String?           // encrypted at the application layer before storage — see Task 6
  createdAt         DateTime          @default(now())
  users             User[]
  referenceRecords  ReferenceRecord[]
  auditLogs         AuditLog[]
}

model User {
  id         String   @id @default(uuid())
  tenantId   String
  tenant     Tenant   @relation(fields: [tenantId], references: [id])
  email      String
  role       String   // 'employee' | 'tenant_admin'
  ssoSubject String   @unique
  createdAt  DateTime @default(now())

  @@index([tenantId])
}

model PlatformAdmin {
  id           String   @id @default(uuid())
  email        String   @unique
  passwordHash String
  createdAt    DateTime @default(now())
}

model ReferenceRecord {
  id         String   @id @default(uuid())
  tenantId   String
  tenant     Tenant   @relation(fields: [tenantId], references: [id])
  category   String   // e.g. 'department'
  externalId String
  data       Json
  syncedAt   DateTime @default(now())

  @@index([tenantId, category])
}

model AuditLog {
  id        String   @id @default(uuid())
  tenantId  String?
  tenant    Tenant?  @relation(fields: [tenantId], references: [id])
  actor     String
  action    String
  scope     String
  createdAt DateTime @default(now())

  @@index([tenantId])
}
```

- [ ] **Step 5: Start Postgres and run the first migration**

```bash
cd backend && docker compose up -d postgres
cp .env.example .env
cd services/api && npm install
npx prisma migrate dev --name init
```

Expected: migration succeeds, tables `Tenant`, `User`, `PlatformAdmin`, `ReferenceRecord`, `AuditLog` exist in the `savvy` database.

- [ ] **Step 6: Commit**

```bash
git add backend/package.json backend/docker-compose.yml backend/.env.example backend/services/api/package.json backend/services/api/package-lock.json backend/services/api/tsconfig.json backend/services/api/vitest.config.ts backend/services/api/prisma
git commit -m "feat: scaffold backend monorepo with Prisma schema for tenants/users/audit/reference data"
```

---

### Task 2: Fastify server bootstrap + health check

**Files:**
- Create: `backend/services/api/src/db.ts`
- Create: `backend/services/api/src/server.ts`
- Test: `backend/services/api/test/server.test.ts`

**Interfaces:**
- Produces: `buildServer(): FastifyInstance` (exported from `src/server.ts`) — every later task's tests use this same factory function rather than importing a running server, so tests don't need a live port.
- Produces: `prisma` (a shared `PrismaClient` singleton exported from `src/db.ts`).

- [ ] **Step 1: Write the failing test**

```typescript
// backend/services/api/test/server.test.ts
import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server';

describe('GET /health', () => {
  it('returns 200 and status ok', async () => {
    const server = buildServer();
    const response = await server.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd backend/services/api && npm test`
Expected: FAIL — `src/server.ts` does not exist.

- [ ] **Step 3: Implement `src/db.ts` and `src/server.ts`**

```typescript
// backend/services/api/src/db.ts
import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();
```

```typescript
// backend/services/api/src/server.ts
import Fastify, { FastifyInstance } from 'fastify';

export function buildServer(): FastifyInstance {
  const server = Fastify({ logger: true });

  server.get('/health', async () => ({ status: 'ok' }));

  return server;
}

if (require.main === module) {
  const server = buildServer();
  server.listen({ port: 4000, host: '0.0.0.0' }).catch((err) => {
    server.log.error(err);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd backend/services/api && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/services/api/src/db.ts backend/services/api/src/server.ts backend/services/api/test/server.test.ts
git commit -m "feat: add Fastify server bootstrap with health check"
```

---

### Task 3: Session tokens + RBAC middleware

**Files:**
- Create: `backend/services/api/src/auth/session.ts`
- Create: `backend/services/api/src/rbac/policy.ts`
- Modify: `backend/services/api/src/server.ts` (register an authenticated test route used only by the test)
- Test: `backend/services/api/test/auth/session.test.ts`, `backend/services/api/test/rbac/policy.test.ts`

**Interfaces:**
- Consumes: none (this is the first identity primitive; Task 4's OIDC callback calls `issueSessionToken` from here).
- Produces: `issueSessionToken(user: { id: string; tenantId: string; role: string }): string`, `verifySessionToken(token: string): { userId: string; tenantId: string; role: string } | null`, `requireRole(role: string)` (a Fastify `preHandler`). Phase 2's token-exchange work and every tenant-scoped route added in later slices use `verifySessionToken`/`requireRole` — do not introduce a second auth mechanism.

- [ ] **Step 1: Write the failing session tests**

```typescript
// backend/services/api/test/auth/session.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import { issueSessionToken, verifySessionToken } from '../../src/auth/session';

beforeAll(() => {
  process.env.SESSION_JWT_SECRET = 'test-secret';
});

describe('session tokens', () => {
  it('issues a token that verifies back to the same claims', () => {
    const token = issueSessionToken({ id: 'user-1', tenantId: 'tenant-1', role: 'employee' });
    const claims = verifySessionToken(token);
    expect(claims).toEqual({ userId: 'user-1', tenantId: 'tenant-1', role: 'employee' });
  });

  it('returns null for a tampered token', () => {
    const token = issueSessionToken({ id: 'user-1', tenantId: 'tenant-1', role: 'employee' });
    expect(verifySessionToken(token + 'tampered')).toBe(null);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd backend/services/api && npm test`
Expected: FAIL — `src/auth/session.ts` does not exist.

- [ ] **Step 3: Implement `src/auth/session.ts`**

```typescript
// backend/services/api/src/auth/session.ts
import jwt from 'jsonwebtoken';

export interface SessionClaims {
  userId: string;
  tenantId: string;
  role: string;
}

export function issueSessionToken(user: { id: string; tenantId: string; role: string }): string {
  const secret = process.env.SESSION_JWT_SECRET;
  if (!secret) throw new Error('SESSION_JWT_SECRET is not configured');
  return jwt.sign({ userId: user.id, tenantId: user.tenantId, role: user.role }, secret, { expiresIn: '8h' });
}

export function verifySessionToken(token: string): SessionClaims | null {
  const secret = process.env.SESSION_JWT_SECRET;
  if (!secret) throw new Error('SESSION_JWT_SECRET is not configured');
  try {
    const decoded = jwt.verify(token, secret) as jwt.JwtPayload;
    return { userId: decoded.userId, tenantId: decoded.tenantId, role: decoded.role };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run and confirm the session tests pass**

Run: `cd backend/services/api && npm test`
Expected: PASS

- [ ] **Step 5: Write the failing RBAC test**

```typescript
// backend/services/api/test/rbac/policy.test.ts
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { requireRole } from '../../src/rbac/policy';
import { issueSessionToken } from '../../src/auth/session';

describe('requireRole', () => {
  it('allows a request whose session role matches', async () => {
    process.env.SESSION_JWT_SECRET = 'test-secret';
    const server = Fastify();
    server.get('/admin-only', { preHandler: requireRole('tenant_admin') }, async () => ({ ok: true }));
    const token = issueSessionToken({ id: 'u1', tenantId: 't1', role: 'tenant_admin' });

    const response = await server.inject({ method: 'GET', url: '/admin-only', headers: { authorization: `Bearer ${token}` } });
    expect(response.statusCode).toBe(200);
  });

  it('rejects a request whose session role does not match', async () => {
    process.env.SESSION_JWT_SECRET = 'test-secret';
    const server = Fastify();
    server.get('/admin-only', { preHandler: requireRole('tenant_admin') }, async () => ({ ok: true }));
    const token = issueSessionToken({ id: 'u1', tenantId: 't1', role: 'employee' });

    const response = await server.inject({ method: 'GET', url: '/admin-only', headers: { authorization: `Bearer ${token}` } });
    expect(response.statusCode).toBe(403);
  });

  it('rejects a request with no token', async () => {
    process.env.SESSION_JWT_SECRET = 'test-secret';
    const server = Fastify();
    server.get('/admin-only', { preHandler: requireRole('tenant_admin') }, async () => ({ ok: true }));

    const response = await server.inject({ method: 'GET', url: '/admin-only' });
    expect(response.statusCode).toBe(401);
  });
});
```

- [ ] **Step 6: Run and confirm failure**

Run: `cd backend/services/api && npm test`
Expected: FAIL — `src/rbac/policy.ts` does not exist.

- [ ] **Step 7: Implement `src/rbac/policy.ts`**

```typescript
// backend/services/api/src/rbac/policy.ts
import { FastifyReply, FastifyRequest } from 'fastify';
import { verifySessionToken } from '../auth/session';

export function requireRole(role: string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      reply.code(401).send({ error: 'Missing bearer token' });
      return;
    }
    const claims = verifySessionToken(header.slice('Bearer '.length));
    if (!claims) {
      reply.code(401).send({ error: 'Invalid or expired token' });
      return;
    }
    if (claims.role !== role) {
      reply.code(403).send({ error: 'Insufficient role' });
      return;
    }
    (request as FastifyRequest & { session: typeof claims }).session = claims;
  };
}
```

- [ ] **Step 8: Run all backend tests and confirm they pass**

Run: `cd backend/services/api && npm test`
Expected: PASS (all tests across Tasks 2-3)

- [ ] **Step 9: Commit**

```bash
git add backend/services/api/src/auth/session.ts backend/services/api/src/rbac/policy.ts backend/services/api/test/auth backend/services/api/test/rbac
git commit -m "feat: add session JWT issuance/verification and role-based route guard"
```

---

### Task 4: Audit log module

**Files:**
- Create: `backend/services/api/src/audit/log.ts`
- Test: `backend/services/api/test/audit/log.test.ts`

**Interfaces:**
- Consumes: `prisma` from `src/db.ts` (Task 2).
- Produces: `writeAuditLog({ tenantId, actor, action, scope }): Promise<void>`. Every route added in this phase and later phases that reads or writes tenant data must call this — Task 5's sync job and Task 6/7's admin routes all call it.

- [ ] **Step 1: Write the failing test**

```typescript
// backend/services/api/test/audit/log.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { prisma } from '../../src/db';
import { writeAuditLog } from '../../src/audit/log';

describe('writeAuditLog', () => {
  let tenantId: string;

  beforeEach(async () => {
    await prisma.auditLog.deleteMany();
    await prisma.user.deleteMany();
    await prisma.tenant.deleteMany();
    const tenant = await prisma.tenant.create({ data: { name: 'Acme', oracleBaseUrl: 'https://acme.example.com' } });
    tenantId = tenant.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('persists an audit log row with the given fields', async () => {
    await writeAuditLog({ tenantId, actor: 'user-1', action: 'reference_sync', scope: 'departments' });
    const rows = await prisma.auditLog.findMany({ where: { tenantId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenantId, actor: 'user-1', action: 'reference_sync', scope: 'departments' });
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd backend/services/api && npm test`
Expected: FAIL — `src/audit/log.ts` does not exist. (Requires the Task 1 Postgres container running and `DATABASE_URL` set — this test hits a real test database, not a mock, per the spec's emphasis on the audit log being a real compliance control.)

- [ ] **Step 3: Implement `src/audit/log.ts`**

```typescript
// backend/services/api/src/audit/log.ts
import { prisma } from '../db';

export async function writeAuditLog(entry: { tenantId: string | null; actor: string; action: string; scope: string }): Promise<void> {
  await prisma.auditLog.create({ data: entry });
}
```

- [ ] **Step 4: Run and confirm it passes**

Run: `cd backend/services/api && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/services/api/src/audit/log.ts backend/services/api/test/audit
git commit -m "feat: add immutable audit log writer"
```

---

### Task 5: Reference-data sync job (departments) + scheduler

**Files:**
- Create: `backend/services/api/src/sync/oracle-client.ts`
- Create: `backend/services/api/src/sync/jobs/departments.ts`
- Create: `backend/services/api/src/sync/scheduler.ts`
- Test: `backend/services/api/test/sync/jobs/departments.test.ts`

**Interfaces:**
- Consumes: `prisma` (Task 2), `writeAuditLog` (Task 4).
- Produces: `runDepartmentSync(tenantId: string): Promise<{ count: number }>`, `startScheduler(): void`. Later reference-data categories (locations, jobs, grades, positions — per spec Section 5.1) follow the same `run<Category>Sync(tenantId)` naming and are added as their own follow-on tasks once this first one is proven.

- [ ] **Step 1: Write the failing test, mocking the Oracle HTTP call**

```typescript
// backend/services/api/test/sync/jobs/departments.test.ts
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { prisma } from '../../../src/db';
import { runDepartmentSync } from '../../../src/sync/jobs/departments';

describe('runDepartmentSync', () => {
  let tenantId: string;

  beforeEach(async () => {
    await prisma.auditLog.deleteMany();
    await prisma.referenceRecord.deleteMany();
    await prisma.user.deleteMany();
    await prisma.tenant.deleteMany();
    const tenant = await prisma.tenant.create({
      data: { name: 'Acme', oracleBaseUrl: 'https://acme.example.com', oracleServiceUser: 'svc', oracleServicePass: 'plaintext-in-slice-1' },
    });
    tenantId = tenant.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('fetches departments from Oracle and upserts them as ReferenceRecord rows', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [{ DepartmentId: '100', Name: 'Engineering' }, { DepartmentId: '200', Name: 'Sales' }] }),
    }) as unknown as typeof fetch;

    const result = await runDepartmentSync(tenantId);
    expect(result.count).toBe(2);

    const rows = await prisma.referenceRecord.findMany({ where: { tenantId, category: 'department' } });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.externalId).sort()).toEqual(['100', '200']);

    const auditRows = await prisma.auditLog.findMany({ where: { tenantId, action: 'reference_sync' } });
    expect(auditRows).toHaveLength(1);
  });

  it('throws if the tenant has no Oracle connection configured', async () => {
    const unconfigured = await prisma.tenant.create({ data: { name: 'NoOracle', oracleBaseUrl: '' } });
    await expect(runDepartmentSync(unconfigured.id)).rejects.toThrow('Oracle connection not configured');
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd backend/services/api && npm test`
Expected: FAIL — `src/sync/jobs/departments.ts` does not exist.

- [ ] **Step 3: Implement the Oracle client helper**

```typescript
// backend/services/api/src/sync/oracle-client.ts
export interface TenantOracleConfig {
  oracleBaseUrl: string;
  oracleServiceUser: string | null;
  oracleServicePass: string | null;
}

export async function fetchOracleResource(tenant: TenantOracleConfig, resourcePath: string): Promise<{ items: Record<string, unknown>[] }> {
  if (!tenant.oracleBaseUrl || !tenant.oracleServiceUser || !tenant.oracleServicePass) {
    throw new Error('Oracle connection not configured');
  }
  const url = `${tenant.oracleBaseUrl}/hcmRestApi/resources/11.13.18.05${resourcePath}`;
  const auth = 'Basic ' + Buffer.from(`${tenant.oracleServiceUser}:${tenant.oracleServicePass}`).toString('base64');
  const response = await fetch(url, { headers: { Authorization: auth, Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Oracle API error ${response.status} for ${resourcePath}`);
  return response.json() as Promise<{ items: Record<string, unknown>[] }>;
}
```

- [ ] **Step 4: Implement the departments sync job**

```typescript
// backend/services/api/src/sync/jobs/departments.ts
import { prisma } from '../../db';
import { writeAuditLog } from '../../audit/log';
import { fetchOracleResource } from '../oracle-client';

export async function runDepartmentSync(tenantId: string): Promise<{ count: number }> {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  const { items } = await fetchOracleResource(tenant, '/departments?onlyData=true&limit=200');

  for (const item of items) {
    const externalId = String(item.DepartmentId ?? item.Name);
    await prisma.referenceRecord.upsert({
      where: { id: `${tenantId}:department:${externalId}` },
      create: { id: `${tenantId}:department:${externalId}`, tenantId, category: 'department', externalId, data: item },
      update: { data: item, syncedAt: new Date() },
    });
  }

  await writeAuditLog({ tenantId, actor: 'system:sync-scheduler', action: 'reference_sync', scope: 'department' });
  return { count: items.length };
}
```

- [ ] **Step 5: Run and confirm the tests pass**

Run: `cd backend/services/api && npm test`
Expected: PASS

- [ ] **Step 6: Add the scheduler**

```typescript
// backend/services/api/src/sync/scheduler.ts
import cron from 'node-cron';
import { prisma } from '../db';
import { runDepartmentSync } from './jobs/departments';

export function startScheduler(): void {
  cron.schedule('0 * * * *', async () => {
    const tenants = await prisma.tenant.findMany({ where: { oracleBaseUrl: { not: '' } } });
    for (const tenant of tenants) {
      try {
        await runDepartmentSync(tenant.id);
      } catch (err) {
        console.error(`Department sync failed for tenant ${tenant.id}:`, err);
      }
    }
  });
}
```

Wire it into `src/server.ts`'s `if (require.main === module)` block, calling `startScheduler()` alongside `server.listen(...)`.

- [ ] **Step 7: Commit**

```bash
git add backend/services/api/src/sync
git add backend/services/api/test/sync
git commit -m "feat: add Oracle department reference-data sync job and hourly scheduler"
```

---

### Task 6: Platform admin console (minimal: create tenant)

**Files:**
- Create: `backend/apps/platform-admin/` (scaffolded via `create-next-app`)
- Create: `backend/services/api/src/routes/platform-admin.ts`
- Test: `backend/services/api/test/routes/platform-admin.test.ts`

**Interfaces:**
- Consumes: `requireRole` is not used here — platform-admin auth is separate from tenant RBAC per spec Section 5.2; this task adds a parallel `requirePlatformAdmin` guard.
- Produces: `POST /platform/tenants` (creates a tenant), `GET /platform/tenants` (lists tenants) — the tenant-admin console (Task 7) and Phase 2's desktop OIDC cutover both depend on tenants existing via this route.

- [ ] **Step 1: Write the failing route test**

```typescript
// backend/services/api/test/routes/platform-admin.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { buildServer } from '../../src/server';
import { prisma } from '../../src/db';

describe('platform admin tenant routes', () => {
  let token: string;

  beforeEach(async () => {
    await prisma.tenant.deleteMany();
    await prisma.platformAdmin.deleteMany();
    process.env.SESSION_JWT_SECRET = 'test-secret';
    const passwordHash = await bcrypt.hash('correct-horse-battery-staple', 10);
    await prisma.platformAdmin.create({ data: { email: 'admin@eqint.example', passwordHash } });

    const server = buildServer();
    const loginResponse = await server.inject({
      method: 'POST',
      url: '/platform/login',
      payload: { email: 'admin@eqint.example', password: 'correct-horse-battery-staple' },
    });
    token = loginResponse.json().token;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('rejects tenant creation without a valid platform-admin token', async () => {
    const server = buildServer();
    const response = await server.inject({ method: 'POST', url: '/platform/tenants', payload: { name: 'Acme', oracleBaseUrl: 'https://acme.example.com' } });
    expect(response.statusCode).toBe(401);
  });

  it('creates and lists a tenant for an authenticated platform admin', async () => {
    const server = buildServer();
    const createResponse = await server.inject({
      method: 'POST',
      url: '/platform/tenants',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Acme', oracleBaseUrl: 'https://acme.example.com' },
    });
    expect(createResponse.statusCode).toBe(201);

    const listResponse = await server.inject({ method: 'GET', url: '/platform/tenants', headers: { authorization: `Bearer ${token}` } });
    const tenants = listResponse.json();
    expect(tenants).toHaveLength(1);
    expect(tenants[0].name).toBe('Acme');
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd backend/services/api && npm install bcrypt @types/bcrypt && npm test`
Expected: FAIL — `/platform/login` and `/platform/tenants` routes don't exist.

- [ ] **Step 3: Implement the platform-admin routes**

```typescript
// backend/services/api/src/routes/platform-admin.ts
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { prisma } from '../db';
import { writeAuditLog } from '../audit/log';

async function requirePlatformAdmin(request: FastifyRequest, reply: FastifyReply) {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return reply.code(401).send({ error: 'Missing bearer token' });
  try {
    const decoded = jwt.verify(header.slice('Bearer '.length), process.env.SESSION_JWT_SECRET!) as jwt.JwtPayload;
    if (decoded.kind !== 'platform_admin') return reply.code(401).send({ error: 'Invalid token' });
    (request as FastifyRequest & { platformAdminEmail: string }).platformAdminEmail = decoded.email;
  } catch {
    return reply.code(401).send({ error: 'Invalid or expired token' });
  }
}

export function registerPlatformAdminRoutes(server: FastifyInstance): void {
  server.post<{ Body: { email: string; password: string } }>('/platform/login', async (request, reply) => {
    const { email, password } = request.body;
    const admin = await prisma.platformAdmin.findUnique({ where: { email } });
    if (!admin || !(await bcrypt.compare(password, admin.passwordHash))) {
      return reply.code(401).send({ error: 'Invalid credentials' });
    }
    const token = jwt.sign({ kind: 'platform_admin', email }, process.env.SESSION_JWT_SECRET!, { expiresIn: '4h' });
    return { token };
  });

  server.post<{ Body: { name: string; oracleBaseUrl: string } }>(
    '/platform/tenants',
    { preHandler: requirePlatformAdmin },
    async (request, reply) => {
      const tenant = await prisma.tenant.create({ data: request.body });
      await writeAuditLog({ tenantId: tenant.id, actor: (request as FastifyRequest & { platformAdminEmail: string }).platformAdminEmail, action: 'tenant_created', scope: 'platform' });
      reply.code(201);
      return tenant;
    }
  );

  server.get('/platform/tenants', { preHandler: requirePlatformAdmin }, async () => {
    return prisma.tenant.findMany();
  });
}
```

Register it in `src/server.ts`'s `buildServer()`, after the `/health` route: `registerPlatformAdminRoutes(server);`

- [ ] **Step 4: Run and confirm the tests pass**

Run: `cd backend/services/api && npm test`
Expected: PASS

- [ ] **Step 5: Scaffold the Next.js platform-admin app**

```bash
cd backend/apps && npx create-next-app@14 platform-admin --typescript --app --no-tailwind --eslint --src-dir --import-alias "@/*" --use-npm
```

- [ ] **Step 6: Add a minimal tenant-list page calling the API**

```typescript
// backend/apps/platform-admin/src/app/tenants/page.tsx
'use client';
import { useEffect, useState } from 'react';

interface Tenant { id: string; name: string; oracleBaseUrl: string; }

export default function TenantsPage() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [token, setToken] = useState('');

  useEffect(() => {
    const stored = window.localStorage.getItem('platform_admin_token');
    if (stored) setToken(stored);
  }, []);

  useEffect(() => {
    if (!token) return;
    fetch(`${process.env.NEXT_PUBLIC_API_BASE_URL}/platform/tenants`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => res.json())
      .then(setTenants);
  }, [token]);

  return (
    <main>
      <h1>Tenants</h1>
      <ul>
        {tenants.map((t) => (
          <li key={t.id}>{t.name} — {t.oracleBaseUrl}</li>
        ))}
      </ul>
    </main>
  );
}
```

Add `NEXT_PUBLIC_API_BASE_URL=http://localhost:4000` to `backend/apps/platform-admin/.env.local`.

- [ ] **Step 7: Commit**

```bash
git add backend/services/api/src/routes/platform-admin.ts backend/services/api/test/routes/platform-admin.test.ts backend/services/api/package.json backend/services/api/package-lock.json backend/services/api/src/server.ts
git add backend/apps/platform-admin
git commit -m "feat: add platform-admin login/tenant routes and minimal tenant-list console page"
```

---

### Task 7: Tenant admin console (minimal: configure Oracle connection)

**Files:**
- Create: `backend/apps/tenant-admin/` (scaffolded via `create-next-app`)
- Create: `backend/services/api/src/routes/tenant-admin.ts`
- Test: `backend/services/api/test/routes/tenant-admin.test.ts`

**Interfaces:**
- Consumes: `requireRole('tenant_admin')` from Task 3.
- Produces: `PATCH /tenants/:tenantId/oracle-connection` — Phase 2's IDCS/OAuth app-registration fields extend this same route's payload rather than introducing a second endpoint.

- [ ] **Step 1: Write the failing route test**

```typescript
// backend/services/api/test/routes/tenant-admin.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { buildServer } from '../../src/server';
import { prisma } from '../../src/db';
import { issueSessionToken } from '../../src/auth/session';

describe('PATCH /tenants/:tenantId/oracle-connection', () => {
  let tenantId: string;
  let adminToken: string;
  let otherTenantAdminToken: string;

  beforeEach(async () => {
    process.env.SESSION_JWT_SECRET = 'test-secret';
    await prisma.user.deleteMany();
    await prisma.tenant.deleteMany();
    const tenant = await prisma.tenant.create({ data: { name: 'Acme', oracleBaseUrl: '' } });
    tenantId = tenant.id;
    const otherTenant = await prisma.tenant.create({ data: { name: 'Globex', oracleBaseUrl: '' } });

    adminToken = issueSessionToken({ id: 'admin-1', tenantId, role: 'tenant_admin' });
    otherTenantAdminToken = issueSessionToken({ id: 'admin-2', tenantId: otherTenant.id, role: 'tenant_admin' });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('updates the Oracle connection for the admin\'s own tenant', async () => {
    const server = buildServer();
    const response = await server.inject({
      method: 'PATCH',
      url: `/tenants/${tenantId}/oracle-connection`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { oracleBaseUrl: 'https://acme.example.com', oracleServiceUser: 'svc-acme', oracleServicePass: 'super-secret' },
    });
    expect(response.statusCode).toBe(200);

    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    expect(tenant.oracleBaseUrl).toBe('https://acme.example.com');
    expect(tenant.oracleServicePass).not.toBe('super-secret'); // encrypted, not stored raw
  });

  it('rejects an update targeting a different tenant', async () => {
    const server = buildServer();
    const response = await server.inject({
      method: 'PATCH',
      url: `/tenants/${tenantId}/oracle-connection`,
      headers: { authorization: `Bearer ${otherTenantAdminToken}` },
      payload: { oracleBaseUrl: 'https://malicious.example.com' },
    });
    expect(response.statusCode).toBe(403);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd backend/services/api && npm test`
Expected: FAIL — the route doesn't exist.

- [ ] **Step 3: Add a field-encryption helper (stand-in for Phase 3's KMS integration)**

```typescript
// backend/services/api/src/security/field-encryption.ts
import crypto from 'crypto';

function getKey(): Buffer {
  const key = process.env.FIELD_ENCRYPTION_KEY;
  if (!key) throw new Error('FIELD_ENCRYPTION_KEY is not configured');
  return Buffer.from(key, 'base64');
}

export function encryptField(value: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

export function decryptField(value: string): string {
  const raw = Buffer.from(value, 'base64');
  const iv = raw.subarray(0, 12);
  const authTag = raw.subarray(12, 28);
  const encrypted = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}
```

Set a real 32-byte base64 key in `.env` for local dev/test, e.g. generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` and put it in `FIELD_ENCRYPTION_KEY`.

- [ ] **Step 4: Implement the tenant-admin route**

```typescript
// backend/services/api/src/routes/tenant-admin.ts
import { FastifyInstance, FastifyRequest } from 'fastify';
import { requireRole } from '../rbac/policy';
import { prisma } from '../db';
import { writeAuditLog } from '../audit/log';
import { encryptField } from '../security/field-encryption';
import { SessionClaims } from '../auth/session';

export function registerTenantAdminRoutes(server: FastifyInstance): void {
  server.patch<{ Params: { tenantId: string }; Body: { oracleBaseUrl: string; oracleServiceUser?: string; oracleServicePass?: string } }>(
    '/tenants/:tenantId/oracle-connection',
    { preHandler: requireRole('tenant_admin') },
    async (request, reply) => {
      const session = (request as FastifyRequest & { session: SessionClaims }).session;
      if (session.tenantId !== request.params.tenantId) {
        return reply.code(403).send({ error: 'Cannot modify a different tenant' });
      }

      const data: Record<string, string> = { oracleBaseUrl: request.body.oracleBaseUrl };
      if (request.body.oracleServiceUser) data.oracleServiceUser = request.body.oracleServiceUser;
      if (request.body.oracleServicePass) data.oracleServicePass = encryptField(request.body.oracleServicePass);

      const tenant = await prisma.tenant.update({ where: { id: request.params.tenantId }, data });
      await writeAuditLog({ tenantId: tenant.id, actor: session.userId, action: 'oracle_connection_updated', scope: 'tenant_admin' });
      return tenant;
    }
  );
}
```

Register it in `src/server.ts`: `registerTenantAdminRoutes(server);`

- [ ] **Step 5: Run and confirm tests pass**

Run: `cd backend/services/api && npm test`
Expected: PASS

- [ ] **Step 6: Scaffold the Next.js tenant-admin app**

```bash
cd backend/apps && npx create-next-app@14 tenant-admin --typescript --app --no-tailwind --eslint --src-dir --import-alias "@/*" --use-npm
```

- [ ] **Step 7: Add a minimal Oracle-connection settings form**

```typescript
// backend/apps/tenant-admin/src/app/settings/page.tsx
'use client';
import { useState } from 'react';

export default function OracleSettingsPage() {
  const [oracleBaseUrl, setOracleBaseUrl] = useState('');
  const [oracleServiceUser, setOracleServiceUser] = useState('');
  const [oracleServicePass, setOracleServicePass] = useState('');
  const [status, setStatus] = useState('');

  async function save() {
    const token = window.localStorage.getItem('tenant_admin_token');
    const tenantId = window.localStorage.getItem('tenant_id');
    const response = await fetch(`${process.env.NEXT_PUBLIC_API_BASE_URL}/tenants/${tenantId}/oracle-connection`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ oracleBaseUrl, oracleServiceUser, oracleServicePass }),
    });
    setStatus(response.ok ? 'Saved' : 'Failed to save');
  }

  return (
    <main>
      <h1>Oracle Connection</h1>
      <label>Oracle Base URL <input value={oracleBaseUrl} onChange={(e) => setOracleBaseUrl(e.target.value)} /></label>
      <label>Service Account User <input value={oracleServiceUser} onChange={(e) => setOracleServiceUser(e.target.value)} /></label>
      <label>Service Account Password <input type="password" value={oracleServicePass} onChange={(e) => setOracleServicePass(e.target.value)} /></label>
      <button onClick={save}>Save</button>
      <p>{status}</p>
    </main>
  );
}
```

- [ ] **Step 8: Commit**

```bash
git add backend/services/api/src/routes/tenant-admin.ts backend/services/api/src/security/field-encryption.ts backend/services/api/test/routes/tenant-admin.test.ts backend/services/api/src/server.ts
git add backend/apps/tenant-admin
git commit -m "feat: add tenant-admin Oracle connection route with field-level encryption, minimal console page"
```

---

## Self-Review Notes

- **Spec coverage**: Section 5 target architecture components — auth gateway (Task 3), Postgres data store (Task 1), reference-data sync (Task 5), audit log (Task 4), both admin consoles (Tasks 6-7) — all covered for slice 1. OIDC login (as opposed to the platform-admin's standalone bcrypt login) is intentionally deferred to the Phase 2 plan, since it requires a real IdP to test against and Phase 2 is where desktop identity cutover happens anyway — noted explicitly rather than left ambiguous.
- **Type/interface consistency**: `SessionClaims` (Task 3) is reused verbatim in Task 7's route handler; `writeAuditLog`'s parameter shape (Task 4) is used identically in Tasks 5, 6, and 7.
- **Explicitly out of scope for this slice** (per spec Section 5.1, handled in Phase 2): person-level data sync/token-exchange, and the tenant `oracleServicePass` encryption here uses a local env-var symmetric key rather than a real KMS — Phase 3's plan replaces `src/security/field-encryption.ts`'s key source with a managed KMS call without changing its exported function signatures.
