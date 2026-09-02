import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeSecureStorage } from '../../src/main/secure-storage.js';

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (str) => Buffer.from(str, 'utf8').reverse(),
    decryptString: (buf) => Buffer.from(buf).reverse().toString('utf8'),
  };
}

describe('secure-storage', () => {
  let tmpFile;
  beforeEach(() => { tmpFile = path.join(os.tmpdir(), `secure-storage-test-${Date.now()}.json`); });
  afterEach(() => { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); });

  it('round-trips an object through writeEncryptedFile/readEncryptedFile', () => {
    const { writeEncryptedFile, readEncryptedFile } = makeSecureStorage(fakeSafeStorage());
    const original = { employees: [{ name: 'Jane Doe', salary: 120000 }] };
    writeEncryptedFile(tmpFile, original);
    expect(readEncryptedFile(tmpFile)).toEqual(original);
  });

  it('never writes plaintext PII to disk when encryption is available', () => {
    const { writeEncryptedFile } = makeSecureStorage(fakeSafeStorage());
    writeEncryptedFile(tmpFile, { employees: [{ name: 'Jane Doe', salary: 120000 }] });
    const raw = fs.readFileSync(tmpFile, 'utf8');
    expect(raw.includes('Jane Doe')).toBe(false);
    expect(raw.includes('120000')).toBe(false);
  });

  it('falls back to plaintext when encryption is unavailable, and readEncryptedFile still round-trips it', () => {
    const unavailable = { ...fakeSafeStorage(), isEncryptionAvailable: () => false };
    const { writeEncryptedFile, readEncryptedFile } = makeSecureStorage(unavailable);
    const original = { employees: [{ name: 'Jane Doe' }] };
    writeEncryptedFile(tmpFile, original);
    expect(readEncryptedFile(tmpFile)).toEqual(original);
  });

  it('encryptField/decryptField round-trip a single string value', () => {
    const { encryptField, decryptField } = makeSecureStorage(fakeSafeStorage());
    const encrypted = encryptField('super-secret-password');
    expect(encrypted).not.toBe('super-secret-password');
    expect(decryptField(encrypted)).toBe('super-secret-password');
  });

  it('readEncryptedFile returns null for a missing file', () => {
    const { readEncryptedFile } = makeSecureStorage(fakeSafeStorage());
    expect(readEncryptedFile(path.join(os.tmpdir(), 'does-not-exist.json'))).toBe(null);
  });
});
