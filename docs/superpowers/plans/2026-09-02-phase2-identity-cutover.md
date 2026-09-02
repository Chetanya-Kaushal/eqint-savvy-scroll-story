# Phase 2 — Identity Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the desktop client's local Oracle username/password with organization SSO login, and replace direct Oracle REST calls with backend-brokered calls — reference data via the Phase 1 sync cache, person-level data via per-user Oracle token-exchange (native mode) with an explicitly-flagged service-account fallback (degraded mode) for tenants without token-exchange configured.

**Architecture:** Builds directly on `backend/services/api` from the Phase 1 plan. The desktop performs OAuth2 Authorization Code + PKCE directly against the tenant's IdP (no client secret needed — public client flow), obtains an `id_token`, and exchanges it with the backend for a Savvy session JWT (reusing `issueSessionToken`/`verifySessionToken` from Phase 1). The desktop then calls the backend exclusively — `callOracleApi` in the current desktop code and the local `hcm-data.json`/`conversation-history.json` files disappear entirely.

**Tech Stack:** Adds to the Phase 1 backend: `jose` (id_token verification). Adds to the desktop app: `openid-client` (PKCE flow), `keytar` (OS-native credential vault for the session token and SSO id_token).

**Spec:** [docs/superpowers/specs/2026-09-02-enterprise-transformation-design.md](../specs/2026-09-02-enterprise-transformation-design.md), Sections 5.1 (data tiering / token-exchange), 5.2 (identity model), Section 10 Phase 2.

## Global Constraints

- Reuses `issueSessionToken`/`verifySessionToken` from [backend/services/api/src/auth/session.ts](../../../backend/services/api/src/auth/session.ts) (Phase 1 Task 3) — no second session-token mechanism.
- Reuses `writeAuditLog` from [backend/services/api/src/audit/log.ts](../../../backend/services/api/src/audit/log.ts) (Phase 1 Task 4) — every new route in this phase logs.
- Reuses `encryptField`/`decryptField` from [backend/services/api/src/security/field-encryption.ts](../../../backend/services/api/src/security/field-encryption.ts) (Phase 1 Task 7) for any new secret tenant fields — no second encryption helper.
- The desktop must never persist an Oracle username/password again once this phase is complete — the `oraclePass`/`oracleUser` settings fields and their `safeStorage` encryption from the Phase 0 plan are removed, not just hidden.
- Per spec Section 5.1: person-level Oracle data access must attempt native per-user token-exchange first; falling back to the tenant's service account is allowed only when token-exchange isn't configured for that tenant, and every such fallback request must be audit-logged with `scope` prefixed `degraded_service_account:`.

---

### Task 1: Tenant OIDC + token-exchange configuration

**Files:**
- Modify: `backend/services/api/prisma/schema.prisma` (add fields to `Tenant`)
- Modify: `backend/services/api/src/routes/tenant-admin.ts` (Phase 1 Task 7 — add a second route)
- Test: `backend/services/api/test/routes/tenant-admin.test.ts` (add cases)

**Interfaces:**
- Produces: `Tenant.oidcIssuerUrl`, `Tenant.oidcClientId`, `Tenant.oidcRedirectUri`, `Tenant.oidcTokenExchangeClientId`, `Tenant.oidcTokenExchangeClientSecret` (encrypted). Tasks 2-4 read these exact field names.

- [ ] **Step 1: Add the fields to the Prisma schema**

Add to the `Tenant` model in `backend/services/api/prisma/schema.prisma` (alongside the existing `oracleBaseUrl`/`oracleServiceUser`/`oracleServicePass` fields):
```prisma
  oidcIssuerUrl                String?
  oidcClientId                 String?
  oidcRedirectUri              String?
  oidcTokenExchangeClientId    String?
  oidcTokenExchangeClientSecret String?  // encrypted at the application layer, same as oracleServicePass
```

```bash
cd backend/services/api && npx prisma migrate dev --name add_oidc_config
```

- [ ] **Step 2: Write the failing test for the new tenant-admin route**

Add to `backend/services/api/test/routes/tenant-admin.test.ts`:
```typescript
describe('PATCH /tenants/:tenantId/oidc-config', () => {
  it('updates the OIDC config for the admin\'s own tenant, encrypting the token-exchange secret', async () => {
    const server = buildServer();
    const response = await server.inject({
      method: 'PATCH',
      url: `/tenants/${tenantId}/oidc-config`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        oidcIssuerUrl: 'https://idp.acme.example.com',
        oidcClientId: 'savvy-desktop',
        oidcRedirectUri: 'http://127.0.0.1:8734/callback',
        oidcTokenExchangeClientId: 'savvy-token-exchange',
        oidcTokenExchangeClientSecret: 'idp-issued-secret',
      },
    });
    expect(response.statusCode).toBe(200);

    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    expect(tenant.oidcIssuerUrl).toBe('https://idp.acme.example.com');
    expect(tenant.oidcTokenExchangeClientSecret).not.toBe('idp-issued-secret');
  });
});
```

- [ ] **Step 3: Run and confirm failure**

Run: `cd backend/services/api && npm test`
Expected: FAIL — the route doesn't exist yet.

- [ ] **Step 4: Add the route to `backend/services/api/src/routes/tenant-admin.ts`**

```typescript
  server.patch<{
    Params: { tenantId: string };
    Body: {
      oidcIssuerUrl: string;
      oidcClientId: string;
      oidcRedirectUri: string;
      oidcTokenExchangeClientId?: string;
      oidcTokenExchangeClientSecret?: string;
    };
  }>('/tenants/:tenantId/oidc-config', { preHandler: requireRole('tenant_admin') }, async (request, reply) => {
    const session = (request as FastifyRequest & { session: SessionClaims }).session;
    if (session.tenantId !== request.params.tenantId) {
      return reply.code(403).send({ error: 'Cannot modify a different tenant' });
    }
    const { oidcTokenExchangeClientSecret, ...rest } = request.body;
    const data: Record<string, string> = { ...rest };
    if (oidcTokenExchangeClientSecret) data.oidcTokenExchangeClientSecret = encryptField(oidcTokenExchangeClientSecret);

    const tenant = await prisma.tenant.update({ where: { id: request.params.tenantId }, data });
    await writeAuditLog({ tenantId: tenant.id, actor: session.userId, action: 'oidc_config_updated', scope: 'tenant_admin' });
    return tenant;
  });
```

- [ ] **Step 5: Run and confirm it passes**

Run: `cd backend/services/api && npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add backend/services/api/prisma backend/services/api/src/routes/tenant-admin.ts backend/services/api/test/routes/tenant-admin.test.ts
git commit -m "feat: add tenant OIDC and token-exchange configuration fields and route"
```

---

### Task 2: Verify SSO id_token + `/auth/sso-login` + public OIDC config lookup

**Files:**
- Create: `backend/services/api/src/auth/sso.ts`
- Create: `backend/services/api/src/routes/auth.ts`
- Modify: `backend/services/api/src/server.ts` (register the new routes)
- Modify: `backend/services/api/package.json` (add `jose` dependency)
- Test: `backend/services/api/test/auth/sso.test.ts`, `backend/services/api/test/routes/auth.test.ts`

**Interfaces:**
- Consumes: `issueSessionToken` (Phase 1 Task 3), `writeAuditLog` (Phase 1 Task 4).
- Produces: `verifyTenantIdToken(tenantId, idToken): Promise<{ sub: string; email: string }>`. `POST /auth/sso-login`, `GET /tenants/:tenantId/oidc-config` (public, no auth). The desktop's Task 5 calls both these routes by exact path.

- [ ] **Step 1: Add the `jose` dependency**

```bash
cd backend/services/api && npm install jose
```

- [ ] **Step 2: Write the failing id_token verification test**

```typescript
// backend/services/api/test/auth/sso.test.ts
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { generateKeyPair, SignJWT, exportJWK } from 'jose';
import { prisma } from '../../src/db';
import { verifyTenantIdToken } from '../../src/auth/sso';

describe('verifyTenantIdToken', () => {
  let tenantId: string;
  let privateKey: CryptoKey;
  let publicJwk: Record<string, unknown>;

  beforeEach(async () => {
    await prisma.user.deleteMany();
    await prisma.tenant.deleteMany();
    const tenant = await prisma.tenant.create({
      data: { name: 'Acme', oracleBaseUrl: '', oidcIssuerUrl: 'https://idp.acme.test', oidcClientId: 'savvy-desktop' },
    });
    tenantId = tenant.id;

    const { publicKey, privateKey: pk } = await generateKeyPair('RS256');
    privateKey = pk;
    publicJwk = { ...(await exportJWK(publicKey)), alg: 'RS256', use: 'sig', kid: 'test-key-1' };

    global.fetch = vi.fn(async (url: string) => {
      if (url === 'https://idp.acme.test/.well-known/openid-configuration') {
        return { ok: true, json: async () => ({ issuer: 'https://idp.acme.test', jwks_uri: 'https://idp.acme.test/jwks' }) } as Response;
      }
      if (url === 'https://idp.acme.test/jwks') {
        return { ok: true, json: async () => ({ keys: [publicJwk] }) } as Response;
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('verifies a correctly-signed id_token and returns sub/email', async () => {
    const idToken = await new SignJWT({ email: 'jane@acme.test' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setIssuer('https://idp.acme.test')
      .setAudience('savvy-desktop')
      .setSubject('sso-subject-123')
      .setExpirationTime('5m')
      .sign(privateKey);

    const claims = await verifyTenantIdToken(tenantId, idToken);
    expect(claims).toEqual({ sub: 'sso-subject-123', email: 'jane@acme.test' });
  });

  it('rejects a token signed for a different audience', async () => {
    const idToken = await new SignJWT({ email: 'jane@acme.test' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setIssuer('https://idp.acme.test')
      .setAudience('some-other-client')
      .setSubject('sso-subject-123')
      .setExpirationTime('5m')
      .sign(privateKey);

    await expect(verifyTenantIdToken(tenantId, idToken)).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run and confirm failure**

Run: `cd backend/services/api && npm test`
Expected: FAIL — `src/auth/sso.ts` does not exist.

- [ ] **Step 4: Implement `src/auth/sso.ts`**

```typescript
// backend/services/api/src/auth/sso.ts
import { importJWK, jwtVerify, JWK } from 'jose';
import { prisma } from '../db';

export async function verifyTenantIdToken(tenantId: string, idToken: string): Promise<{ sub: string; email: string }> {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  if (!tenant.oidcIssuerUrl || !tenant.oidcClientId) {
    throw new Error('OIDC not configured for this tenant');
  }

  const discovery = (await fetch(`${tenant.oidcIssuerUrl}/.well-known/openid-configuration`).then((r) => r.json())) as {
    issuer: string;
    jwks_uri: string;
  };
  const jwks = (await fetch(discovery.jwks_uri).then((r) => r.json())) as { keys: JWK[] };
  const key = await importJWK(jwks.keys[0], 'RS256');

  const { payload } = await jwtVerify(idToken, key, { issuer: discovery.issuer, audience: tenant.oidcClientId });
  if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') {
    throw new Error('id_token missing sub or email claim');
  }
  return { sub: payload.sub, email: payload.email };
}
```

- [ ] **Step 5: Run and confirm the `sso.test.ts` tests pass**

Run: `cd backend/services/api && npm test`
Expected: PASS

- [ ] **Step 6: Write the failing route test**

```typescript
// backend/services/api/test/routes/auth.test.ts
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { generateKeyPair, SignJWT, exportJWK } from 'jose';
import jwt from 'jsonwebtoken';
import { buildServer } from '../../src/server';
import { prisma } from '../../src/db';

describe('auth routes', () => {
  let tenantId: string;
  let privateKey: CryptoKey;

  beforeEach(async () => {
    process.env.SESSION_JWT_SECRET = 'test-secret';
    await prisma.user.deleteMany();
    await prisma.tenant.deleteMany();
    const tenant = await prisma.tenant.create({
      data: {
        name: 'Acme', oracleBaseUrl: '',
        oidcIssuerUrl: 'https://idp.acme.test', oidcClientId: 'savvy-desktop', oidcRedirectUri: 'http://127.0.0.1:8734/callback',
      },
    });
    tenantId = tenant.id;

    const { publicKey, privateKey: pk } = await generateKeyPair('RS256');
    privateKey = pk;
    const publicJwk = { ...(await exportJWK(publicKey)), alg: 'RS256', use: 'sig', kid: 'test-key-1' };

    global.fetch = vi.fn(async (url: string) => {
      if (url === 'https://idp.acme.test/.well-known/openid-configuration') {
        return { ok: true, json: async () => ({ issuer: 'https://idp.acme.test', jwks_uri: 'https://idp.acme.test/jwks' }) } as Response;
      }
      if (url === 'https://idp.acme.test/jwks') {
        return { ok: true, json: async () => ({ keys: [publicJwk] }) } as Response;
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('GET /tenants/:tenantId/oidc-config returns public OIDC settings with no auth required', async () => {
    const server = buildServer();
    const response = await server.inject({ method: 'GET', url: `/tenants/${tenantId}/oidc-config` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      issuerUrl: 'https://idp.acme.test', clientId: 'savvy-desktop', redirectUri: 'http://127.0.0.1:8734/callback',
    });
  });

  it('POST /auth/sso-login upserts a User and returns a valid session token', async () => {
    const idToken = await new SignJWT({ email: 'jane@acme.test' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setIssuer('https://idp.acme.test').setAudience('savvy-desktop').setSubject('sso-subject-123').setExpirationTime('5m')
      .sign(privateKey);

    const server = buildServer();
    const response = await server.inject({ method: 'POST', url: '/auth/sso-login', payload: { tenantId, idToken } });
    expect(response.statusCode).toBe(200);

    const { token } = response.json();
    const decoded = jwt.verify(token, 'test-secret') as jwt.JwtPayload;
    expect(decoded.tenantId).toBe(tenantId);
    expect(decoded.role).toBe('employee');

    const user = await prisma.user.findUniqueOrThrow({ where: { ssoSubject: 'sso-subject-123' } });
    expect(user.email).toBe('jane@acme.test');
  });

  it('POST /auth/sso-login rejects an invalid id_token', async () => {
    const server = buildServer();
    const response = await server.inject({ method: 'POST', url: '/auth/sso-login', payload: { tenantId, idToken: 'not-a-real-token' } });
    expect(response.statusCode).toBe(401);
  });
});
```

- [ ] **Step 7: Run and confirm failure**

Run: `cd backend/services/api && npm test`
Expected: FAIL — the routes don't exist.

- [ ] **Step 8: Implement `src/routes/auth.ts`**

```typescript
// backend/services/api/src/routes/auth.ts
import { FastifyInstance } from 'fastify';
import { prisma } from '../db';
import { verifyTenantIdToken } from '../auth/sso';
import { issueSessionToken } from '../auth/session';
import { writeAuditLog } from '../audit/log';

export function registerAuthRoutes(server: FastifyInstance): void {
  server.get<{ Params: { tenantId: string } }>('/tenants/:tenantId/oidc-config', async (request, reply) => {
    const tenant = await prisma.tenant.findUnique({ where: { id: request.params.tenantId } });
    if (!tenant?.oidcIssuerUrl || !tenant.oidcClientId || !tenant.oidcRedirectUri) {
      return reply.code(404).send({ error: 'SSO not configured for this tenant' });
    }
    return { issuerUrl: tenant.oidcIssuerUrl, clientId: tenant.oidcClientId, redirectUri: tenant.oidcRedirectUri };
  });

  server.post<{ Body: { tenantId: string; idToken: string } }>('/auth/sso-login', async (request, reply) => {
    const { tenantId, idToken } = request.body;
    let claims;
    try {
      claims = await verifyTenantIdToken(tenantId, idToken);
    } catch {
      return reply.code(401).send({ error: 'Invalid SSO token' });
    }

    const user = await prisma.user.upsert({
      where: { ssoSubject: claims.sub },
      create: { tenantId, ssoSubject: claims.sub, email: claims.email, role: 'employee' },
      update: { email: claims.email },
    });

    const token = issueSessionToken({ id: user.id, tenantId: user.tenantId, role: user.role });
    await writeAuditLog({ tenantId, actor: user.id, action: 'sso_login', scope: 'auth' });
    return { token };
  });
}
```

Register in `src/server.ts`: `registerAuthRoutes(server);`

- [ ] **Step 9: Run and confirm all tests pass**

Run: `cd backend/services/api && npm test`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add backend/services/api/src/auth/sso.ts backend/services/api/src/routes/auth.ts backend/services/api/src/server.ts backend/services/api/package.json backend/services/api/package-lock.json backend/services/api/test/auth/sso.test.ts backend/services/api/test/routes/auth.test.ts
git commit -m "feat: verify SSO id_token and issue Savvy session tokens via /auth/sso-login"
```

---

### Task 3: Authenticated data routes (`requireAuth`, conversation history, reference data)

**Files:**
- Modify: `backend/services/api/src/rbac/policy.ts` (add `requireAuth`, role-agnostic)
- Create: `backend/services/api/src/routes/data.ts`
- Modify: `backend/services/api/src/server.ts`
- Test: `backend/services/api/test/rbac/policy.test.ts` (add case), `backend/services/api/test/routes/data.test.ts`

**Interfaces:**
- Consumes: `verifySessionToken` (Phase 1 Task 3).
- Produces: `requireAuth` preHandler (attaches `request.session`, any role). `GET/PUT /conversation-history`, `GET /reference-data/:category`. The desktop `backend-client.js` in Task 6 calls these exact paths.

- [ ] **Step 1: Write the failing `requireAuth` test**

Add to `backend/services/api/test/rbac/policy.test.ts`:
```typescript
import { requireAuth } from '../../src/rbac/policy';

describe('requireAuth', () => {
  it('allows any authenticated role and attaches session claims', async () => {
    process.env.SESSION_JWT_SECRET = 'test-secret';
    const server = Fastify();
    server.get('/me', { preHandler: requireAuth }, async (request) => (request as any).session);
    const token = issueSessionToken({ id: 'u1', tenantId: 't1', role: 'employee' });

    const response = await server.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${token}` } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ userId: 'u1', tenantId: 't1', role: 'employee' });
  });

  it('rejects a missing token', async () => {
    process.env.SESSION_JWT_SECRET = 'test-secret';
    const server = Fastify();
    server.get('/me', { preHandler: requireAuth }, async (request) => (request as any).session);
    const response = await server.inject({ method: 'GET', url: '/me' });
    expect(response.statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: Run and confirm failure, then implement `requireAuth` in `src/rbac/policy.ts`**

```typescript
export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return reply.code(401).send({ error: 'Missing bearer token' });
  const claims = verifySessionToken(header.slice('Bearer '.length));
  if (!claims) return reply.code(401).send({ error: 'Invalid or expired token' });
  (request as FastifyRequest & { session: typeof claims }).session = claims;
}
```

Run: `cd backend/services/api && npm test` — Expected: PASS.

- [ ] **Step 3: Add a `ConversationEntry` model and migrate**

Add to `backend/services/api/prisma/schema.prisma`:
```prisma
model ConversationEntry {
  id        String   @id @default(uuid())
  userId    String
  role      String   // 'user' | 'bot'
  content   String
  createdAt DateTime @default(now())

  @@index([userId])
}
```

```bash
cd backend/services/api && npx prisma migrate dev --name add_conversation_entries
```

- [ ] **Step 4: Write the failing data-routes test**

```typescript
// backend/services/api/test/routes/data.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { buildServer } from '../../src/server';
import { prisma } from '../../src/db';
import { issueSessionToken } from '../../src/auth/session';

describe('data routes', () => {
  let tenantId: string;
  let userId: string;
  let token: string;

  beforeEach(async () => {
    process.env.SESSION_JWT_SECRET = 'test-secret';
    await prisma.conversationEntry.deleteMany();
    await prisma.referenceRecord.deleteMany();
    await prisma.user.deleteMany();
    await prisma.tenant.deleteMany();
    const tenant = await prisma.tenant.create({ data: { name: 'Acme', oracleBaseUrl: '' } });
    tenantId = tenant.id;
    const user = await prisma.user.create({ data: { tenantId, email: 'jane@acme.test', role: 'employee', ssoSubject: 'sub-1' } });
    userId = user.id;
    token = issueSessionToken({ id: userId, tenantId, role: 'employee' });
    await prisma.referenceRecord.create({ data: { tenantId, category: 'department', externalId: '100', data: { Name: 'Engineering' } } });
  });

  afterAll(async () => { await prisma.$disconnect(); });

  it('PUT then GET /conversation-history round-trips the caller\'s own history', async () => {
    const server = buildServer();
    await server.inject({
      method: 'PUT', url: '/conversation-history', headers: { authorization: `Bearer ${token}` },
      payload: [{ role: 'user', content: 'hello' }, { role: 'bot', content: 'hi there' }],
    });
    const response = await server.inject({ method: 'GET', url: '/conversation-history', headers: { authorization: `Bearer ${token}` } });
    const history = response.json();
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ role: 'user', content: 'hello' });
  });

  it('GET /reference-data/:category returns only the caller\'s tenant records', async () => {
    const server = buildServer();
    const response = await server.inject({ method: 'GET', url: '/reference-data/department', headers: { authorization: `Bearer ${token}` } });
    const records = response.json();
    expect(records).toHaveLength(1);
    expect(records[0].data).toEqual({ Name: 'Engineering' });
  });
});
```

- [ ] **Step 5: Run and confirm failure**

Run: `cd backend/services/api && npm test`
Expected: FAIL — `src/routes/data.ts` does not exist.

- [ ] **Step 6: Implement `src/routes/data.ts`**

```typescript
// backend/services/api/src/routes/data.ts
import { FastifyInstance, FastifyRequest } from 'fastify';
import { requireAuth } from '../rbac/policy';
import { prisma } from '../db';
import { SessionClaims } from '../auth/session';

export function registerDataRoutes(server: FastifyInstance): void {
  server.get('/conversation-history', { preHandler: requireAuth }, async (request) => {
    const session = (request as FastifyRequest & { session: SessionClaims }).session;
    return prisma.conversationEntry.findMany({ where: { userId: session.userId }, orderBy: { createdAt: 'asc' } });
  });

  server.put<{ Body: { role: string; content: string }[] }>('/conversation-history', { preHandler: requireAuth }, async (request) => {
    const session = (request as FastifyRequest & { session: SessionClaims }).session;
    await prisma.conversationEntry.deleteMany({ where: { userId: session.userId } });
    await prisma.conversationEntry.createMany({
      data: request.body.slice(-50).map((entry) => ({ userId: session.userId, role: entry.role, content: entry.content })),
    });
    return { ok: true };
  });

  server.get<{ Params: { category: string } }>('/reference-data/:category', { preHandler: requireAuth }, async (request) => {
    const session = (request as FastifyRequest & { session: SessionClaims }).session;
    return prisma.referenceRecord.findMany({ where: { tenantId: session.tenantId, category: request.params.category } });
  });
}
```

Register in `src/server.ts`: `registerDataRoutes(server);`

- [ ] **Step 7: Run and confirm all tests pass, then commit**

Run: `cd backend/services/api && npm test`
Expected: PASS

```bash
git add backend/services/api/prisma backend/services/api/src/rbac/policy.ts backend/services/api/src/routes/data.ts backend/services/api/src/server.ts backend/services/api/test
git commit -m "feat: add requireAuth guard and conversation-history/reference-data routes"
```

---

### Task 4: Person-level data proxy with token-exchange + degraded fallback

**Files:**
- Create: `backend/services/api/src/auth/token-exchange.ts`
- Modify: `backend/services/api/src/routes/data.ts` (add the proxy route)
- Test: `backend/services/api/test/auth/token-exchange.test.ts`, add cases to `backend/services/api/test/routes/data.test.ts`

**Interfaces:**
- Consumes: `decryptField` (Phase 1 Task 7), `writeAuditLog` (Phase 1 Task 4).
- Produces: `exchangeForOracleAccessToken(tenantId, userIdToken): Promise<string | null>` (returns `null` when the tenant has no token-exchange client configured, signaling the caller to fall back). `ALL /hcm-proxy/*`.

- [ ] **Step 1: Write the failing token-exchange test**

```typescript
// backend/services/api/test/auth/token-exchange.test.ts
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { prisma } from '../../src/db';
import { exchangeForOracleAccessToken } from '../../src/auth/token-exchange';
import { encryptField } from '../../src/security/field-encryption';

describe('exchangeForOracleAccessToken', () => {
  let tenantId: string;

  beforeEach(async () => {
    process.env.FIELD_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    await prisma.user.deleteMany();
    await prisma.tenant.deleteMany();
  });

  afterAll(async () => { await prisma.$disconnect(); });

  it('returns null when the tenant has no token-exchange client configured', async () => {
    const tenant = await prisma.tenant.create({ data: { name: 'Acme', oracleBaseUrl: '', oidcIssuerUrl: 'https://idp.acme.test' } });
    tenantId = tenant.id;
    const result = await exchangeForOracleAccessToken(tenantId, 'some-id-token');
    expect(result).toBe(null);
  });

  it('exchanges the id_token for an Oracle access token when configured', async () => {
    const tenant = await prisma.tenant.create({
      data: {
        name: 'Acme', oracleBaseUrl: '', oidcIssuerUrl: 'https://idp.acme.test',
        oidcTokenExchangeClientId: 'savvy-token-exchange', oidcTokenExchangeClientSecret: encryptField('idp-secret'),
      },
    });
    tenantId = tenant.id;

    global.fetch = vi.fn(async (url: string) => {
      if (url === 'https://idp.acme.test/.well-known/openid-configuration') {
        return { ok: true, json: async () => ({ token_endpoint: 'https://idp.acme.test/token' }) } as Response;
      }
      if (url === 'https://idp.acme.test/token') {
        return { ok: true, json: async () => ({ access_token: 'oracle-access-token-abc' }) } as Response;
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const result = await exchangeForOracleAccessToken(tenantId, 'user-id-token');
    expect(result).toBe('oracle-access-token-abc');
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd backend/services/api && npm test`
Expected: FAIL — `src/auth/token-exchange.ts` does not exist.

- [ ] **Step 3: Implement `src/auth/token-exchange.ts`**

```typescript
// backend/services/api/src/auth/token-exchange.ts
import { prisma } from '../db';
import { decryptField } from '../security/field-encryption';

export async function exchangeForOracleAccessToken(tenantId: string, userIdToken: string): Promise<string | null> {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  if (!tenant.oidcIssuerUrl || !tenant.oidcTokenExchangeClientId || !tenant.oidcTokenExchangeClientSecret) {
    return null;
  }

  const discovery = (await fetch(`${tenant.oidcIssuerUrl}/.well-known/openid-configuration`).then((r) => r.json())) as {
    token_endpoint: string;
  };

  const params = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    subject_token: userIdToken,
    subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
    requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    client_id: tenant.oidcTokenExchangeClientId,
    client_secret: decryptField(tenant.oidcTokenExchangeClientSecret),
  });

  const response = await fetch(discovery.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  if (!response.ok) throw new Error(`Token exchange failed: ${response.status}`);
  const data = (await response.json()) as { access_token: string };
  return data.access_token;
}
```

- [ ] **Step 4: Run and confirm the token-exchange tests pass**

Run: `cd backend/services/api && npm test`
Expected: PASS

- [ ] **Step 5: Write the failing proxy-route tests**

Add to `backend/services/api/test/routes/data.test.ts`:
```typescript
describe('/hcm-proxy/* (native mode)', () => {
  it('uses the exchanged Oracle access token and logs scope "native:"', async () => {
    await prisma.tenant.update({ where: { id: tenantId }, data: { oracleBaseUrl: 'https://acme.example.com', oidcIssuerUrl: 'https://idp.acme.test', oidcTokenExchangeClientId: 'x', oidcTokenExchangeClientSecret: (await import('../../src/security/field-encryption')).encryptField('secret') } });

    global.fetch = vi.fn(async (url: string) => {
      if (url === 'https://idp.acme.test/.well-known/openid-configuration') return { ok: true, json: async () => ({ token_endpoint: 'https://idp.acme.test/token' }) } as Response;
      if (url === 'https://idp.acme.test/token') return { ok: true, json: async () => ({ access_token: 'oracle-token' }) } as Response;
      if (url === 'https://acme.example.com/hcmRestApi/resources/11.13.18.05/absences') return { ok: true, status: 200, json: async () => ({ items: [] }) } as Response;
      throw new Error(`Unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const server = buildServer();
    const response = await server.inject({
      method: 'GET', url: '/hcm-proxy/absences',
      headers: { authorization: `Bearer ${token}`, 'x-sso-id-token': 'user-id-token' },
    });
    expect(response.statusCode).toBe(200);

    const logs = await prisma.auditLog.findMany({ where: { action: 'hcm_proxy_read' } });
    expect(logs[0].scope).toBe('native:/absences');
  });
});

describe('/hcm-proxy/* (degraded fallback mode)', () => {
  it('falls back to the service account and logs scope "degraded_service_account:" when token-exchange is not configured', async () => {
    await prisma.tenant.update({ where: { id: tenantId }, data: { oracleBaseUrl: 'https://acme.example.com', oracleServiceUser: 'svc', oracleServicePass: (await import('../../src/security/field-encryption')).encryptField('svc-pass') } });

    global.fetch = vi.fn(async (url: string) => {
      if (url === 'https://acme.example.com/hcmRestApi/resources/11.13.18.05/absences') return { ok: true, status: 200, json: async () => ({ items: [] }) } as Response;
      throw new Error(`Unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const server = buildServer();
    const response = await server.inject({ method: 'GET', url: '/hcm-proxy/absences', headers: { authorization: `Bearer ${token}` } });
    expect(response.statusCode).toBe(200);

    const logs = await prisma.auditLog.findMany({ where: { action: 'hcm_proxy_read' } });
    expect(logs[0].scope).toBe('degraded_service_account:/absences');
  });
});
```

- [ ] **Step 6: Run and confirm failure**

Run: `cd backend/services/api && npm test`
Expected: FAIL — the proxy route doesn't exist.

- [ ] **Step 7: Add the proxy route to `src/routes/data.ts`**

```typescript
import { exchangeForOracleAccessToken } from '../auth/token-exchange';
import { decryptField } from '../security/field-encryption';
import { writeAuditLog } from '../audit/log';

// inside registerDataRoutes(server):
  server.all<{ Params: { '*': string } }>('/hcm-proxy/*', { preHandler: requireAuth }, async (request, reply) => {
    const session = (request as FastifyRequest & { session: SessionClaims }).session;
    const resourcePath = '/' + request.params['*'];
    const ssoIdToken = request.headers['x-sso-id-token'] as string | undefined;
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: session.tenantId } });

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
      headers.Authorization = 'Basic ' + Buffer.from(`${tenant.oracleServiceUser}:${decryptField(tenant.oracleServicePass!)}`).toString('base64');
    }

    const oracleResponse = await fetch(`${tenant.oracleBaseUrl}/hcmRestApi/resources/11.13.18.05${resourcePath}`, { headers });
    await writeAuditLog({ tenantId: session.tenantId, actor: session.userId, action: 'hcm_proxy_read', scope: `${mode}:${resourcePath}` });
    reply.code(oracleResponse.status);
    return oracleResponse.json();
  });
```

- [ ] **Step 8: Run and confirm all tests pass, then commit**

Run: `cd backend/services/api && npm test`
Expected: PASS

```bash
git add backend/services/api/src/auth/token-exchange.ts backend/services/api/src/routes/data.ts backend/services/api/test
git commit -m "feat: add person-level HCM proxy with native token-exchange and audited degraded fallback"
```

---

### Task 5: Desktop SSO login (PKCE) replacing local Oracle credentials

**Files:**
- Create: `src/main/token-store.js`
- Create: `src/main/auth.js`
- Modify: `src/main.js` (add `login-with-sso`/`logout`/`get-auth-state` IPC handlers)
- Modify: `src/preload/index.js` (expose them)
- Modify: `package.json` (add `openid-client`, `keytar` dependencies)
- Test: `tests/unit/token-store.test.js`

**Interfaces:**
- Produces: `makeTokenStore(keytarLike)` returning `{ save({sessionToken, ssoIdToken}), load(), clear() }` — Task 6's backend client depends on `load()`'s return shape.

- [ ] **Step 1: Add dependencies**

```bash
npm install openid-client keytar
```

- [ ] **Step 2: Write the failing token-store test**

```javascript
// tests/unit/token-store.test.js
const { describe, it, expect } = require('vitest');
const { makeTokenStore } = require('../../src/main/token-store');

function fakeKeytar() {
  const store = new Map();
  return {
    setPassword: async (service, account, value) => { store.set(`${service}:${account}`, value); },
    getPassword: async (service, account) => store.get(`${service}:${account}`) ?? null,
    deletePassword: async (service, account) => { store.delete(`${service}:${account}`); return true; },
  };
}

describe('token-store', () => {
  it('round-trips a session token and sso id_token', async () => {
    const { save, load } = makeTokenStore(fakeKeytar());
    await save({ sessionToken: 'session-abc', ssoIdToken: 'id-token-xyz' });
    expect(await load()).toEqual({ sessionToken: 'session-abc', ssoIdToken: 'id-token-xyz' });
  });

  it('returns null when nothing has been saved', async () => {
    const { load } = makeTokenStore(fakeKeytar());
    expect(await load()).toBe(null);
  });

  it('clear() removes the stored tokens', async () => {
    const { save, load, clear } = makeTokenStore(fakeKeytar());
    await save({ sessionToken: 'session-abc', ssoIdToken: 'id-token-xyz' });
    await clear();
    expect(await load()).toBe(null);
  });
});
```

- [ ] **Step 3: Run and confirm failure**

Run: `npm run test:unit`
Expected: FAIL — `src/main/token-store.js` does not exist.

- [ ] **Step 4: Implement `src/main/token-store.js`**

```javascript
// src/main/token-store.js
const SERVICE = 'EQInt Savvy';
const ACCOUNT = 'auth-tokens';

function makeTokenStore(keytar) {
  async function save({ sessionToken, ssoIdToken }) {
    await keytar.setPassword(SERVICE, ACCOUNT, JSON.stringify({ sessionToken, ssoIdToken }));
  }

  async function load() {
    const raw = await keytar.getPassword(SERVICE, ACCOUNT);
    return raw ? JSON.parse(raw) : null;
  }

  async function clear() {
    await keytar.deletePassword(SERVICE, ACCOUNT);
  }

  return { save, load, clear };
}

module.exports = { makeTokenStore };
```

- [ ] **Step 5: Run and confirm it passes**

Run: `npm run test:unit`
Expected: PASS

- [ ] **Step 6: Implement the interactive PKCE flow in `src/main/auth.js`**

```javascript
// src/main/auth.js
const http = require('http');
const { URL } = require('url');
const { shell } = require('electron');
const { Issuer, generators } = require('openid-client');
const keytar = require('keytar');
const { makeTokenStore } = require('./token-store');

const tokenStore = makeTokenStore(keytar);

async function loginWithSso(backendUrl, tenantId) {
  const configResponse = await fetch(`${backendUrl}/tenants/${tenantId}/oidc-config`);
  if (!configResponse.ok) throw new Error('Tenant SSO is not configured on the backend');
  const { issuerUrl, clientId, redirectUri } = await configResponse.json();

  const issuer = await Issuer.discover(issuerUrl);
  const client = new issuer.Client({
    client_id: clientId,
    redirect_uris: [redirectUri],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  });

  const codeVerifier = generators.codeVerifier();
  const codeChallenge = generators.codeChallenge(codeVerifier);
  const state = generators.state();
  const authUrl = client.authorizationUrl({
    scope: 'openid email profile',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
  });

  const redirectPort = Number(new URL(redirectUri).port);
  const ssoIdToken = await new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const params = client.callbackParams(req);
        if (params.state !== state) throw new Error('OAuth state mismatch');
        const tokenSet = await client.callback(redirectUri, params, { code_verifier: codeVerifier, state });
        res.end('Login successful — you can close this window and return to Savvy.');
        server.close();
        resolve(tokenSet.id_token);
      } catch (err) {
        res.end('Login failed: ' + err.message);
        server.close();
        reject(err);
      }
    });
    server.listen(redirectPort, '127.0.0.1', () => {
      shell.openExternal(authUrl);
    });
  });

  const sessionResponse = await fetch(`${backendUrl}/auth/sso-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenantId, idToken: ssoIdToken }),
  });
  if (!sessionResponse.ok) throw new Error('Backend rejected the SSO login');
  const { token: sessionToken } = await sessionResponse.json();

  await tokenStore.save({ sessionToken, ssoIdToken });
  return { sessionToken };
}

async function getAuthState() {
  return tokenStore.load();
}

async function logout() {
  await tokenStore.clear();
}

module.exports = { loginWithSso, getAuthState, logout };
```

**Manual QA note (cannot be fully automated in this slice):** this flow requires a live IdP and an interactive browser consent screen, so it is not covered by the Playwright e2e suite here. Verify manually against a real or sandbox IdP (e.g., an Okta developer tenant) configured with the tenant's `oidcIssuerUrl`/`oidcClientId`/`oidcRedirectUri` before shipping: click "Sign in with SSO" in the desktop Settings tab, confirm the system browser opens, complete login, confirm the app receives a session token and `window.savvy.getAuthState()` reflects it.

- [ ] **Step 7: Wire IPC handlers in `src/main.js`**

```javascript
const { loginWithSso, getAuthState, logout } = require('./main/auth');

ipcMain.handle('login-with-sso', (e, { backendUrl, tenantId }) => loginWithSso(backendUrl, tenantId));
ipcMain.handle('get-auth-state', () => getAuthState());
ipcMain.handle('logout', () => logout());
```

- [ ] **Step 8: Expose in `src/preload/index.js`**

```javascript
  loginWithSso: (backendUrl, tenantId) => ipcRenderer.invoke('login-with-sso', { backendUrl, tenantId }),
  getAuthState: () => ipcRenderer.invoke('get-auth-state'),
  logout: () => ipcRenderer.invoke('logout'),
```

- [ ] **Step 9: Commit**

```bash
git add src/main/token-store.js src/main/auth.js src/main.js src/preload/index.js package.json package-lock.json tests/unit/token-store.test.js
git commit -m "feat: add desktop SSO PKCE login flow with OS-native token storage"
```

---

### Task 6: Desktop backend client, removing `callOracleApi` and local Oracle credential storage

**Files:**
- Create: `src/renderer/backend-client.js`
- Modify: `src/renderer/index.js` (replace `callOracleApi`/`autoFetchData`'s Oracle calls, remove `oraclePass`/`oracleUser` handling, replace local conversation-history/hcm-data logic with the backend client)
- Modify: `src/overlay.html` (remove the Oracle Username/Password Settings fields; add a "Sign in with SSO" button and a Tenant ID field)
- Modify: `src/main.js` (remove the `oraclePass` encryption added in the Phase 0 plan, since the field no longer exists)
- Modify: `src/main/secure-storage.js` usage (keep the module — Task 7's compliance work still needs it for other files — but stop calling `encryptField`/`decryptField` for `oraclePass`)

**Interfaces:**
- Consumes: `window.savvy.loginWithSso`, `window.savvy.getAuthState` (Task 5), backend routes from Tasks 2-4.
- Produces: `makeBackendClient({ backendUrl, getAuthState })` returning `{ getConversationHistory(), saveConversationHistory(history), fetchReferenceData(category), fetchPersonData(resourcePath) }`. This is the only way the renderer talks to Oracle data from this point forward — `callOracleApi` and `autoFetchData`'s direct fetch calls in [src/overlay.js:174-310](../../../src/overlay.js) are deleted, not merely bypassed.

- [ ] **Step 1: Write the failing backend-client test**

```javascript
// tests/unit/backend-client.test.js
const { describe, it, expect, vi } = require('vitest');
const { makeBackendClient } = require('../../src/renderer/backend-client');

describe('backend-client', () => {
  it('attaches the session token and sso id_token headers on fetchPersonData', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [] }) });
    const client = makeBackendClient({
      backendUrl: 'http://localhost:4000',
      getAuthState: async () => ({ sessionToken: 'session-abc', ssoIdToken: 'id-xyz' }),
    });

    await client.fetchPersonData('/absences');

    expect(global.fetch).toHaveBeenCalledWith('http://localhost:4000/hcm-proxy/absences', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer session-abc', 'x-sso-id-token': 'id-xyz' }),
    }));
  });

  it('throws a descriptive error when the backend responds with a non-2xx status', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const client = makeBackendClient({ backendUrl: 'http://localhost:4000', getAuthState: async () => ({ sessionToken: 't', ssoIdToken: 'i' }) });
    await expect(client.fetchReferenceData('department')).rejects.toThrow('Backend error 500');
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm run test:unit`
Expected: FAIL — `src/renderer/backend-client.js` does not exist.

- [ ] **Step 3: Implement `src/renderer/backend-client.js`**

```javascript
// src/renderer/backend-client.js
async function backendFetch(backendUrl, authState, urlPath, options = {}) {
  const headers = {
    ...(options.headers || {}),
    'Content-Type': 'application/json',
    Authorization: `Bearer ${authState.sessionToken}`,
  };
  if (authState.ssoIdToken) headers['x-sso-id-token'] = authState.ssoIdToken;

  const response = await fetch(`${backendUrl}${urlPath}`, { ...options, headers });
  if (!response.ok) throw new Error(`Backend error ${response.status} for ${urlPath}`);
  return response.json();
}

function makeBackendClient({ backendUrl, getAuthState }) {
  return {
    getConversationHistory: async () => backendFetch(backendUrl, await getAuthState(), '/conversation-history'),
    saveConversationHistory: async (history) =>
      backendFetch(backendUrl, await getAuthState(), '/conversation-history', { method: 'PUT', body: JSON.stringify(history) }),
    fetchReferenceData: async (category) => backendFetch(backendUrl, await getAuthState(), `/reference-data/${category}`),
    fetchPersonData: async (resourcePath) => backendFetch(backendUrl, await getAuthState(), `/hcm-proxy${resourcePath}`),
  };
}

module.exports = { makeBackendClient };
```

- [ ] **Step 4: Run and confirm it passes**

Run: `npm run test:unit`
Expected: PASS

- [ ] **Step 5: Wire it into `src/renderer/index.js`, deleting the Oracle-direct code paths**

Delete `callOracleApi` entirely (former [src/overlay.js:174-207](../../../src/overlay.js)).

Replace `autoFetchData` (former [src/overlay.js:210-310](../../../src/overlay.js)) so each branch calls `backendClient.fetchPersonData(...)` instead of `callOracleApi('GET', ...)` — for example, the absences branch becomes:
```javascript
  if (msg.includes('absence') || msg.includes('leave') || msg.includes('time off')) {
    const data = await backendClient.fetchPersonData('/absences?onlyData=true&limit=10');
    if (data.items && data.items.length > 0) {
      const lines = data.items.map((a, i) =>
        `${i+1}. ${a.AbsenceType || 'N/A'} | ${a.StartDate || ''} to ${a.EndDate || ''} | Status: ${a.AbsenceStatus || 'N/A'} | Days: ${a.AbsenceDays || 'N/A'}`
      );
      return '\n[ABSENCE DATA]\n' + lines.join('\n');
    }
    return '\n[ABSENCE DATA]\nNo absence records found.';
  }
```
Apply the same `backendClient.fetchPersonData(...)` substitution to the remaining `autoFetchData` branches (workers, departments, timeCards, payrollElements, benefitEnrollments, jobs, locations), keeping each branch's existing response-formatting logic unchanged.

Add near the top of the file, after the `loadInitialState` function added in the Phase 0 plan:
```javascript
const { makeBackendClient } = require('./backend-client');

let backendClient = null;

async function initBackendClient() {
  const authState = await window.savvy.getAuthState();
  backendClient = makeBackendClient({
    backendUrl: settings.backendUrl,
    getAuthState: () => window.savvy.getAuthState(),
  });
  return authState;
}
```

Call `await initBackendClient();` inside `loadInitialState()` (added in the Phase 0 plan), after `settings = await window.savvy.getSettings();`.

Replace `saveConversationHistory` (rewritten in the Phase 0 plan to call `window.savvy.saveConversationHistory`) with:
```javascript
async function saveConversationHistory() {
  await backendClient.saveConversationHistory(conversationHistory);
}
```

Replace the `runDiscovery` function's reference-data handling: instead of calling `hcmDiscovery.runAll()` against Oracle directly, replace its body with a call to `backendClient.fetchReferenceData('department')` (and the other reference categories added by later sync-job tasks) to display what the backend already has cached — the desktop no longer performs Oracle discovery itself now that Phase 1's scheduler does it server-side. Update the "Discover My HCM System" button's label/copy accordingly to reflect that it's now showing backend-synced data rather than triggering a live scan.

- [ ] **Step 6: Replace the Settings tab's Oracle credential fields with SSO login in `src/overlay.html`**

Remove the three `setting-group` blocks for `setOracleUrl`, `setOracleUser`, `setOraclePass` (former [src/overlay.html:372-383](../../../src/overlay.html)). Replace with:
```html
    <div class="setting-group">
      <div class="setting-label">Tenant ID</div>
      <input class="setting-input" id="setTenantId" placeholder="provided by your IT admin" />
    </div>
    <div class="setting-group">
      <div class="setting-label">Backend URL</div>
      <input class="setting-input" id="setBackendUrl" placeholder="https://savvy-api.yourcompany.com" />
    </div>
    <button class="save-btn" id="ssoLoginBtn">Sign in with SSO</button>
    <div class="saved-msg" id="ssoStatus" style="display:none;"></div>
```

Add the corresponding handler in `src/renderer/index.js`'s `DOMContentLoaded` listener:
```javascript
  document.getElementById('ssoLoginBtn').addEventListener('click', async () => {
    const tenantId = document.getElementById('setTenantId').value;
    const backendUrl = document.getElementById('setBackendUrl').value;
    settings = { ...settings, tenantId, backendUrl };
    await window.savvy.setSettings(settings);
    const statusEl = document.getElementById('ssoStatus');
    statusEl.style.display = 'block';
    try {
      await window.savvy.loginWithSso(backendUrl, tenantId);
      await initBackendClient();
      statusEl.textContent = 'Signed in!';
    } catch (err) {
      statusEl.textContent = 'Sign-in failed: ' + err.message;
    }
  });
```

- [ ] **Step 7: Remove the now-unused `oraclePass` encryption wiring from `src/main.js`**

Revert the `get-settings`/`set-settings` handlers from the Phase 0 plan's Task 5 back to plain pass-through (no `secureStorage.encryptField`/`decryptField` calls), since the `oraclePass` field no longer exists in settings:
```javascript
ipcMain.handle('get-settings', () => store.get('settings'));
ipcMain.handle('set-settings', (e, newSettings) => {
  const currentSettings = store.get('settings');
  const updatedSettings = { ...currentSettings, ...newSettings };
  store.set('settings', updatedSettings);
  return true;
});
```

`secureStorage` (from `src/main/secure-storage.js`) stays imported in `src/main.js` — it's still used by the `load-hcm-data`/`save-hcm-data` handlers... which are themselves removed in this task since `hcm-data.json` local caching is replaced by `backendClient.fetchReferenceData`. Remove the `load-hcm-data`/`save-hcm-data` IPC handlers and their `src/preload/index.js` exposures entirely, and delete any `hcm-data.json` left over on disk from earlier phases.

- [ ] **Step 8: Rebuild the renderer bundle and run the full test suite**

Run: `node scripts/build-renderer.js && npm run test:unit && npm run test:e2e`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/renderer/backend-client.js src/renderer/index.js src/overlay.html src/main.js src/preload/index.js tests/unit/backend-client.test.js
git rm -f hcm-data.json
git commit -m "refactor: replace direct Oracle calls and local credential storage with backend-brokered SSO and data access"
```

---

## Self-Review Notes

- **Spec coverage**: Section 5.2 desktop SSO login (Task 5), Section 5.1 native token-exchange with audited degraded fallback (Task 4), Section 6 "no Oracle creds on desktop" and "conversation history moves to backend" (Task 6) — all covered.
- **Type/interface consistency**: `SessionClaims` shape (`{ userId, tenantId, role }`) from Phase 1 Task 3 is used identically across Tasks 2-4; `makeTokenStore`'s `{ sessionToken, ssoIdToken }` shape from Task 5 matches exactly what `makeBackendClient` (Task 6) expects from `getAuthState()`.
- **Explicitly out of scope for this phase** (covered by the Phase 3 plan): the `FIELD_ENCRYPTION_KEY` env-var stand-in from Phase 1 is still used here for `oidcTokenExchangeClientSecret` — Phase 3 replaces it with real KMS-backed encryption without changing `encryptField`/`decryptField`'s signatures; retention/erasure policies for the new `ConversationEntry` table are also Phase 3 scope.
