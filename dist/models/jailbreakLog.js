"use strict";
/**
 * JailbreakLog Model - 越狱尝试记录
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.JailbreakLogModel = void 0;
const mongo_1 = require("../utils/mongo");
class JailbreakLogModel {
    constructor(db) {
        this.collection = db.collection('ai_jailbreak_logs');
    }
    async ensureIndexes() {
        await this.collection.createIndex({ createdAt: -1 }, { name: 'idx_createdAt' });
        await this.collection.createIndex({ userId: 1, createdAt: -1 }, { name: 'idx_userId_createdAt' });
        console.log('[JailbreakLogModel] Indexes ensured');
    }
    async create(data) {
        const insertDoc = {
            userId: data.userId,
            problemId: data.problemId,
            conversationId: data.conversationId === undefined
                ? undefined
                : typeof data.conversationId === 'string'
                    ? new mongo_1.ObjectId(data.conversationId)
                    : data.conversationId,
            questionType: data.questionType,
            matchedPattern: data.matchedPattern,
            matchedText: data.matchedText,
            createdAt: data.createdAt ?? new Date()
        };
        const result = await this.collection.insertOne(insertDoc);
        return result.insertedId;
    }
    async listRecent(limit = 20) {
        return this.collection.find().sort({ createdAt: -1 }).limit(limit).toArray();
    }
    /**
     * 分页查询越狱记录
     * @param page 页码（从1开始）
     * @param limit 每页条数（最大100）
     * @returns 分页结果
     */
    async listWithPagination(page = 1, limit = 20) {
        // 参数边界处理
        const safePage = Math.max(1, Math.floor(page));
        const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)));
        const skip = (safePage - 1) * safeLimit;
        // 并行查询数据和总数
        const [logs, total] = await Promise.all([
            this.collection
                .find()
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(safeLimit)
                .toArray(),
            this.collection.countDocuments()
        ]);
        const totalPages = Math.ceil(total / safeLimit);
        return {
            logs,
            total,
            page: safePage,
            totalPages
        };
    }
}
exports.JailbreakLogModel = JailbreakLogModel;
//# sourceMappingURL=jailbreakLog.js.map