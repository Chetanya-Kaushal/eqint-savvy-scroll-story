const { describe, it, expect, vi } = require('vitest');
const { loadPolicyConfig } = require('../../src/main/policy-config');

describe('loadPolicyConfig', () => {
  it('reads and parses the IT-managed policy file when present on Windows', () => {
    const readFileFn = vi.fn().mockReturnValue(JSON.stringify({ tenantId: 'tenant-abc', backendUrl: 'https://api.acme.example.com' }));
    const result = loadPolicyConfig(readFileFn, 'win32');
    expect(readFileFn).toHaveBeenCalledWith('C:\\ProgramData\\EQInt\\Savvy\\policy.json', 'utf8');
    expect(result).toEqual({ tenantId: 'tenant-abc', backendUrl: 'https://api.acme.example.com' });
  });

  it('returns null when the policy file does not exist', () => {
    const readFileFn = vi.fn().mockImplementation(() => { throw Object.assign(new Error('not found'), { code: 'ENOENT' }); });
    expect(loadPolicyConfig(readFileFn, 'win32')).toBe(null);
  });
});
