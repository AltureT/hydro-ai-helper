"use strict";
/**
 * JailbreakLog Model - 越狱尝试记录
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.JailbreakLogModel = void 0;
const ensureObjectId_1 = require("../utils/ensureObjectId");
class JailbreakLogModel {
    constructor(db) {
        this.collection = db.collection('ai_jailbreak_logs');
    }
    async ensureIndexes() {
        await this.collection.createIndex({ createdAt: -1 }, { name: 'idx_createdAt' });
        await this.collection.createIndex({ domainId: 1, userId: 1, createdAt: -1 }, { name: 'idx_domain_user_createdAt' });
        await this.collection.createIndex({ domainId: 1, userId: 1, blockedUntil: -1 }, { name: 'idx_domain_user_blockedUntil' });
        await this.collection.createIndex({ domainId: 1, reviewStatus: 1, category: 1, createdAt: -1 }, { name: 'idx_domain_review_category_createdAt' });
        console.log('[JailbreakLogModel] Indexes ensured');
    }
    async create(data) {
        const insertDoc = {
            domainId: data.domainId,
            userId: data.userId,
            problemId: data.problemId,
            conversationId: data.conversationId === undefined
                ? undefined
                : (0, ensureObjectId_1.ensureObjectId)(data.conversationId),
            questionType: data.questionType,
            matchedPattern: data.matchedPattern,
            matchedText: data.matchedText,
            category: data.category,
            confidence: data.confidence,
            riskScore: data.riskScore,
            detectionSource: data.detectionSource,
            actionTaken: data.actionTaken,
            blockedUntil: data.blockedUntil,
            reviewStatus: 'pending',
            createdAt: data.createdAt ?? new Date()
        };
        const result = await this.collection.insertOne(insertDoc);
        return result.insertedId;
    }
    async listRecent(limit = 20, domainId) {
        const filter = domainId ? { domainId } : {};
        return this.collection.find(filter).sort({ createdAt: -1 }).limit(limit).toArray();
    }
    async countRecentByCategories(domainId, userId, categories, since) {
        return this.collection.countDocuments({
            domainId,
            userId,
            category: { $in: categories },
            confidence: 'high',
            reviewStatus: { $ne: 'false_positive' },
            createdAt: { $gte: since },
        });
    }
    async findActiveCooldown(domainId, userId, now = new Date()) {
        return this.collection.findOne({
            domainId,
            userId,
            blockedUntil: { $gt: now },
            reviewStatus: { $ne: 'false_positive' },
        }, { sort: { blockedUntil: -1 } });
    }
    async review(id, domainId, reviewStatus, reviewedBy, reviewedAt = new Date()) {
        const update = {
            $set: { reviewStatus, reviewedAt, reviewedBy },
        };
        if (reviewStatus === 'false_positive') {
            update.$unset = { blockedUntil: '' };
        }
        const result = await this.collection.updateOne({ _id: (0, ensureObjectId_1.ensureObjectId)(id), domainId }, update);
        return result.matchedCount > 0;
    }
    /**
     * 分页查询越狱记录
     * @param page 页码（从1开始）
     * @param limit 每页条数（最大100）
     * @returns 分页结果
     */
    async listWithPagination(page = 1, limit = 20, domainId, filters = {}) {
        // 参数边界处理
        const safePage = Math.max(1, Math.floor(page));
        const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)));
        const skip = (safePage - 1) * safeLimit;
        const filter = domainId ? { domainId } : {};
        if (filters.category)
            filter.category = filters.category;
        if (filters.reviewStatus === 'pending') {
            // 旧版日志没有 reviewStatus，在管理端兼容视为待复核。
            filter.$or = [
                { reviewStatus: 'pending' },
                { reviewStatus: { $exists: false } },
            ];
        }
        else if (filters.reviewStatus) {
            filter.reviewStatus = filters.reviewStatus;
        }
        // 并行查询数据和总数
        const [logs, total] = await Promise.all([
            this.collection
                .find(filter)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(safeLimit)
                .toArray(),
            this.collection.countDocuments(filter)
        ]);
        const totalPages = Math.ceil(total / safeLimit);
        return {
            logs,
            total,
            page: safePage,
            totalPages
        };
    }
    async getReviewSummary(domainId) {
        const baseFilter = domainId ? { domainId } : {};
        const [total, pending, confirmed, falsePositive] = await Promise.all([
            this.collection.countDocuments(baseFilter),
            this.collection.countDocuments({
                ...baseFilter,
                $or: [
                    { reviewStatus: 'pending' },
                    { reviewStatus: { $exists: false } },
                ],
            }),
            this.collection.countDocuments({ ...baseFilter, reviewStatus: 'confirmed' }),
            this.collection.countDocuments({ ...baseFilter, reviewStatus: 'false_positive' }),
        ]);
        const reviewed = confirmed + falsePositive;
        const falsePositiveRate = reviewed > 0
            ? Math.round((falsePositive / reviewed) * 1000) / 10
            : 0;
        return { total, pending, confirmed, falsePositive, reviewed, falsePositiveRate };
    }
}
exports.JailbreakLogModel = JailbreakLogModel;
//# sourceMappingURL=jailbreakLog.js.map