import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { buildServer } from '../../src/server';
import { prisma } from '../../src/db';

describe('platform admin tenant routes', () => {
  let token: string;

  beforeEach(async () => {
    await prisma.tenant.deleteMany();
    await prisma.platformAdmin.deleteMany();
    process.env.SESSION_JWT_SECRET = 'test-secret';
    const passwordHash = await bcrypt.hash('correct-horse-battery-staple', 10);
    await prisma.platformAdmin.create({ data: { email: 'admin@eqint.example', passwordHash } });

    const server = buildServer();
    const loginResponse = await server.inject({
      method: 'POST',
      url: '/platform/login',
      payload: { email: 'admin@eqint.example', password: 'correct-horse-battery-staple' },
    });
    token = loginResponse.json().token;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('rejects tenant creation without a valid platform-admin token', async () => {
    const server = buildServer();
    const response = await server.inject({ method: 'POST', url: '/platform/tenants', payload: { name: 'Acme', oracleBaseUrl: 'https://acme.example.com' } });
    expect(response.statusCode).toBe(401);
  });

  it('creates and lists a tenant for an authenticated platform admin', async () => {
    const server = buildServer();
    const createResponse = await server.inject({
      method: 'POST',
      url: '/platform/tenants',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Acme', oracleBaseUrl: 'https://acme.example.com' },
    });
    expect(createResponse.statusCode).toBe(201);

    const listResponse = await server.inject({ method: 'GET', url: '/platform/tenants', headers: { authorization: `Bearer ${token}` } });
    const tenants = listResponse.json();
    expect(tenants).toHaveLength(1);
    expect(tenants[0].name).toBe('Acme');
  });
});
