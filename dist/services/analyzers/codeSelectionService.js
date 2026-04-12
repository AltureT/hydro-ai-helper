"use strict";
/**
 * Code Selection Service — selects best AC submissions for fill-in exercises.
 * Spec reference: §3.7
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.shouldGenerateFillIn = shouldGenerateFillIn;
exports.isFillInBlankProblem = isFillInBlankProblem;
exports.scoreReadability = scoreReadability;
exports.selectACCode = selectACCode;
/**
 * Check if fill-in exercise should be generated for a problem.
 * All conditions must be met:
 * 1. Problem has a commonError or errorCluster finding
 * 2. Final AC rate < 90% OR average submissions >= 2
 * 3. First-attempt AC rate <= 70%
 */
function shouldGenerateFillIn(input) {
    if (!input.hasCommonError)
        return false;
    if (input.finalACRate >= 0.9 && input.avgSubmissionCount < 2)
        return false;
    if (input.firstAttemptACRate > 0.7)
        return false;
    return true;
}
// ─── Fill-in-blank problem detection ──────────────────────────────────────────
const FILL_IN_PATTERNS = [
    /_{3,}/,
    /\?{3,}/,
    /\/\*\s*your code here\s*\*\//i,
    /\/\/\s*TODO/i,
    /请补全/,
    /fill\s*in/i,
    /补充.*代码/,
];
function isFillInBlankProblem(problemContent) {
    return FILL_IN_PATTERNS.some(p => p.test(problemContent));
}
// ─── Readability scoring ──────────────────────────────────────────────────────
/**
 * Score code readability on a 0-4 scale.
 * +1 for meaningful variable names (>2 chars, not keywords)
 * +1 for comments (// or # or block comments)
 * +1 for function/method structure
 * +1 for moderate line count (within range of median)
 */
function scoreReadability(code, medianLines) {
    let score = 0;
    const lines = code.split('\n');
    if (/\/\/|\/\*|#\s|'''|"""/m.test(code))
        score++;
    if (/\b(function|def|int\s+\w+\s*\(|void\s+\w+\s*\(|class\s+|public\s+)/m.test(code))
        score++;
    const identifiers = code.match(/\b[a-zA-Z_][a-zA-Z0-9_]{2,}\b/g) || [];
    const KEYWORDS = new Set([
        'int', 'void', 'for', 'while', 'return', 'include', 'using', 'namespace',
        'std', 'main', 'true', 'false', 'null', 'None', 'def', 'class', 'import',
        'from', 'print', 'input', 'elif', 'else', 'break', 'continue', 'pass',
        'const', 'let', 'var', 'function', 'this', 'new', 'try', 'catch',
    ]);
    const meaningful = identifiers.filter(id => !KEYWORDS.has(id));
    if (meaningful.length >= 2)
        score++;
    const targetMin = medianLines ? Math.max(3, medianLines * 0.5) : 5;
    const targetMax = medianLines ? medianLines * 1.5 : 50;
    if (lines.length >= targetMin && lines.length <= targetMax)
        score++;
    return score;
}
/**
 * Select top AC submissions by readability.
 * Returns up to 3 candidates sorted by score descending.
 */
function selectACCode(submissions, medianLines) {
    if (submissions.length === 0)
        return [];
    let filtered = [...submissions];
    // Filter extreme lengths (bottom/top 10%) — only if enough submissions
    if (filtered.length > 10) {
        const lengths = filtered.map(s => s.code.length).sort((a, b) => a - b);
        const lo = lengths[Math.floor(lengths.length * 0.1)];
        const hi = lengths[Math.floor(lengths.length * 0.9)];
        filtered = filtered.filter(s => s.code.length >= lo && s.code.length <= hi);
    }
    const scored = filtered.map(s => ({
        uid: s.uid,
        code: s.code,
        lang: s.lang,
        score: scoreReadability(s.code, medianLines),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 3);
}
//# sourceMappingURL=codeSelectionService.js.map