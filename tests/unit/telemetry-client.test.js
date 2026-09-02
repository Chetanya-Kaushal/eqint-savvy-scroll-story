const { describe, it, expect, vi } = require('vitest');
const { makeTelemetryClient } = require('../../src/main/telemetry-client');

describe('telemetry-client', () => {
  it('does not send when disabled', async () => {
    global.fetch = vi.fn();
    const client = makeTelemetryClient({ backendUrl: 'http://localhost:4000', getAuthState: async () => ({ sessionToken: 't' }), enabled: false });
    await client.recordEvent('chat_message_sent', { model: 'phi3:mini' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('scrubs common PII field names before sending when enabled', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true });
    const client = makeTelemetryClient({ backendUrl: 'http://localhost:4000', getAuthState: async () => ({ sessionToken: 't' }), enabled: true });
    await client.recordEvent('chat_message_sent', { model: 'phi3:mini', email: 'jane@acme.test', message: 'my SSN is 123-45-6789' });

    const [, options] = global.fetch.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.properties).toEqual({ model: 'phi3:mini' });
  });
});
