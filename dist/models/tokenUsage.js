"use strict";
/**
 * TokenUsage Model - Token 用量追踪
 *
 * 双表设计:
 * - ai_token_usage: 细粒度记录 (TTL 90天)
 * - ai_usage_daily_agg: 日聚合表 (永久保留, $inc upsert)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TokenUsageModel = void 0;
const TTL_DAYS = 90;
class TokenUsageModel {
    constructor(db) {
        this.usageCollection = db.collection('ai_token_usage');
        this.dailyAggCollection = db.collection('ai_usage_daily_agg');
    }
    async ensureIndexes() {
        // 细粒度记录索引
        await this.usageCollection.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0, name: 'idx_ttl_expireAt' });
        await this.usageCollection.createIndex({ domainId: 1, timestamp: -1 }, { name: 'idx_domainId_timestamp' });
        await this.usageCollection.createIndex({ domainId: 1, userId: 1, timestamp: -1 }, { name: 'idx_domainId_userId_timestamp' });
        await this.usageCollection.createIndex({ conversationId: 1 }, { name: 'idx_conversationId' });
        // 日聚合表索引
        await this.dailyAggCollection.createIndex({ domainId: 1, date: -1 }, { name: 'idx_domainId_date' });
        await this.dailyAggCollection.createIndex({ domainId: 1, userId: 1, date: -1 }, { name: 'idx_domainId_userId_date' });
        console.log('[TokenUsageModel] Indexes created successfully');
    }
    async recordUsage(params) {
        const now = new Date();
        const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
        const expireAt = new Date(now.getTime() + TTL_DAYS * 24 * 60 * 60 * 1000);
        const estimatedCostUSD = this.estimateCost(params.modelName, params.promptTokens, params.completionTokens);
        // 写细粒度记录
        await this.usageCollection.insertOne({
            domainId: params.domainId,
            userId: params.userId,
            classId: params.classId,
            conversationId: params.conversationId,
            messageId: params.messageId,
            endpointId: params.endpointId,
            endpointName: params.endpointName,
            modelName: params.modelName,
            promptTokens: params.promptTokens,
            completionTokens: params.completionTokens,
            totalTokens: params.totalTokens,
            estimatedCostUSD,
            questionType: params.questionType,
            latencyMs: params.latencyMs,
            timestamp: now,
            expireAt,
        });
        // $inc upsert 日聚合
        const aggId = `${params.domainId}:${params.userId}:${dateStr}`;
        await this.dailyAggCollection.updateOne({ _id: aggId }, {
            $inc: {
                totalPromptTokens: params.promptTokens,
                totalCompletionTokens: params.completionTokens,
                totalTokens: params.totalTokens,
                requestCount: 1,
                estimatedCostUSD: estimatedCostUSD,
            },
            $set: {
                domainId: params.domainId,
                userId: params.userId,
                date: dateStr,
                updatedAt: now,
            },
        }, { upsert: true });
    }
    async getUserDailyUsage(domainId, userId, date) {
        const aggId = `${domainId}:${userId}:${date}`;
        return this.dailyAggCollection.findOne({ _id: aggId });
    }
    async getDomainDailyUsage(domainId, date) {
        const pipeline = [
            { $match: { domainId, date } },
            {
                $group: {
                    _id: null,
                    totalTokens: { $sum: '$totalTokens' },
                    totalCost: { $sum: '$estimatedCostUSD' },
                    requestCount: { $sum: '$requestCount' },
                },
            },
        ];
        const result = await this.dailyAggCollection.aggregate(pipeline).toArray();
        if (result.length === 0) {
            return { totalTokens: 0, totalCost: 0, requestCount: 0 };
        }
        return {
            totalTokens: result[0].totalTokens,
            totalCost: result[0].totalCost,
            requestCount: result[0].requestCount,
        };
    }
    async getDomainMonthlyUsage(domainId, yearMonth) {
        const pipeline = [
            { $match: { domainId, date: { $regex: `^${yearMonth}` } } },
            {
                $group: {
                    _id: null,
                    totalTokens: { $sum: '$totalTokens' },
                    totalCost: { $sum: '$estimatedCostUSD' },
                    requestCount: { $sum: '$requestCount' },
                },
            },
        ];
        const result = await this.dailyAggCollection.aggregate(pipeline).toArray();
        if (result.length === 0) {
            return { totalTokens: 0, totalCost: 0, requestCount: 0 };
        }
        return {
            totalTokens: result[0].totalTokens,
            totalCost: result[0].totalCost,
            requestCount: result[0].requestCount,
        };
    }
    async getTopUsers(domainId, date, limit = 10) {
        return this.dailyAggCollection
            .find({ domainId, date })
            .sort({ totalTokens: -1 })
            .limit(limit)
            .project({ _id: 0, userId: 1, totalTokens: 1, requestCount: 1, estimatedCostUSD: 1 })
            .toArray();
    }
    async getDailyTrend(domainId, startDate, endDate) {
        const pipeline = [
            { $match: { domainId, date: { $gte: startDate, $lte: endDate } } },
            {
                $group: {
                    _id: '$date',
                    totalTokens: { $sum: '$totalTokens' },
                    totalCost: { $sum: '$estimatedCostUSD' },
                    requestCount: { $sum: '$requestCount' },
                },
            },
            { $sort: { _id: 1 } },
            {
                $project: {
                    _id: 0,
                    date: '$_id',
                    totalTokens: 1,
                    totalCost: 1,
                    requestCount: 1,
                },
            },
        ];
        return this.dailyAggCollection.aggregate(pipeline).toArray();
    }
    async getModelBreakdown(domainId, startDate, endDate) {
        const pipeline = [
            {
                $match: {
                    domainId,
                    timestamp: { $gte: new Date(startDate), $lte: new Date(endDate + 'T23:59:59.999Z') },
                },
            },
            {
                $group: {
                    _id: '$modelName',
                    totalTokens: { $sum: '$totalTokens' },
                    requestCount: { $sum: 1 },
                    estimatedCostUSD: { $sum: '$estimatedCostUSD' },
                },
            },
            { $sort: { totalTokens: -1 } },
            {
                $project: {
                    _id: 0,
                    modelName: '$_id',
                    totalTokens: 1,
                    requestCount: 1,
                    estimatedCostUSD: 1,
                },
            },
        ];
        return this.usageCollection.aggregate(pipeline).toArray();
    }
    estimateCost(modelName, promptTokens, completionTokens) {
        const model = modelName.toLowerCase();
        let promptPrice;
        let completionPrice;
        if (model.includes('gpt-4o-mini') || model.includes('gpt-4o-mini')) {
            promptPrice = 0.15 / 1000000;
            completionPrice = 0.60 / 1000000;
        }
        else if (model.includes('gpt-4o')) {
            promptPrice = 2.50 / 1000000;
            completionPrice = 10.00 / 1000000;
        }
        else if (model.includes('gpt-4-turbo') || model.includes('gpt-4-1')) {
            promptPrice = 2.00 / 1000000;
            completionPrice = 8.00 / 1000000;
        }
        else if (model.includes('gpt-4')) {
            promptPrice = 30.00 / 1000000;
            completionPrice = 60.00 / 1000000;
        }
        else if (model.includes('gpt-3.5')) {
            promptPrice = 0.50 / 1000000;
            completionPrice = 1.50 / 1000000;
        }
        else if (model.includes('deepseek')) {
            promptPrice = 0.27 / 1000000;
            completionPrice = 1.10 / 1000000;
        }
        else if (model.includes('claude-3-5-sonnet') || model.includes('claude-sonnet')) {
            promptPrice = 3.00 / 1000000;
            completionPrice = 15.00 / 1000000;
        }
        else if (model.includes('claude-3-haiku') || model.includes('claude-haiku')) {
            promptPrice = 0.25 / 1000000;
            completionPrice = 1.25 / 1000000;
        }
        else if (model.includes('doubao') || model.includes('ep-')) {
            promptPrice = 0.80 / 1000000;
            completionPrice = 2.00 / 1000000;
        }
        else if (model.includes('qwen')) {
            promptPrice = 0.50 / 1000000;
            completionPrice = 2.00 / 1000000;
        }
        else if (model.includes('glm')) {
            promptPrice = 0.50 / 1000000;
            completionPrice = 0.50 / 1000000;
        }
        else {
            // 默认估价
            promptPrice = 1.00 / 1000000;
            completionPrice = 3.00 / 1000000;
        }
        return promptTokens * promptPrice + completionTokens * completionPrice;
    }
}
exports.TokenUsageModel = TokenUsageModel;
//# sourceMappingURL=tokenUsage.js.map