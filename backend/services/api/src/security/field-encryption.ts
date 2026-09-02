import crypto from 'crypto';
import { KMSClient, GenerateDataKeyCommand, DecryptCommand } from '@aws-sdk/client-kms';

export interface KmsProvider {
  generateDataKey(): Promise<{ plaintextKey: Buffer; wrappedKey: Buffer }>;
  decryptDataKey(wrappedKey: Buffer): Promise<Buffer>;
}

export function makeAwsKmsProvider(keyId: string): KmsProvider {
  const client = new KMSClient({});
  return {
    async generateDataKey() {
      const result = await client.send(new GenerateDataKeyCommand({ KeyId: keyId, KeySpec: 'AES_256' }));
      return { plaintextKey: Buffer.from(result.Plaintext!), wrappedKey: Buffer.from(result.CiphertextBlob!) };
    },
    async decryptDataKey(wrappedKey: Buffer) {
      const result = await client.send(new DecryptCommand({ CiphertextBlob: wrappedKey, KeyId: keyId }));
      return Buffer.from(result.Plaintext!);
    },
  };
}

// Envelope format: base64(wrappedKeyLength(4 bytes) + wrappedKey + iv(12) + authTag(16) + ciphertext)
export async function encryptField(kms: KmsProvider, value: string): Promise<string> {
  const { plaintextKey, wrappedKey } = await kms.generateDataKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', plaintextKey, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const wrappedKeyLength = Buffer.alloc(4);
  wrappedKeyLength.writeUInt32BE(wrappedKey.length);

  return Buffer.concat([wrappedKeyLength, wrappedKey, iv, authTag, encrypted]).toString('base64');
}

export async function decryptField(kms: KmsProvider, value: string): Promise<string> {
  const raw = Buffer.from(value, 'base64');
  const wrappedKeyLength = raw.readUInt32BE(0);
  let offset = 4;
  const wrappedKey = raw.subarray(offset, offset + wrappedKeyLength);
  offset += wrappedKeyLength;
  const iv = raw.subarray(offset, offset + 12);
  offset += 12;
  const authTag = raw.subarray(offset, offset + 16);
  offset += 16;
  const encrypted = raw.subarray(offset);

  const plaintextKey = await kms.decryptDataKey(wrappedKey);
  const decipher = crypto.createDecipheriv('aes-256-gcm', plaintextKey, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}
