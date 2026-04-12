"use strict";
/**
 * TeachingSummary Model - 教学总结数据模型
 *
 * 管理竞赛教学分析总结，提供对学生学习模式的洞察
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TeachingSummaryModel = void 0;
const ensureObjectId_1 = require("../utils/ensureObjectId");
class TeachingSummaryModel {
    constructor(db) {
        this.collection = db.collection('ai_teaching_summaries');
    }
    /**
     * 确保索引已创建
     */
    async ensureIndexes() {
        await this.collection.createIndex({ domainId: 1, createdAt: -1 }, { name: 'idx_domainId_createdAt' });
        await this.collection.createIndex({ domainId: 1, contestId: 1 }, { name: 'idx_domainId_contestId' });
        console.log('[TeachingSummaryModel] Indexes created successfully');
    }
    /**
     * 创建新的教学总结（初始状态为 pending）
     */
    async create(params) {
        const doc = {
            domainId: params.domainId,
            contestId: params.contestId,
            contestTitle: params.contestTitle,
            contestContent: params.contestContent,
            teachingFocus: params.teachingFocus,
            createdBy: params.createdBy,
            createdAt: new Date(),
            dataSnapshotAt: params.dataSnapshotAt,
            status: 'pending',
            stats: {
                totalStudents: 0,
                participatedStudents: 0,
                aiUserCount: 0,
                problemCount: 0,
            },
            findings: [],
            overallSuggestion: '',
            deepDiveResults: {},
            tokenUsage: { promptTokens: 0, completionTokens: 0 },
            generationTimeMs: 0,
        };
        const result = await this.collection.insertOne(doc);
        return result.insertedId;
    }
    /**
     * 根据 ID 查找教学总结
     */
    async findById(id) {
        const _id = (0, ensureObjectId_1.ensureObjectId)(id);
        return this.collection.findOne({ _id });
    }
    /**
     * 查找指定域+竞赛的最新教学总结
     */
    async findByContest(domainId, contestId) {
        return this.collection.findOne({ domainId, contestId }, { sort: { createdAt: -1 } });
    }
    /**
     * 分页查询指定域的教学总结列表（按创建时间倒序）
     */
    async findByDomain(domainId, page, limit) {
        const skip = (page - 1) * limit;
        return this.collection
            .find({ domainId })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .toArray();
    }
    /**
     * 更新总结状态
     */
    async updateStatus(id, status) {
        const _id = (0, ensureObjectId_1.ensureObjectId)(id);
        await this.collection.updateOne({ _id }, { $set: { status } });
    }
    /**
     * 保存分析结果并将状态设置为 completed
     */
    async saveResults(id, data) {
        const _id = (0, ensureObjectId_1.ensureObjectId)(id);
        await this.collection.updateOne({ _id }, {
            $set: {
                status: 'completed',
                stats: data.stats,
                findings: data.findings,
                overallSuggestion: data.overallSuggestion,
                deepDiveResults: data.deepDiveResults ?? {},
                tokenUsage: data.tokenUsage,
                generationTimeMs: data.generationTimeMs,
            },
        });
    }
    /**
     * 保存教师反馈
     */
    async saveFeedback(id, rating, comment) {
        const _id = (0, ensureObjectId_1.ensureObjectId)(id);
        const feedback = { rating };
        if (comment !== undefined) {
            feedback.comment = comment;
        }
        await this.collection.updateOne({ _id }, { $set: { feedback } });
    }
    /**
     * 删除教学总结
     */
    async deleteById(id) {
        const _id = (0, ensureObjectId_1.ensureObjectId)(id);
        await this.collection.deleteOne({ _id });
    }
}
exports.TeachingSummaryModel = TeachingSummaryModel;
//# sourceMappingURL=teachingSummary.js.map