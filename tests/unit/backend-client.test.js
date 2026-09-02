import { describe, it, expect, vi } from 'vitest';
import { makeBackendClient } from '../../src/renderer/backend-client.js';

describe('backend-client', () => {
  it('attaches the session token and sso id_token headers on fetchPersonData', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [] }) });
    const client = makeBackendClient({
      backendUrl: 'http://localhost:4000',
      getAuthState: async () => ({ sessionToken: 'session-abc', ssoIdToken: 'id-xyz' }),
    });

    await client.fetchPersonData('/absences');

    expect(global.fetch).toHaveBeenCalledWith('http://localhost:4000/hcm-proxy/absences', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer session-abc', 'x-sso-id-token': 'id-xyz' }),
    }));
  });

  it('throws a descriptive error when the backend responds with a non-2xx status', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const client = makeBackendClient({ backendUrl: 'http://localhost:4000', getAuthState: async () => ({ sessionToken: 't', ssoIdToken: 'i' }) });
    await expect(client.fetchReferenceData('department')).rejects.toThrow('Backend error 500');
  });
});
