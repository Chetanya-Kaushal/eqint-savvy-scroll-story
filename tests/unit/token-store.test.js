const { describe, it, expect } = require('vitest');
const { makeTokenStore } = require('../../src/main/token-store');

function fakeKeytar() {
  const store = new Map();
  return {
    setPassword: async (service, account, value) => { store.set(`${service}:${account}`, value); },
    getPassword: async (service, account) => store.get(`${service}:${account}`) ?? null,
    deletePassword: async (service, account) => { store.delete(`${service}:${account}`); return true; },
  };
}

describe('token-store', () => {
  it('round-trips a session token and sso id_token', async () => {
    const { save, load } = makeTokenStore(fakeKeytar());
    await save({ sessionToken: 'session-abc', ssoIdToken: 'id-token-xyz' });
    expect(await load()).toEqual({ sessionToken: 'session-abc', ssoIdToken: 'id-token-xyz' });
  });

  it('returns null when nothing has been saved', async () => {
    const { load } = makeTokenStore(fakeKeytar());
    expect(await load()).toBe(null);
  });

  it('clear() removes the stored tokens', async () => {
    const { save, load, clear } = makeTokenStore(fakeKeytar());
    await save({ sessionToken: 'session-abc', ssoIdToken: 'id-token-xyz' });
    await clear();
    expect(await load()).toBe(null);
  });
});
