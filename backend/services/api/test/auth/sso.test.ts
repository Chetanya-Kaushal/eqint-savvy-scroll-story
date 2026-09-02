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
