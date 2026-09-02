const fs = require('fs');

function makeSecureStorage(safeStorage) {
  function writeEncryptedFile(filePath, obj) {
    const json = JSON.stringify(obj);
    const enc = safeStorage.isEncryptionAvailable();
    if (!enc) console.warn(`OS-level encryption unavailable; writing ${filePath} in plaintext as a fallback.`);
    const payload = enc ? safeStorage.encryptString(json).toString('base64') : json;
    fs.writeFileSync(filePath, JSON.stringify({ enc, payload }));
  }

  function readEncryptedFile(filePath) {
    if (!fs.existsSync(filePath)) return null;
    const wrapper = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!wrapper.enc) return JSON.parse(wrapper.payload);
    return JSON.parse(safeStorage.decryptString(Buffer.from(wrapper.payload, 'base64')));
  }

  function encryptField(value) {
    if (!value) return value;
    if (!safeStorage.isEncryptionAvailable()) {
      console.warn('OS-level encryption unavailable; storing field in plaintext as a fallback.');
      return value;
    }
    return 'enc:' + safeStorage.encryptString(value).toString('base64');
  }

  function decryptField(value) {
    if (!value || !value.startsWith('enc:')) return value || '';
    try {
      return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'));
    } catch (err) {
      console.error('Failed to decrypt stored field:', err);
      return '';
    }
  }

  return { writeEncryptedFile, readEncryptedFile, encryptField, decryptField };
}

module.exports = { makeSecureStorage };
