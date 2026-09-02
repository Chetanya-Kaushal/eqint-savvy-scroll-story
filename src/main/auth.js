const http = require('http');
const { URL } = require('url');
const { shell } = require('electron');
const keytar = require('keytar');
const { makeTokenStore } = require('./token-store');

const tokenStore = makeTokenStore(keytar);

async function loginWithSso(backendUrl, tenantId) {
  const { discovery, buildAuthorizationUrl, calculatePKCECodeChallenge, randomPKCECodeVerifier, randomState, authorizationCodeGrant } = await import('openid-client');

  const configResponse = await fetch(`${backendUrl}/tenants/${tenantId}/oidc-config`);
  if (!configResponse.ok) throw new Error('Tenant SSO is not configured on the backend');
  const { issuerUrl, clientId, redirectUri } = await configResponse.json();

  const config = await discovery(new URL(issuerUrl), clientId, undefined, undefined, {
    [discovery.INSECURE_ALLOW_HTTP]: true,
  });

  const codeVerifier = randomPKCECodeVerifier();
  const codeChallenge = await calculatePKCECodeChallenge(codeVerifier);
  const state = randomState();

  const authUrl = buildAuthorizationUrl(config, {
    redirect_uri: redirectUri,
    scope: 'openid email profile',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
  });

  const redirectPort = Number(new URL(redirectUri).port);
  const ssoIdToken = await new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const reqUrl = new URL(req.url, `http://127.0.0.1:${redirectPort}`);
        const params = reqUrl.searchParams;
        if (params.get('state') !== state) throw new Error('OAuth state mismatch');
        const tokenResponse = await authorizationCodeGrant(config, reqUrl, {
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
          expectedNonce: undefined,
        });
        res.end('Login successful — you can close this window and return to Savvy.');
        server.close();
        resolve(tokenResponse.id_token);
      } catch (err) {
        res.end('Login failed: ' + err.message);
        server.close();
        reject(err);
      }
    });
    server.listen(redirectPort, '127.0.0.1', () => {
      shell.openExternal(authUrl.toString());
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
