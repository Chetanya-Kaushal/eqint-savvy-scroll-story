import { FastifyInstance, FastifyRequest } from 'fastify';
import { requireAuth } from '../rbac/policy';
import { prisma } from '../db';
import { SessionClaims } from '../auth/session';

export function registerTelemetryRoutes(server: FastifyInstance): void {
  server.post<{ Body: { name: string; properties: Record<string, unknown> } }>(
    '/telemetry/events',
    { preHandler: requireAuth },
    async (request, reply) => {
      const session = (request as FastifyRequest & { session: SessionClaims }).session;
      await prisma.telemetryEvent.create({
        data: { tenantId: session.tenantId, userId: session.userId, name: request.body.name, properties: request.body.properties },
      });
      reply.code(201);
      return { ok: true };
    }
  );
}
