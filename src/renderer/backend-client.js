async function backendFetch(backendUrl, authState, urlPath, options = {}) {
  const headers = {
    ...(options.headers || {}),
    'Content-Type': 'application/json',
    Authorization: `Bearer ${authState.sessionToken}`,
  };
  if (authState.ssoIdToken) headers['x-sso-id-token'] = authState.ssoIdToken;

  const response = await fetch(`${backendUrl}${urlPath}`, { ...options, headers });
  if (!response.ok) throw new Error(`Backend error ${response.status} for ${urlPath}`);
  return response.json();
}

function makeBackendClient({ backendUrl, getAuthState }) {
  return {
    getConversationHistory: async () => backendFetch(backendUrl, await getAuthState(), '/conversation-history'),
    saveConversationHistory: async (history) =>
      backendFetch(backendUrl, await getAuthState(), '/conversation-history', { method: 'PUT', body: JSON.stringify(history) }),
    fetchReferenceData: async (category) => backendFetch(backendUrl, await getAuthState(), `/reference-data/${category}`),
    fetchPersonData: async (resourcePath) => backendFetch(backendUrl, await getAuthState(), `/hcm-proxy${resourcePath}`),
  };
}

module.exports = { makeBackendClient };
