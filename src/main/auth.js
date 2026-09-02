const http = require('http');
const { URL } = require('url');
const { shell } = require('electron');
const { Issuer, generators } = require('openid-client');
const keytar = require('keytar');
const { makeTokenStore } = require('./token-store');

const tokenStore = makeTokenStore(keytar);

async function loginWithSso(backendUrl, tenantId) {
  const configResponse = await fetch(`${backendUrl}/tenants/${tenantId}/oidc-config`);
  if (!configResponse.ok) throw new Error('Tenant SSO is not configured on the backend');
  const { issuerUrl, clientId, redirectUri } = await configResponse.json();

  const issuer = await Issuer.discover(issuerUrl);
  const client = new issuer.Client({
    client_id: clientId,
    redirect_uris: [redirectUri],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  });

  const codeVerifier = generators.codeVerifier();
  const codeChallenge = generators.codeChallenge(codeVerifier);
  const state = generators.state();
  const authUrl = client.authorizationUrl({
    scope: 'openid email profile',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
  });

  const redirectPort = Number(new URL(redirectUri).port);
  const ssoIdToken = await new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const params = client.callbackParams(req);
        if (params.state !== state) throw new Error('OAuth state mismatch');
        const tokenSet = await client.callback(redirectUri, params, { code_verifier: codeVerifier, state });
        res.end('Login successful — you can close this window and return to Savvy.');
        server.close();
        resolve(tokenSet.id_token);
      } catch (err) {
        res.end('Login failed: ' + err.message);
        server.close();
        reject(err);
      }
    });
    server.listen(redirectPort, '127.0.0.1', () => {
      shell.openExternal(authUrl);
    });
  });

  const sessionResponse = await fetch(`${backendUrl}/auth/sso-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenantId, idToken: ssoIdToken }),
  });
  if (!sessionResponse.ok) throw new Error('Backend rejected the SSO login');
  const { token: sessionToken } = await sessionResponse.json();

  await tokenStore.save({ sessionToken, ssoIdToken });
  return { sessionToken };
}

async function getAuthState() {
  return tokenStore.load();
}

async function logout() {
  await tokenStore.clear();
}

module.exports = { loginWithSso, getAuthState, logout };
