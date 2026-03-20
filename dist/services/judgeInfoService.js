"use strict";
/**
 * 评测数据格式化服务
 * 将 RecordDoc 的评测字段转换为紧凑、prompt-safe 的摘要文本
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatJudgeInfo = formatJudgeInfo;
const STATUS_SHORT_TEXT = {
    0: 'Waiting',
    1: 'AC',
    2: 'WA',
    3: 'TLE',
    4: 'MLE',
    5: 'OLE',
    6: 'RE',
    7: 'CE',
    8: 'SE',
    9: 'Canceled',
    10: 'ETC',
    11: 'Hacked',
    20: 'Judging',
    21: 'Compiling',
    22: 'Fetched',
    30: 'Ignored',
    31: 'FE',
};
function stripAnsi(text) {
    // Remove common ANSI escape sequences (colors, cursor control, etc.)
    // This keeps judge/compiler output prompt-safe and avoids noise.
    return text
        // OSC: ESC ] ... BEL or ESC \
        // eslint-disable-next-line no-control-regex
        .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, '')
        // CSI: ESC [ ... cmd
        // eslint-disable-next-line no-control-regex
        .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '');
}
function sanitizeText(text) {
    return stripAnsi(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\0/g, '');
}
function truncate(text, maxLen) {
    if (text.length <= maxLen)
        return text;
    return text.slice(0, maxLen) + '...(truncated)';
}
function limitLines(text, maxLines, maxLineLen) {
    const lines = text.split('\n');
    const limited = lines.slice(0, maxLines).map((line) => (line.length > maxLineLen ? `${line.slice(0, maxLineLen)}...(truncated line)` : line));
    let result = limited.join('\n');
    if (lines.length > maxLines) {
        result += `\n...(truncated ${lines.length - maxLines} more lines)`;
    }
    return result;
}
function formatTemplate(msg) {
    if (!msg)
        return '';
    if (typeof msg === 'string')
        return msg;
    if (!msg.message)
        return '';
    let result = msg.message;
    if (msg.params?.length) {
        for (let i = 0; i < msg.params.length; i++) {
            result = result.split(`{${i}}`).join(msg.params[i] ?? '');
        }
    }
    return result;
}
const TOTAL_HARD_LIMIT = 2600;
const COMPILER_LIMIT = 1000;
const JUDGE_TEXT_LIMIT = 800;
const MESSAGE_LIMIT = 300;
const MAX_FAILED_CASES = 5;
const MAX_OUTPUT_LINES = 80;
const MAX_OUTPUT_LINE_LEN = 320;
function formatJudgeInfo(record) {
    if (!record || (record.status === undefined && !record.testCases?.length && !record.compilerTexts?.length)) {
        return undefined;
    }
    const parts = [];
    // 基本信息
    const headerLines = ['【评测结果摘要】'];
    if (record.lang) {
        headerLines.push(`- 语言: ${record.lang}`);
    }
    if (record.status !== undefined) {
        const statusText = STATUS_SHORT_TEXT[record.status] ?? `Unknown(${record.status})`;
        headerLines.push(`- 总状态: ${statusText}(${record.status})${record.score !== undefined ? `  分数: ${record.score}` : ''}`);
    }
    // 测试点统计
    const cases = record.testCases ?? [];
    if (cases.length > 0) {
        const passed = cases.filter((c) => c.status === 1).length;
        headerLines.push(`- 测试点: ${passed}/${cases.length} 通过`);
    }
    parts.push(headerLines.join('\n'));
    // 失败测试点详情（仅包含明确失败状态，排除 Waiting/Judging/Ignored 等）
    const FAILURE_STATUSES = [2, 3, 4, 5, 6, 7, 8, 10, 11, 31]; // WA/TLE/MLE/OLE/RE/CE/SE/ETC/Hacked/FE
    const failedCases = cases.filter((c) => c.status !== undefined && FAILURE_STATUSES.includes(c.status));
    if (failedCases.length > 0) {
        const caseLines = ['【失败测试点（最多 5 个）】'];
        for (const tc of failedCases.slice(0, MAX_FAILED_CASES)) {
            const id = tc.id ?? '?';
            const st = tc.status !== undefined ? (STATUS_SHORT_TEXT[tc.status] ?? `${tc.status}`) : '?';
            const stCode = tc.status !== undefined ? `(${tc.status})` : '';
            let line = `#${id} status=${st}${stCode}`;
            if (tc.time !== undefined)
                line += ` time=${tc.time}ms`;
            if (tc.memory !== undefined)
                line += ` memory=${tc.memory}KB`;
            caseLines.push(line);
            const msg = formatTemplate(tc.message);
            if (msg) {
                caseLines.push(`  message: ${truncate(sanitizeText(msg), MESSAGE_LIMIT)}`);
            }
        }
        if (failedCases.length > MAX_FAILED_CASES) {
            caseLines.push(`...还有 ${failedCases.length - MAX_FAILED_CASES} 个失败测试点`);
        }
        parts.push(caseLines.join('\n'));
    }
    // 编译/语法输出
    const compilerTexts = record.compilerTexts ?? [];
    const compilerContent = compilerTexts
        .map((t) => sanitizeText(typeof t === 'string' ? t : ''))
        .filter(Boolean)
        .join('\n');
    if (compilerContent) {
        const normalized = limitLines(compilerContent, MAX_OUTPUT_LINES, MAX_OUTPUT_LINE_LEN);
        parts.push(`【编译/语法输出（节选）】\n${truncate(normalized, COMPILER_LIMIT)}`);
    }
    // 判题输出
    const judgeTexts = record.judgeTexts ?? [];
    const judgeContent = judgeTexts
        .map((t) => sanitizeText(formatTemplate(t)))
        .filter(Boolean)
        .join('\n');
    if (judgeContent) {
        const normalized = limitLines(judgeContent, MAX_OUTPUT_LINES, MAX_OUTPUT_LINE_LEN);
        parts.push(`【判题输出（节选）】\n${truncate(normalized, JUDGE_TEXT_LIMIT)}`);
    }
    let result = parts.join('\n\n');
    if (result.length > TOTAL_HARD_LIMIT) {
        result = result.slice(0, TOTAL_HARD_LIMIT) + '\n...(truncated)';
    }
    return result;
}
//# sourceMappingURL=judgeInfoService.js.map