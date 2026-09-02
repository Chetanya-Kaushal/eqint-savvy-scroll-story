import { describe, it, expect } from 'vitest';
import { encryptField, decryptField, KmsProvider } from '../../src/security/field-encryption';

function fakeKms(): KmsProvider {
  const fixedKey = Buffer.alloc(32, 9);
  return {
    generateDataKey: async () => ({ plaintextKey: fixedKey, wrappedKey: Buffer.from('wrapped-fixed-key') }),
    decryptDataKey: async () => fixedKey,
  };
}

describe('field-encryption with KMS envelope', () => {
  it('round-trips a value through encryptField/decryptField', async () => {
    const kms = fakeKms();
    const encrypted = await encryptField(kms, 'super-secret-password');
    expect(encrypted).not.toContain('super-secret-password');
    expect(await decryptField(kms, encrypted)).toBe('super-secret-password');
  });
});
