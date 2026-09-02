import { makeAwsKmsProvider, KmsProvider } from './field-encryption';

let _kmsProvider: KmsProvider | null = null;

export function setKmsProvider(provider: KmsProvider): void {
  _kmsProvider = provider;
}

function getOrCreate(): KmsProvider {
  if (!_kmsProvider) {
    _kmsProvider = makeAwsKmsProvider(process.env.KMS_KEY_ID!);
  }
  return _kmsProvider;
}

export const kmsProvider: KmsProvider = {
  generateDataKey: () => getOrCreate().generateDataKey(),
  decryptDataKey: (wrappedKey) => getOrCreate().decryptDataKey(wrappedKey),
};
