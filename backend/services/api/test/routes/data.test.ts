import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { buildServer } from '../../src/server';
import { prisma } from '../../src/db';
import { issueSessionToken } from '../../src/auth/session';

describe('data routes', () => {
  let tenantId: string;
  let userId: string;
  let token: string;

  beforeEach(async () => {
    process.env.SESSION_JWT_SECRET = 'test-secret';
    await prisma.conversationEntry.deleteMany();
    await prisma.referenceRecord.deleteMany();
    await prisma.user.deleteMany();
    await prisma.tenant.deleteMany();
    const tenant = await prisma.tenant.create({ data: { name: 'Acme', oracleBaseUrl: '' } });
    tenantId = tenant.id;
    const user = await prisma.user.create({ data: { tenantId, email: 'jane@acme.test', role: 'employee', ssoSubject: 'sub-1' } });
    userId = user.id;
    token = issueSessionToken({ id: userId, tenantId, role: 'employee' });
    await prisma.referenceRecord.create({ data: { tenantId, category: 'department', externalId: '100', data: { Name: 'Engineering' } } });
  });

  afterAll(async () => { await prisma.$disconnect(); });

  it('PUT then GET /conversation-history round-trips the caller\'s own history', async () => {
    const server = buildServer();
    await server.inject({
      method: 'PUT', url: '/conversation-history', headers: { authorization: `Bearer ${token}` },
      payload: [{ role: 'user', content: 'hello' }, { role: 'bot', content: 'hi there' }],
    });
    const response = await server.inject({ method: 'GET', url: '/conversation-history', headers: { authorization: `Bearer ${token}` } });
    const history = response.json();
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ role: 'user', content: 'hello' });
  });

  it('GET /reference-data/:category returns only the caller\'s tenant records', async () => {
    const server = buildServer();
    const response = await server.inject({ method: 'GET', url: '/reference-data/department', headers: { authorization: `Bearer ${token}` } });
    const records = response.json();
    expect(records).toHaveLength(1);
    expect(records[0].data).toEqual({ Name: 'Engineering' });
  });
});
