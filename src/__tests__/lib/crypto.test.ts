/**
 * Tests for lib/crypto.ts — AES-256-GCM encrypt/decrypt, key rotation, masking
 */

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  jest.resetModules();
  process.env = { ...ORIGINAL_ENV };
  process.env.ENCRYPTION_KEY = 'test-encryption-key-32chars!!!';
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

function loadCrypto() {
  return require('../../lib/crypto') as typeof import('../../lib/crypto');
}

describe('encrypt / decrypt round-trip', () => {
  it('should encrypt and decrypt back to original text', () => {
    const { encrypt, decrypt } = loadCrypto();
    const plaintext = 'sk-1234567890abcdef';
    const cipherText = encrypt(plaintext);
    expect(decrypt(cipherText)).toBe(plaintext);
  });

  it('should produce v1: prefixed ciphertext', () => {
    const { encrypt } = loadCrypto();
    const cipherText = encrypt('test');
    expect(cipherText.startsWith('v1:')).toBe(true);
  });

  it('should produce different ciphertext on each call (random IV)', () => {
    const { encrypt } = loadCrypto();
    const a = encrypt('same-text');
    const b = encrypt('same-text');
    expect(a).not.toBe(b);
  });

  it('should handle unicode text', () => {
    const { encrypt, decrypt } = loadCrypto();
    const plaintext = '中文API密钥🔑';
    expect(decrypt(encrypt(plaintext))).toBe(plaintext);
  });

  it('should handle long text', () => {
    const { encrypt, decrypt } = loadCrypto();
    const plaintext = 'a'.repeat(10000);
    expect(decrypt(encrypt(plaintext))).toBe(plaintext);
  });
});

describe('encrypt edge cases', () => {
  it('should throw on empty string', () => {
    const { encrypt } = loadCrypto();
    expect(() => encrypt('')).toThrow('input text is empty');
  });
});

describe('decrypt edge cases', () => {
  it('should throw on empty string', () => {
    const { decrypt } = loadCrypto();
    expect(() => decrypt('')).toThrow('input ciphertext is empty');
  });

  it('should throw on corrupted ciphertext', () => {
    const { decrypt } = loadCrypto();
    expect(() => decrypt('v1:corrupted-base64-data!!!')).toThrow();
  });

  it('should throw on wrong key', () => {
    const { encrypt } = loadCrypto();
    const cipherText = encrypt('secret');

    // Reload module with different key
    jest.resetModules();
    process.env.ENCRYPTION_KEY = 'different-key-32chars-here!!!!';
    const { decrypt } = loadCrypto();

    expect(() => decrypt(cipherText)).toThrow('key mismatch or data corrupted');
  });
});

describe('decrypt with OLD_ENCRYPTION_KEY fallback', () => {
  it('should decrypt using old key when current key fails', () => {
    // Encrypt with key A
    process.env.ENCRYPTION_KEY = 'old-key-for-encryption-32chars!';
    const { encrypt: encryptOld } = loadCrypto();
    const cipherText = encryptOld('my-secret');

    // Switch to key B with key A as OLD
    jest.resetModules();
    process.env.ENCRYPTION_KEY = 'new-key-for-encryption-32chars!';
    process.env.OLD_ENCRYPTION_KEY = 'old-key-for-encryption-32chars!';
    const { decrypt: decryptNew } = loadCrypto();

    expect(decryptNew(cipherText)).toBe('my-secret');
  });
});

describe('reEncrypt', () => {
  it('should re-encrypt ciphertext with current key', () => {
    // Encrypt with old key
    process.env.ENCRYPTION_KEY = 'old-key-for-encryption-32chars!';
    const { encrypt: encryptOld } = loadCrypto();
    const oldCipher = encryptOld('api-key-value');

    // Switch to new key, set old as fallback
    jest.resetModules();
    process.env.ENCRYPTION_KEY = 'new-key-for-encryption-32chars!';
    process.env.OLD_ENCRYPTION_KEY = 'old-key-for-encryption-32chars!';
    const { reEncrypt, decrypt } = loadCrypto();

    const newCipher = reEncrypt(oldCipher);
    expect(newCipher).not.toBe(oldCipher);
    expect(decrypt(newCipher)).toBe('api-key-value');
  });

  it('should return falsy input as-is', () => {
    const { reEncrypt } = loadCrypto();
    expect(reEncrypt('')).toBe('');
  });
});

describe('maskApiKey', () => {
  it('should mask middle of API key', () => {
    const { maskApiKey } = loadCrypto();
    expect(maskApiKey('sk-1234567890abcdef')).toBe('sk-1****cdef');
  });

  it('should return **** for short keys', () => {
    const { maskApiKey } = loadCrypto();
    expect(maskApiKey('short')).toBe('****');
  });

  it('should return empty string for empty input', () => {
    const { maskApiKey } = loadCrypto();
    expect(maskApiKey('')).toBe('');
  });

  it('should handle exactly 9 char key', () => {
    const { maskApiKey } = loadCrypto();
    expect(maskApiKey('123456789')).toBe('1234****6789');
  });
});

describe('ENCRYPTION_KEY validation', () => {
  it('should throw if key is too short', () => {
    jest.resetModules();
    process.env.ENCRYPTION_KEY = 'short';
    expect(() => loadCrypto()).toThrow('ENCRYPTION_KEY too short');
  });

  it('should use dev default and warn when ENCRYPTION_KEY is unset', () => {
    jest.resetModules();
    delete process.env.ENCRYPTION_KEY;
    const errorSpy = jest.spyOn(console, 'error').mockImplementation();

    const { encrypt, decrypt } = loadCrypto();
    // Should still work with default key
    const cipher = encrypt('test');
    expect(decrypt(cipher)).toBe('test');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('ENCRYPTION_KEY'));

    errorSpy.mockRestore();
  });
});
