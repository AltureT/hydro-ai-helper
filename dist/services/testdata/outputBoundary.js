"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.answerBoundaryRequired = answerBoundaryRequired;
exports.assertAnswerBoundaryCoverage = assertAnswerBoundaryCoverage;
const failures_1 = require("./failures");
function answerBoundaryRequired(statement, outputKind = 'exact', scale = 'auto') {
    if (!['exact', 'token'].includes(outputKind) || !['auto', 'large'].includes(scale))
        return false;
    // Only explicit answer claims in prose: input widths, generic type advice and code are not evidence.
    const prose = statement.replace(/(`{3,}|~{3,})[^\n]*\n[\s\S]*?\1/g, '').replace(/\*\*/g, '');
    return /(?:^|[。！？；，\n])\s*(?:注意[：:]\s*)?答案可能超过\s*32\s*位(?:有符号整数)?/.test(prose)
        || /(?:^|[.!?\n])\s*(?:the )?answer may exceed (?:a )?(?:signed )?32[- ]bit integer\b/i.test(prose);
}
function exceedsInt32(token) {
    const negative = token.startsWith('-');
    const digits = token.replace(/^[+-]/, '').replace(/^0+/, '') || '0';
    const limit = negative ? '2147483648' : '2147483647';
    return digits.length > limit.length || (digits.length === limit.length && digits > limit);
}
function hasPlainIntegerAnswerFormat(statement) {
    const prose = statement.replace(/(`{3,}|~{3,})[^\n]*\n[\s\S]*?\1/g, '').replace(/\*\*/g, '');
    // A deliberately closed output protocol: a single answer integer per line. Other
    // formats need an explicit answer-field schema before their tokens can be evidence.
    const section = /(?:^|\n)#{1,6}\s*(?:输出格式|Output(?: Format)?)\s*\n([\s\S]*?)(?=\n#{1,6}\s|$)/i.exec(prose)?.[1]?.trim();
    if (section && !/编号|标签|前缀|Case\s*#|\b(?:ID|YES|NO)\b/i.test(section)
        && /一行一个整数|输出一行整数|\boutput (?:one|a single) integer\b/i.test(section))
        return true;
    return /模板[^\n。]*调用[^\n。]*输出返回值一行/.test(prose)
        || /函数返回整数/.test(prose) && /输出返回值一行/.test(prose);
}
function assertAnswerBoundaryCoverage(statement, formalOutputs, outputKind = 'exact', scale = 'auto') {
    if (!answerBoundaryRequired(statement, outputKind, scale))
        return;
    const lines = formalOutputs.flatMap(output => output.trim() ? output.trim().split(/\r?\n/).map(line => line.trim()) : []);
    if (!hasPlainIntegerAnswerFormat(statement) || lines.some(line => !/^[+-]?\d+$/.test(line))) {
        throw new failures_1.TestdataPipelineError('题面提示答案可能超过 32 位，但当前输出协议无法确定每行的答案整数。答案边界尚未证明，请人工复核输出格式与边界数据。', 'COVERAGE_REQUIREMENT_MISSING', 'generator', 'coverage', 'manual-review');
    }
    const witness = lines.some(exceedsInt32);
    if (!witness) {
        throw new failures_1.TestdataPipelineError('题面明确提示答案可能超过 32 位整数，但正式测试点的实际 ORACLE 输出均未证明该边界。请只修复 GENERATOR，保留既定点数和字节预算，构造至少一个答案超出 [-2147483648, 2147483647] 的合法正式输入；不能用最大 n、输入值大小或压力样例代替答案证据。', 'COVERAGE_REQUIREMENT_MISSING', 'generator', 'generator', 'repair-artifact');
    }
}
//# sourceMappingURL=outputBoundary.js.map