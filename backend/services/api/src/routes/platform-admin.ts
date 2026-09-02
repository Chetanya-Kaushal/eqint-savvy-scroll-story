import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { prisma } from '../db';
import { writeAuditLog } from '../audit/log';

async function requirePlatformAdmin(request: FastifyRequest, reply: FastifyReply) {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return reply.code(401).send({ error: 'Missing bearer token' });
  try {
    const decoded = jwt.verify(header.slice('Bearer '.length), process.env.SESSION_JWT_SECRET!) as jwt.JwtPayload;
    if (decoded.kind !== 'platform_admin') return reply.code(401).send({ error: 'Invalid token' });
    (request as FastifyRequest & { platformAdminEmail: string }).platformAdminEmail = decoded.email;
  } catch {
    return reply.code(401).send({ error: 'Invalid or expired token' });
  }
}

export function registerPlatformAdminRoutes(server: FastifyInstance): void {
  server.post<{ Body: { email: string; password: string } }>('/platform/login', async (request, reply) => {
    const { email, password } = request.body;
    const admin = await prisma.platformAdmin.findUnique({ where: { email } });
    if (!admin || !(await bcrypt.compare(password, admin.passwordHash))) {
      return reply.code(401).send({ error: 'Invalid credentials' });
    }
    const token = jwt.sign({ kind: 'platform_admin', email }, process.env.SESSION_JWT_SECRET!, { expiresIn: '4h' });
    return { token };
  });

  server.post<{ Body: { name: string; oracleBaseUrl: string } }>(
    '/platform/tenants',
    { preHandler: requirePlatformAdmin },
    async (request, reply) => {
      const tenant = await prisma.tenant.create({ data: request.body });
      await writeAuditLog({ tenantId: tenant.id, actor: (request as FastifyRequest & { platformAdminEmail: string }).platformAdminEmail, action: 'tenant_created', scope: 'platform' });
      reply.code(201);
      return tenant;
    }
  );

  server.get('/platform/tenants', { preHandler: requirePlatformAdmin }, async () => {
    return prisma.tenant.findMany();
  });
}
