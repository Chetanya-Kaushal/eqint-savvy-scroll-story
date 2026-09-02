import { FastifyInstance, FastifyRequest } from 'fastify';
import { requireAuth } from '../rbac/policy';
import { prisma } from '../db';
import { SessionClaims } from '../auth/session';

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
}
