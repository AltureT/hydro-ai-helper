/**
 * Crypto 加解密工具
 *
 * 使用 AES-256-GCM 加密 API Key 等敏感信息
 */

import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;        // GCM 推荐 12 字节 IV
const AUTH_TAG_LENGTH = 16;  // GCM 认证标签长度
const CIPHER_VERSION_PREFIX = 'v1:';
const MIN_KEY_LENGTH = 16;

function deriveKey(raw: string): Buffer {
  return createHash('sha256').update(raw).digest();
}

function getEncryptionKey(): Buffer {
  const keyRaw = process.env.ENCRYPTION_KEY;

  if (!keyRaw) {
    console.error('[Crypto] ENCRYPTION_KEY env var not set, using default key');
    console.error('[Crypto] Please set ENCRYPTION_KEY in production to secure API keys!');
    return deriveKey('dev-encryption-key-please-change-me-32');
  }

  if (keyRaw.length < MIN_KEY_LENGTH) {
    throw new Error(
      `[Crypto] ENCRYPTION_KEY too short: minimum ${MIN_KEY_LENGTH} chars, got ${keyRaw.length}`
    );
  }

  return deriveKey(keyRaw);
}

function getOldEncryptionKey(): Buffer | null {
  const oldKeyRaw = process.env.OLD_ENCRYPTION_KEY;
  if (!oldKeyRaw) return null;
  return deriveKey(oldKeyRaw);
}

const ENCRYPTION_KEY = getEncryptionKey();

/**
 * 加密文本
 * @param text 明文
 * @returns "v1:" + Base64 编码的密文(包含 IV + AuthTag + Encrypted)
 */
export function encrypt(text: string): string {
  if (!text) {
    throw new Error('Encryption failed: input text is empty');
  }

  try {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv);

    const encrypted = Buffer.concat([
      cipher.update(text, 'utf8'),
      cipher.final()
    ]);

    const authTag = cipher.getAuthTag();
    const combined = Buffer.concat([iv, authTag, encrypted]);

    return CIPHER_VERSION_PREFIX + combined.toString('base64');
  } catch (_error) {
    throw new Error('Encryption failed: check encryption configuration');
  }
}

function decryptWithKey(payload: Buffer, key: Buffer): string {
  const iv = payload.subarray(0, IV_LENGTH);
  const authTag = payload.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = payload.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final()
  ]);

  return decrypted.toString('utf8');
}

/**
 * 解密文本
 * 支持 v1: 前缀格式和旧版无前缀格式
 * 依次尝试：当前密钥 → 旧密钥 (OLD_ENCRYPTION_KEY)
 * @param cipherText 密文
 * @returns 解密后的明文
 */
export function decrypt(cipherText: string): string {
  if (!cipherText) {
    throw new Error('Decryption failed: input ciphertext is empty');
  }

  const isV1 = cipherText.startsWith(CIPHER_VERSION_PREFIX);
  const raw = isV1 ? cipherText.slice(CIPHER_VERSION_PREFIX.length) : cipherText;
  const payload = Buffer.from(raw, 'base64');

  const oldKey = getOldEncryptionKey();
  const keysToTry: Buffer[] = [ENCRYPTION_KEY];
  if (oldKey) keysToTry.push(oldKey);

  for (const key of keysToTry) {
    try {
      return decryptWithKey(payload, key);
    } catch {
      // 当前密钥失败，尝试下一个
    }
  }

  throw new Error('Decryption failed: key mismatch or data corrupted');
}

/**
 * 使用旧密钥解密后用当前密钥重新加密
 * 用于密钥轮换迁移
 * @param cipherText 旧密文
 * @returns 新密文（v1: 格式），如果已是当前密钥加密则原样返回
 */
export function reEncrypt(cipherText: string): string {
  if (!cipherText) return cipherText;

  const plaintext = decrypt(cipherText);
  const newCipherText = encrypt(plaintext);

  return newCipherText;
}

/**
 * API Key 脱敏显示
 * @param apiKeyPlain 明文 API Key
 * @returns 脱敏后的字符串(如 "sk-12****abcd")
 */
export function maskApiKey(apiKeyPlain: string): string {
  if (!apiKeyPlain) {
    return '';
  }

  const len = apiKeyPlain.length;

  if (len <= 8) {
    return '****';
  }

  const start = apiKeyPlain.slice(0, 4);
  const end = apiKeyPlain.slice(-4);

  return `${start}****${end}`;
}
