import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { buildServer } from '../../src/server';
import { prisma } from '../../src/db';
import { issueSessionToken } from '../../src/auth/session';

describe('POST /telemetry/events', () => {
  let tenantId: string;
  let token: string;

  beforeEach(async () => {
    process.env.SESSION_JWT_SECRET = 'test-secret';
    await prisma.telemetryEvent.deleteMany();
    await prisma.user.deleteMany();
    await prisma.tenant.deleteMany();
    const tenant = await prisma.tenant.create({ data: { name: 'Acme', oracleBaseUrl: '' } });
    tenantId = tenant.id;
    token = issueSessionToken({ id: 'user-1', tenantId, role: 'employee' });
  });

  afterAll(async () => { await prisma.$disconnect(); });

  it('records a telemetry event scoped to the caller\'s tenant and user', async () => {
    const server = buildServer();
    const response = await server.inject({
      method: 'POST', url: '/telemetry/events', headers: { authorization: `Bearer ${token}` },
      payload: { name: 'chat_message_sent', properties: { model: 'phi3:mini' } },
    });
    expect(response.statusCode).toBe(201);

    const events = await prisma.telemetryEvent.findMany({ where: { tenantId } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ userId: 'user-1', name: 'chat_message_sent' });
  });
});
