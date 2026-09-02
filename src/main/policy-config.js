function policyPathFor(platform) {
  if (platform === 'win32') return 'C:\\ProgramData\\EQInt\\Savvy\\policy.json';
  if (platform === 'darwin') return '/Library/Application Support/EQInt/Savvy/policy.json';
  return '/etc/eqint-savvy/policy.json';
}

function loadPolicyConfig(readFileFn, platform) {
  try {
    const raw = readFileFn(policyPathFor(platform), 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    console.error('Failed to read IT-managed policy config:', err);
    return null;
  }
}

module.exports = { loadPolicyConfig, policyPathFor };
