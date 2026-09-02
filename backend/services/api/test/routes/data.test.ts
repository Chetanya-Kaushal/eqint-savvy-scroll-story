import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { buildServer } from '../../src/server';
import { prisma } from '../../src/db';
import { issueSessionToken } from '../../src/auth/session';

describe('data routes', () => {
  let tenantId: string;
  let userId: string;
  let token: string;

  beforeEach(async () => {
    process.env.SESSION_JWT_SECRET = 'test-secret';
    process.env.FIELD_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    await prisma.conversationEntry.deleteMany();
    await prisma.auditLog.deleteMany();
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

describe('/hcm-proxy/* (native mode)', () => {
  let tenantId: string;
  let token: string;

  beforeEach(async () => {
    process.env.SESSION_JWT_SECRET = 'test-secret';
    process.env.FIELD_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    await prisma.auditLog.deleteMany();
    await prisma.conversationEntry.deleteMany();
    await prisma.referenceRecord.deleteMany();
    await prisma.user.deleteMany();
    await prisma.tenant.deleteMany();
    const { encryptField } = await import('../../src/security/field-encryption');
    const tenant = await prisma.tenant.create({
      data: {
        name: 'Acme', oracleBaseUrl: 'https://acme.example.com',
        oidcIssuerUrl: 'https://idp.acme.test', oidcTokenExchangeClientId: 'x',
        oidcTokenExchangeClientSecret: encryptField('secret'),
      },
    });
    tenantId = tenant.id;
    const user = await prisma.user.create({ data: { tenantId, email: 'jane@acme.test', role: 'employee', ssoSubject: 'sub-1' } });
    token = issueSessionToken({ id: user.id, tenantId, role: 'employee' });
  });

  afterAll(async () => { await prisma.$disconnect(); });

  it('uses the exchanged Oracle access token and logs scope "native:"', async () => {
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
  let tenantId: string;
  let token: string;

  beforeEach(async () => {
    process.env.SESSION_JWT_SECRET = 'test-secret';
    process.env.FIELD_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    await prisma.auditLog.deleteMany();
    await prisma.conversationEntry.deleteMany();
    await prisma.referenceRecord.deleteMany();
    await prisma.user.deleteMany();
    await prisma.tenant.deleteMany();
    const { encryptField } = await import('../../src/security/field-encryption');
    const tenant = await prisma.tenant.create({
      data: {
        name: 'Acme', oracleBaseUrl: 'https://acme.example.com',
        oracleServiceUser: 'svc', oracleServicePass: encryptField('svc-pass'),
      },
    });
    tenantId = tenant.id;
    const user = await prisma.user.create({ data: { tenantId, email: 'jane@acme.test', role: 'employee', ssoSubject: 'sub-1' } });
    token = issueSessionToken({ id: user.id, tenantId, role: 'employee' });
  });

  afterAll(async () => { await prisma.$disconnect(); });

  it('falls back to the service account and logs scope "degraded_service_account:" when token-exchange is not configured', async () => {
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
