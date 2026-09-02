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
