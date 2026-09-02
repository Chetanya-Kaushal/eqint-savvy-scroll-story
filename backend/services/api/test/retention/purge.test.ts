import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { prisma } from '../../src/db';
import { runRetentionPurge } from '../../src/retention/purge';

describe('runRetentionPurge', () => {
  let tenantId: string;
  let userId: string;

  beforeEach(async () => {
    await prisma.conversationEntry.deleteMany();
    await prisma.personDataCache.deleteMany();
    await prisma.user.deleteMany();
    await prisma.tenant.deleteMany();
    const tenant = await prisma.tenant.create({ data: { name: 'Acme', oracleBaseUrl: '', retentionDays: 30 } });
    tenantId = tenant.id;
    const user = await prisma.user.create({ data: { tenantId, email: 'jane@acme.test', role: 'employee', ssoSubject: 'sub-1' } });
    userId = user.id;
  });

  afterAll(async () => { await prisma.$disconnect(); });

  it('deletes conversation entries older than the tenant retention window', async () => {
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    const recent = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    await prisma.conversationEntry.create({ data: { userId, role: 'user', content: 'old message', createdAt: old } });
    await prisma.conversationEntry.create({ data: { userId, role: 'user', content: 'recent message', createdAt: recent } });

    const result = await runRetentionPurge();
    expect(result.conversationEntriesDeleted).toBe(1);

    const remaining = await prisma.conversationEntry.findMany();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].content).toBe('recent message');
  });

  it('deletes expired PersonDataCache rows regardless of tenant retention window', async () => {
    await prisma.personDataCache.create({ data: { userId, resourcePath: '/absences', data: {}, expiresAt: new Date(Date.now() - 1000) } });
    await prisma.personDataCache.create({ data: { userId, resourcePath: '/jobs', data: {}, expiresAt: new Date(Date.now() + 60000) } });

    const result = await runRetentionPurge();
    expect(result.expiredCacheEntriesDeleted).toBe(1);

    const remaining = await prisma.personDataCache.findMany();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].resourcePath).toBe('/jobs');
  });
});
