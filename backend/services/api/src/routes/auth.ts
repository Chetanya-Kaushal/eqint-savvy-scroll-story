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
