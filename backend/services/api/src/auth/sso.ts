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
