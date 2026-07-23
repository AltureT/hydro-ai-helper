"use strict";
/**
 * JailbreakLog Model - 越狱尝试记录
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.JailbreakLogModel = exports.DEFAULT_JAILBREAK_LOG_RETENTION_DAYS = void 0;
exports.resolveJailbreakLogRetentionDays = resolveJailbreakLogRetentionDays;
exports.sanitizeSafetyLogSnippet = sanitizeSafetyLogSnippet;
const ensureObjectId_1 = require("../utils/ensureObjectId");
exports.DEFAULT_JAILBREAK_LOG_RETENTION_DAYS = 180;
const MIN_JAILBREAK_LOG_RETENTION_DAYS = 7;
const MAX_JAILBREAK_LOG_RETENTION_DAYS = 3650;
const MAX_STORED_MATCHED_TEXT_LENGTH = 256;
function resolveJailbreakLogRetentionDays(raw = process.env.AI_HELPER_JAILBREAK_LOG_RETENTION_DAYS) {
    if (!raw?.trim())
        return exports.DEFAULT_JAILBREAK_LOG_RETENTION_DAYS;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed))
        return exports.DEFAULT_JAILBREAK_LOG_RETENTION_DAYS;
    return Math.min(MAX_JAILBREAK_LOG_RETENTION_DAYS, Math.max(MIN_JAILBREAK_LOG_RETENTION_DAYS, Math.floor(parsed)));
}
function sanitizeSafetyLogSnippet(value) {
    return String(value || '')
        .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
        .replace(/\b1[3-9]\d{9}\b/g, '[phone]')
        .replace(/\b\d{14,17}[0-9Xx]\b/g, '[id]')
        .replace(/\b(?:sk|api)[-_][A-Za-z0-9_-]{12,}\b/gi, '[secret]')
        .replace(/Bearer\s+[^\s]+/gi, 'Bearer [secret]')
        .slice(0, MAX_STORED_MATCHED_TEXT_LENGTH);
}
class JailbreakLogModel {
    constructor(db, retentionDays = resolveJailbreakLogRetentionDays()) {
        this.collection = db.collection('ai_jailbreak_logs');
        this.retentionDays = retentionDays;
    }
    async ensureIndexes() {
        await this.collection.createIndex({ createdAt: -1 }, { name: 'idx_createdAt' });
        await this.collection.createIndex({ domainId: 1, userId: 1, createdAt: -1 }, { name: 'idx_domain_user_createdAt' });
        await this.collection.createIndex({ domainId: 1, userId: 1, blockedUntil: -1 }, { name: 'idx_domain_user_blockedUntil' });
        await this.collection.createIndex({ domainId: 1, reviewStatus: 1, category: 1, createdAt: -1 }, { name: 'idx_domain_review_category_createdAt' });
        await this.collection.createIndex({ expiresAt: 1 }, { name: 'idx_expiresAt_ttl', expireAfterSeconds: 0 });
        console.log('[JailbreakLogModel] Indexes ensured');
    }
    async create(data) {
        const createdAt = data.createdAt ?? new Date();
        const insertDoc = {
            domainId: data.domainId,
            userId: data.userId,
            problemId: data.problemId,
            conversationId: data.conversationId === undefined
                ? undefined
                : (0, ensureObjectId_1.ensureObjectId)(data.conversationId),
            questionType: data.questionType,
            matchedPattern: data.matchedPattern,
            matchedText: sanitizeSafetyLogSnippet(data.matchedText),
            category: data.category,
            confidence: data.confidence,
            riskScore: data.riskScore,
            detectionSource: data.detectionSource,
            actionTaken: data.actionTaken,
            blockedUntil: data.blockedUntil,
            reviewStatus: 'pending',
            expiresAt: this.getExpiryDate(createdAt),
            createdAt
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
    async reviewMany(ids, domainId, reviewStatus, reviewedBy, reviewedAt = new Date()) {
        if (ids.length === 0)
            return { matchedCount: 0, modifiedCount: 0 };
        const update = {
            $set: { reviewStatus, reviewedAt, reviewedBy },
        };
        if (reviewStatus === 'false_positive') {
            update.$unset = { blockedUntil: '' };
        }
        const result = await this.collection.updateMany({ _id: { $in: ids.map((id) => (0, ensureObjectId_1.ensureObjectId)(id)) }, domainId }, update);
        return { matchedCount: result.matchedCount, modifiedCount: result.modifiedCount };
    }
    async backfillExpiry(now = new Date()) {
        const result = await this.collection.updateMany({ expiresAt: { $exists: false } }, { $set: { expiresAt: this.getExpiryDate(now) } });
        return result.modifiedCount;
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
    async getRuleMetrics(domainId, limit = 20) {
        const safeLimit = Math.min(50, Math.max(1, Math.floor(limit)));
        const rows = await this.collection.aggregate([
            { $match: { domainId } },
            {
                $group: {
                    _id: { matchedPattern: '$matchedPattern', category: '$category' },
                    total: { $sum: 1 },
                    pending: {
                        $sum: {
                            $cond: [
                                { $eq: [{ $ifNull: ['$reviewStatus', 'pending'] }, 'pending'] },
                                1,
                                0,
                            ],
                        },
                    },
                    confirmed: { $sum: { $cond: [{ $eq: ['$reviewStatus', 'confirmed'] }, 1, 0] } },
                    falsePositive: { $sum: { $cond: [{ $eq: ['$reviewStatus', 'false_positive'] }, 1, 0] } },
                },
            },
            { $sort: { falsePositive: -1, total: -1 } },
            { $limit: safeLimit },
        ]).toArray();
        return rows.map((row) => {
            const reviewed = row.confirmed + row.falsePositive;
            return {
                matchedPattern: row._id.matchedPattern,
                category: row._id.category,
                total: row.total,
                pending: row.pending,
                confirmed: row.confirmed,
                falsePositive: row.falsePositive,
                reviewed,
                falsePositiveRate: reviewed > 0
                    ? Math.round((row.falsePositive / reviewed) * 1000) / 10
                    : 0,
            };
        });
    }
    getExpiryDate(base) {
        return new Date(base.getTime() + this.retentionDays * 24 * 60 * 60 * 1000);
    }
}
exports.JailbreakLogModel = JailbreakLogModel;
//# sourceMappingURL=jailbreakLog.js.map