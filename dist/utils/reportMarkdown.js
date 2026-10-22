"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeReportMarkdown = normalizeReportMarkdown;
exports.isPythonLanguage = isPythonLanguage;
exports.normalizeHomeworkMarkdown = normalizeHomeworkMarkdown;
const markdown_it_1 = __importDefault(require("markdown-it"));
const parser = new markdown_it_1.default({ html: false });
const worksheetBlank = '________';
const lt = String.raw `(?:\\?<|&lt;|&#0*60;|&#x0*3c;)`;
const gt = String.raw `(?:\\?>|&gt;|&#0*62;|&#x0*3e;)`;
const thinkingStart = new RegExp(`^\\s*${lt}think${gt}`, 'i');
const thinkingEnd = new RegExp(`${lt}\\\\?/think${gt}`, 'i');
/** Normalize report structure, never decode arbitrary HTML or rewrite source examples. */
function normalizeReportMarkdown(content) {
    let result = content;
    while (thinkingStart.test(result)) {
        // Four-space indentation means a literal code block, not provider metadata.
        if (parser.parse(result, {})[0]?.type === 'code_block')
            break;
        const end = thinkingEnd.exec(result);
        if (!end)
            return ''; // An unfinished provider wrapper has no visible report.
        result = result.slice(end.index + end[0].length).replace(/^(?:[\t ]*\r?\n)+/, '');
    }
    const protectedLines = new Set();
    for (const token of parser.parse(result, {})) {
        if ((token.type === 'fence' || token.type === 'code_block'
            || (token.type === 'inline' && token.children?.some(child => child.type === 'code_inline'))) && token.map) {
            for (let line = token.map[0]; line < token.map[1]; line++)
                protectedLines.add(line);
        }
    }
    return result.split('\n').map((line, index) => protectedLines.has(index) ? line : line.replace(/^( {0,3}#{1,6})(?:(?:&#(?:0*32|0*160|x0*20|x0*a0);|&nbsp;))+/i, '$1 ')).join('\n');
}
function isPythonLanguage(language) {
    return /^(?:python|py)(?:$|[\d._-])/i.test(language.trim());
}
/** Keep literals intact, including nested quotes in Python f-string expressions. */
function pythonStringEnd(code, start) {
    const char = code[start];
    const quote = code.startsWith(char.repeat(3), start) ? char.repeat(3) : char;
    const prefix = /[\p{ID_Continue}]+$/u.exec(code.slice(0, start))?.[0] || '';
    const formatted = /^(?:f|fr|rf)$/i.test(prefix);
    let depth = 0;
    let index = start + quote.length;
    while (index < code.length) {
        if (code[index] === '\\') {
            index += 2;
            continue;
        }
        if (formatted && depth > 0) {
            if (code[index] === '"' || code[index] === "'") {
                index = pythonStringEnd(code, index);
                continue;
            }
            if (code[index] === '#') {
                const end = code.indexOf('\n', index);
                index = end < 0 ? code.length : end;
                continue;
            }
            if (code[index] === '{')
                depth++;
            if (code[index] === '}')
                depth--;
        }
        else {
            if (code.startsWith(quote, index))
                return index + quote.length;
            if (formatted && code[index] === '{') {
                if (code[index + 1] === '{') {
                    index += 2;
                    continue;
                }
                depth++;
            }
        }
        index++;
    }
    return code.length;
}
/**
 * Migrate only explicitly numbered worksheet blanks, outside Python literals.
 * Hints go above the code so they cannot swallow a closing parenthesis or colon.
 */
function normalizePythonBlanks(code, fenceIndent) {
    const hints = [];
    const blankOrder = [];
    let output = '';
    let index = 0;
    while (index < code.length) {
        const char = code[index];
        if (char === '"' || char === "'") {
            const start = index;
            index = pythonStringEnd(code, index);
            output += code.slice(start, index);
            continue;
        }
        if (char === '_' && !/\p{ID_Continue}$/u.test(code.slice(Math.max(0, index - 2), index))) {
            const legacyBlank = /^__BLANK_(\d+)__(?![\p{ID_Continue}])/u.exec(code.slice(index));
            if (legacyBlank) {
                output += worksheetBlank;
                blankOrder.push(legacyBlank[1]);
                index += legacyBlank[0].length;
                continue;
            }
        }
        if (char !== '/' && char !== '#') {
            output += char;
            index++;
            continue;
        }
        const remaining = code.slice(index);
        const block = char === '/'
            ? /^\/\\?\*\s*\\?\[空\s*(\d+)\\?\]\s*((?:\\?_){2,}[^\r\n]*?)\s*\\?\*\//.exec(remaining) : null;
        // Existing Python comments may document a valid multiline expression.
        // Only C-style blank comments are unambiguously invalid Python syntax.
        const blank = block;
        if (blank) {
            output += worksheetBlank;
            blankOrder.push(blank[1]);
            hints.push(`${fenceIndent}# [空${blank[1]}] ${blank[2].replace(/\\_/g, '_').trim()}`);
            index += blank[0].length;
            continue;
        }
        if (char === '#') {
            const end = code.indexOf('\n', index);
            const stop = end < 0 ? code.length : end;
            output += code.slice(index, stop);
            index = stop;
            continue;
        }
        output += char;
        index++;
    }
    if (blankOrder.some((number, position) => Number(number) !== position + 1)) {
        hints.unshift(`${fenceIndent}# 空位顺序（从上到下，每行从左到右）：${blankOrder.map(number => `[空${number}]`).join('、')}`);
    }
    return hints.length ? `${[...new Set(hints)].join('\n')}\n${output}` : output;
}
/** Only generated homework is migrated; student submission samples remain verbatim. */
function normalizeHomeworkMarkdown(content, fallbackLanguage = '') {
    const normalized = normalizeReportMarkdown(content);
    const lines = normalized.split('\n');
    const fences = parser.parse(normalized, {}).filter(token => token.type === 'fence' && token.level === 0 && token.map);
    for (const fence of fences.reverse()) {
        const language = fence.info.trim().split(/\s+/)[0] || fallbackLanguage;
        if (!isPythonLanguage(language))
            continue;
        const [start, end] = fence.map;
        const indent = /^ */.exec(lines[start])?.[0] || '';
        const close = lines[end - 1]?.trim();
        // Leave incomplete or nested fences for the existing export guard to reject.
        if (!close || !new RegExp(`^${fence.markup[0]}{${fence.markup.length},}$`).test(close))
            continue;
        const original = lines.slice(start + 1, end - 1).join('\n');
        const migrated = normalizePythonBlanks(original, indent);
        if (migrated !== original)
            lines.splice(start + 1, end - start - 2, ...migrated.split('\n'));
    }
    return lines.join('\n');
}
//# sourceMappingURL=reportMarkdown.js.map