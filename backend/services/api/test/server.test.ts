import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server';

describe('GET /health', () => {
  it('returns 200 and status ok', async () => {
    const server = buildServer();
    const response = await server.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });
});
