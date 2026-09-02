import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { requireRole } from '../../src/rbac/policy';
import { issueSessionToken } from '../../src/auth/session';

describe('requireRole', () => {
  it('allows a request whose session role matches', async () => {
    process.env.SESSION_JWT_SECRET = 'test-secret';
    const server = Fastify();
    server.get('/admin-only', { preHandler: requireRole('tenant_admin') }, async () => ({ ok: true }));
    const token = issueSessionToken({ id: 'u1', tenantId: 't1', role: 'tenant_admin' });

    const response = await server.inject({ method: 'GET', url: '/admin-only', headers: { authorization: `Bearer ${token}` } });
    expect(response.statusCode).toBe(200);
  });

  it('rejects a request whose session role does not match', async () => {
    process.env.SESSION_JWT_SECRET = 'test-secret';
    const server = Fastify();
    server.get('/admin-only', { preHandler: requireRole('tenant_admin') }, async () => ({ ok: true }));
    const token = issueSessionToken({ id: 'u1', tenantId: 't1', role: 'employee' });

    const response = await server.inject({ method: 'GET', url: '/admin-only', headers: { authorization: `Bearer ${token}` } });
    expect(response.statusCode).toBe(403);
  });

  it('rejects a request with no token', async () => {
    process.env.SESSION_JWT_SECRET = 'test-secret';
    const server = Fastify();
    server.get('/admin-only', { preHandler: requireRole('tenant_admin') }, async () => ({ ok: true }));

    const response = await server.inject({ method: 'GET', url: '/admin-only' });
    expect(response.statusCode).toBe(401);
  });
});
