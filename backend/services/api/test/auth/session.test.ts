import { describe, it, expect, beforeAll } from 'vitest';
import { issueSessionToken, verifySessionToken } from '../../src/auth/session';

beforeAll(() => {
  process.env.SESSION_JWT_SECRET = 'test-secret';
});

describe('session tokens', () => {
  it('issues a token that verifies back to the same claims', () => {
    const token = issueSessionToken({ id: 'user-1', tenantId: 'tenant-1', role: 'employee' });
    const claims = verifySessionToken(token);
    expect(claims).toEqual({ userId: 'user-1', tenantId: 'tenant-1', role: 'employee' });
  });

  it('returns null for a tampered token', () => {
    const token = issueSessionToken({ id: 'user-1', tenantId: 'tenant-1', role: 'employee' });
    expect(verifySessionToken(token + 'tampered')).toBe(null);
  });
});
