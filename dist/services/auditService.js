"use strict";
/**
 * AuditService - 管理操作审计（FR-059/060）
 *
 * 写入前对所有字符串做脱敏截断（沿用安全日志的 sanitizeSafetyLogSnippet），
 * 不保存完整对话或代码。uid 数组等撤销所需数据保持完整（批量上限 500，体积可控）。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuditService = void 0;
exports.sanitizeAuditValue = sanitizeAuditValue;
const jailbreakLog_1 = require("../models/jailbreakLog");
const MAX_DEPTH = 5;
const MAX_ARRAY_LENGTH = 5000;
const MAX_KEYS = 50;
function isObjectIdLike(value) {
    return !!value && typeof value === 'object'
        && typeof value.toHexString === 'function';
}
/** 深度遍历，脱敏截断所有字符串；限制深度、数组长度与键数量 */
function sanitizeAuditValue(value, depth = 0) {
    if (typeof value === 'string')
        return (0, jailbreakLog_1.sanitizeSafetyLogSnippet)(value);
    if (value === null || value === undefined)
        return value;
    if (typeof value === 'number' || typeof value === 'boolean')
        return value;
    if (typeof value === 'bigint')
        return value.toString();
    if (value instanceof Date || isObjectIdLike(value))
        return value;
    if (depth >= MAX_DEPTH)
        return '[truncated]';
    if (Array.isArray(value)) {
        return value.slice(0, MAX_ARRAY_LENGTH).map((item) => sanitizeAuditValue(item, depth + 1));
    }
    if (typeof value === 'object') {
        const out = {};
        for (const [key, item] of Object.entries(value).slice(0, MAX_KEYS)) {
            out[key] = sanitizeAuditValue(item, depth + 1);
        }
        return out;
    }
    return undefined;
}
class AuditService {
    constructor(model) {
        this.model = model;
    }
    async record(input) {
        return this.model.insert({
            ...(input.actorUid !== undefined ? { actorUid: input.actorUid } : {}),
            action: input.action,
            ...(input.domainId ? { domainId: input.domainId } : {}),
            target: {
                type: input.target.type,
                id: (0, jailbreakLog_1.sanitizeSafetyLogSnippet)(input.target.id),
                ...(input.target.label ? { label: (0, jailbreakLog_1.sanitizeSafetyLogSnippet)(input.target.label) } : {}),
            },
            detail: sanitizeAuditValue(input.detail || {}),
            undoable: !!input.undoable,
        });
    }
    async appendStep(id, step) {
        await this.model.appendStep(id, {
            name: (0, jailbreakLog_1.sanitizeSafetyLogSnippet)(step.name),
            status: step.status,
            ...(step.detail ? { detail: sanitizeAuditValue(step.detail) } : {}),
            at: step.at ?? new Date(),
        });
    }
    async mergeDetail(id, patch) {
        await this.model.mergeDetail(id, sanitizeAuditValue(patch));
    }
    /**
     * 原子标记撤销：返回撤销前的记录；已撤销、不可撤销或不存在时返回 null。
     * 撤销执行失败时调用 revertUndoMark 允许重试。
     */
    async markUndone(id, undoneBy) {
        return this.model.claimUndo(id, undoneBy);
    }
    async revertUndoMark(id) {
        await this.model.releaseUndo(id);
    }
    async findById(id) {
        return this.model.findById(id);
    }
    async list(filters, page = 1, limit = 20) {
        return this.model.list(filters, page, limit);
    }
}
exports.AuditService = AuditService;
//# sourceMappingURL=auditService.js.map