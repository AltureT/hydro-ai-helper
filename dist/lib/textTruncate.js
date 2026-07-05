"use strict";
/**
 * 字节安全的文本摘录工具：规范化换行、去尾部空白，UTF-8 超限时按字符
 * 安全截断并加省略号，保证最终字节数不超过 maxBytes（含省略号）。
 * 用于把失败上下文回喂 AI / 展示给教师（testdataGenService 与
 * goJudgeSandboxService 共用，勿在此文件 import 任何 service）。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.excerpt = excerpt;
exports.excerptTail = excerptTail;
const ELLIPSIS = '…';
function normalize(text) {
    return (text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\s+$/, '');
}
/** 头部摘录：保留开头，超限截尾。适合输入内容等"开头最重要"的文本。 */
function excerpt(text, maxBytes = 300) {
    const normalized = normalize(text);
    if (Buffer.byteLength(normalized, 'utf8') <= maxBytes)
        return normalized;
    const budget = maxBytes - Buffer.byteLength(ELLIPSIS, 'utf8');
    // 先按字符粗切一刀避免对超长文本逐字符收敛（budget 个字符的字节数必然 ≥ budget）
    let cut = normalized.slice(0, budget);
    while (cut.length > 0 && Buffer.byteLength(cut, 'utf8') > budget) {
        cut = cut.slice(0, -1);
    }
    return `${cut.replace(/\s+$/, '')}${ELLIPSIS}`;
}
/** 尾部摘录：保留结尾，超限截头。适合 Python traceback（关键错误行在最后）。 */
function excerptTail(text, maxBytes = 1000) {
    const normalized = normalize(text);
    if (Buffer.byteLength(normalized, 'utf8') <= maxBytes)
        return normalized;
    const budget = maxBytes - Buffer.byteLength(ELLIPSIS, 'utf8');
    // 先按字符粗切一刀（budget 个字符字节数必然 ≥ budget 时才需要继续收缩），再逐字符收敛
    let cut = normalized.slice(-budget);
    while (cut.length > 0 && Buffer.byteLength(cut, 'utf8') > budget) {
        cut = cut.slice(1);
    }
    return `${ELLIPSIS}${cut.replace(/^\s+/, '')}`;
}
//# sourceMappingURL=textTruncate.js.map