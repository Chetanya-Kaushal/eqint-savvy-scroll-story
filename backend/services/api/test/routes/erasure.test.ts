import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { prisma } from '../../src/db';
import { issueSessionToken } from '../../src/auth/session';
import { buildServer } from '../../src/server';

describe('POST /data/erase', () => {
  let tenantId: string;
  let userId: string;
  let token: string;

  beforeEach(async () => {
    process.env.SESSION_JWT_SECRET = 'test-secret';
    await prisma.auditLog.deleteMany();
    await prisma.conversationEntry.deleteMany();
    await prisma.personDataCache.deleteMany();
    await prisma.user.deleteMany();
    await prisma.tenant.deleteMany();
    const tenant = await prisma.tenant.create({ data: { name: 'Acme', oracleBaseUrl: '' } });
    tenantId = tenant.id;
    const user = await prisma.user.create({ data: { tenantId, email: 'jane@acme.test', role: 'employee', ssoSubject: 'sub-1' } });
    userId = user.id;
    token = issueSessionToken({ id: user.id, tenantId, role: 'employee' });
  });

  afterAll(async () => { await prisma.$disconnect(); });

  it('deletes all PII and logs an immutable audit entry', async () => {
    await prisma.conversationEntry.create({ data: { userId, role: 'user', content: 'sensitive' } });
    await prisma.personDataCache.create({ data: { userId, resourcePath: '/absences', data: {}, expiresAt: new Date(Date.now() + 60000) } });

    const server = buildServer();
    const response = await server.inject({
      method: 'POST',
      url: '/data/erase',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);

    const conversations = await prisma.conversationEntry.findMany({ where: { userId } });
    expect(conversations).toHaveLength(0);

    const cache = await prisma.personDataCache.findMany({ where: { userId } });
    expect(cache).toHaveLength(0);

    const auditLogs = await prisma.auditLog.findMany({ where: { action: 'data_subject_erasure' } });
    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0].hash).toBeTruthy();
    expect(auditLogs[0].scope).toContain(userId);
  });
});
