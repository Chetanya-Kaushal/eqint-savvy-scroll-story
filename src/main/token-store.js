const SERVICE = 'EQInt Savvy';
const ACCOUNT = 'auth-tokens';

function makeTokenStore(keytar) {
  async function save({ sessionToken, ssoIdToken }) {
    await keytar.setPassword(SERVICE, ACCOUNT, JSON.stringify({ sessionToken, ssoIdToken }));
  }

  async function load() {
    const raw = await keytar.getPassword(SERVICE, ACCOUNT);
    return raw ? JSON.parse(raw) : null;
  }

  async function clear() {
    await keytar.deletePassword(SERVICE, ACCOUNT);
  }

  return { save, load, clear };
}

module.exports = { makeTokenStore };
