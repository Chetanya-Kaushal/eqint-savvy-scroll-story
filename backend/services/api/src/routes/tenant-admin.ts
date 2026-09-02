import { FastifyInstance, FastifyRequest } from 'fastify';
import { requireRole } from '../rbac/policy';
import { prisma } from '../db';
import { writeAuditLog } from '../audit/log';
import { encryptField } from '../security/field-encryption';
import { kmsProvider } from '../security/kms-provider';
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

      const data: Record<string, any> = { oracleBaseUrl: request.body.oracleBaseUrl };
      if (request.body.oracleServiceUser) data.oracleServiceUser = request.body.oracleServiceUser;
      if (request.body.oracleServicePass) data.oracleServicePass = await encryptField(kmsProvider, request.body.oracleServicePass);
      if (request.body.retentionDays != null) data.retentionDays = request.body.retentionDays;

      const tenant = await prisma.tenant.update({ where: { id: request.params.tenantId }, data });
      await writeAuditLog({ tenantId: tenant.id, actor: session.userId, action: 'oracle_connection_updated', scope: 'tenant_admin' });
      return tenant;
    }
  );

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
    if (oidcTokenExchangeClientSecret) data.oidcTokenExchangeClientSecret = await encryptField(kmsProvider, oidcTokenExchangeClientSecret);

    const tenant = await prisma.tenant.update({ where: { id: request.params.tenantId }, data });
    await writeAuditLog({ tenantId: tenant.id, actor: session.userId, action: 'oidc_config_updated', scope: 'tenant_admin' });
    return tenant;
  });
}
