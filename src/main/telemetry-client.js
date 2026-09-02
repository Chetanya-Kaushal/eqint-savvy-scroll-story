const PII_FIELD_NAMES = ['email', 'message', 'content', 'name', 'ssn', 'password'];

function scrub(properties) {
  const scrubbed = {};
  for (const [key, value] of Object.entries(properties)) {
    if (PII_FIELD_NAMES.includes(key.toLowerCase())) continue;
    scrubbed[key] = value;
  }
  return scrubbed;
}

function makeTelemetryClient({ backendUrl, getAuthState, enabled }) {
  return {
    async recordEvent(name, properties = {}) {
      if (!enabled) return;
      const authState = await getAuthState();
      await fetch(`${backendUrl}/telemetry/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authState.sessionToken}` },
        body: JSON.stringify({ name, properties: scrub(properties) }),
      });
    },
  };
}

module.exports = { makeTelemetryClient };
