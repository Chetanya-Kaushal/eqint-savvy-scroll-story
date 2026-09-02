import { FastifyInstance, FastifyRequest } from 'fastify';
import { requireAuth } from '../rbac/policy';
import { prisma } from '../db';
import { SessionClaims } from '../auth/session';
import { exchangeForOracleAccessToken } from '../auth/token-exchange';
import { decryptField } from '../security/field-encryption';
import { kmsProvider } from '../security/kms-provider';
import { writeAuditLog } from '../audit/log';

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
      headers.Authorization = 'Basic ' + Buffer.from(`${tenant.oracleServiceUser}:${await decryptField(kmsProvider, tenant.oracleServicePass!)}`).toString('base64');
    }

    const oracleResponse = await fetch(`${tenant.oracleBaseUrl}/hcmRestApi/resources/11.13.18.05${resourcePath}`, { headers });
    await writeAuditLog({ tenantId: session.tenantId, actor: session.userId, action: 'hcm_proxy_read', scope: `${mode}:${resourcePath}` });
    reply.code(oracleResponse.status);
    return oracleResponse.json();
  });
}
