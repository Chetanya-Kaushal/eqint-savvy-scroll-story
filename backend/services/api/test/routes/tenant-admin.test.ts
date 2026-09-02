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
    expect(tenant.oracleServicePass).not.toBe('super-secret');
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

describe('PATCH /tenants/:tenantId/oidc-config', () => {
  let tenantId: string;
  let adminToken: string;

  beforeEach(async () => {
    process.env.SESSION_JWT_SECRET = 'test-secret';
    await prisma.user.deleteMany();
    await prisma.tenant.deleteMany();
    const tenant = await prisma.tenant.create({ data: { name: 'Acme', oracleBaseUrl: '' } });
    tenantId = tenant.id;
    adminToken = issueSessionToken({ id: 'admin-1', tenantId, role: 'tenant_admin' });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

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
