import { prisma } from '../db';
import { decryptField } from '../security/field-encryption';
import { kmsProvider } from '../security/kms-provider';

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
    client_secret: await decryptField(kmsProvider, tenant.oidcTokenExchangeClientSecret),
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
