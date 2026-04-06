"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseProblemId = parseProblemId;
/**
 * 将 HydroOJ 的字符串 problemId（如 "P1000"、"1000"）转为数字。
 * record / document 集合中 pid/docId 为数字类型。
 */
function parseProblemId(problemId) {
    if (!problemId)
        return null;
    const numeric = parseInt(String(problemId).replace(/^[Pp]/, ''), 10);
    return Number.isNaN(numeric) ? null : numeric;
}
//# sourceMappingURL=problemIdHelper.js.map