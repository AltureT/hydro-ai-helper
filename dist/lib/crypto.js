"use strict";
/**
 * Crypto 加解密工具
 *
 * 使用 AES-256-GCM 加密 API Key 等敏感信息
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.encrypt = encrypt;
exports.decrypt = decrypt;
exports.maskApiKey = maskApiKey;
const crypto_1 = require("crypto");
/**
 * 加密密钥(32 字节)
 * 从环境变量读取，若不存在则使用默认值(仅开发环境)
 */
function getEncryptionKey() {
    const keyRaw = process.env.ENCRYPTION_KEY || 'dev-encryption-key-please-change-me-32';
    // 如果环境变量不存在，打印警告(但不打印密钥本身)
    if (!process.env.ENCRYPTION_KEY) {
        console.warn('[Crypto] ⚠️  ENCRYPTION_KEY 环境变量未设置，使用默认密钥(仅开发环境)');
        console.warn('[Crypto] ⚠️  生产环境请务必设置 ENCRYPTION_KEY 环境变量！');
    }
    // 使用 SHA-256 哈希生成固定 32 字节密钥
    return (0, crypto_1.createHash)('sha256').update(keyRaw).digest();
}
const ENCRYPTION_KEY = getEncryptionKey();
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // GCM 推荐 12 字节 IV
const AUTH_TAG_LENGTH = 16; // GCM 认证标签长度
/**
 * 加密文本
 * @param text 明文
 * @returns Base64 编码的密文(包含 IV + AuthTag + Encrypted)
 */
function encrypt(text) {
    if (!text) {
        throw new Error('加密失败：输入文本不能为空');
    }
    try {
        // 生成随机 IV
        const iv = (0, crypto_1.randomBytes)(IV_LENGTH);
        // 创建加密器
        const cipher = (0, crypto_1.createCipheriv)(ALGORITHM, ENCRYPTION_KEY, iv);
        // 加密数据
        const encrypted = Buffer.concat([
            cipher.update(text, 'utf8'),
            cipher.final()
        ]);
        // 获取认证标签
        const authTag = cipher.getAuthTag();
        // 拼接: IV(12) + AuthTag(16) + Encrypted(N)
        const combined = Buffer.concat([iv, authTag, encrypted]);
        // 返回 Base64 编码
        return combined.toString('base64');
    }
    catch (error) {
        throw new Error(`加密失败: ${error instanceof Error ? error.message : String(error)}`);
    }
}
/**
 * 解密文本
 * @param cipherText Base64 编码的密文
 * @returns 解密后的明文
 */
function decrypt(cipherText) {
    if (!cipherText) {
        throw new Error('解密失败：输入密文不能为空');
    }
    try {
        // 解码 Base64
        const combined = Buffer.from(cipherText, 'base64');
        // 分离 IV + AuthTag + Encrypted
        const iv = combined.subarray(0, IV_LENGTH);
        const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
        const encrypted = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
        // 创建解密器
        const decipher = (0, crypto_1.createDecipheriv)(ALGORITHM, ENCRYPTION_KEY, iv);
        decipher.setAuthTag(authTag);
        // 解密数据
        const decrypted = Buffer.concat([
            decipher.update(encrypted),
            decipher.final()
        ]);
        return decrypted.toString('utf8');
    }
    catch (error) {
        // 解密失败可能是密钥错误或数据损坏
        throw new Error(`解密失败: ${error instanceof Error ? error.message : String(error)}`);
    }
}
/**
 * API Key 脱敏显示
 * @param apiKeyPlain 明文 API Key
 * @returns 脱敏后的字符串(如 "sk-12****abcd")
 */
function maskApiKey(apiKeyPlain) {
    if (!apiKeyPlain) {
        return '';
    }
    const len = apiKeyPlain.length;
    // 如果长度 <= 8，简单返回 ****
    if (len <= 8) {
        return '****';
    }
    // 保留前 4 和后 4 位，中间用 **** 替换
    const start = apiKeyPlain.slice(0, 4);
    const end = apiKeyPlain.slice(-4);
    return `${start}****${end}`;
}
//# sourceMappingURL=crypto.js.map