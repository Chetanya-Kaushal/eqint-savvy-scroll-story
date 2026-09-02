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
    await prisma.conversationEntry?.deleteMany();
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
