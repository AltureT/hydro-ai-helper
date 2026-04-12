"use strict";
/**
 * BatchSummaryJob Model - 批量摘要任务数据模型
 *
 * 管理竞赛批量对话摘要任务,跟踪任务状态和进度
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.BatchSummaryJobModel = exports.ACTIVE_JOB_STATUSES = void 0;
const ensureObjectId_1 = require("../utils/ensureObjectId");
/** All non-archived job statuses (used for partial index and active job queries) */
exports.ACTIVE_JOB_STATUSES = ['pending', 'running', 'completed', 'failed', 'stopped'];
class BatchSummaryJobModel {
    constructor(db) {
        this.collection = db.collection('ai_batch_summary_jobs');
    }
    /**
     * 确保索引已创建
     * 唯一部分索引: 同一域+竞赛只能有一个非归档任务
     */
    async ensureIndexes() {
        // 清理旧版本索引（v1 使用了不被 partialFilterExpression 支持的 $ne）
        try {
            await this.collection.dropIndex('idx_domainId_contestId_active');
        }
        catch {
            // 旧索引不存在，忽略
        }
        await this.collection.createIndex({ domainId: 1, contestId: 1 }, {
            name: 'idx_domainId_contestId_active_v2',
            unique: true,
            partialFilterExpression: {
                status: { $in: [...exports.ACTIVE_JOB_STATUSES] },
            },
        });
        console.log('[BatchSummaryJobModel] Indexes created successfully');
    }
    /**
     * 创建新的批量摘要任务
     */
    async create(params) {
        const doc = {
            domainId: params.domainId,
            contestId: params.contestId,
            contestTitle: params.contestTitle,
            createdBy: params.createdBy,
            status: 'pending',
            totalStudents: params.totalStudents ?? 0,
            completedCount: 0,
            failedCount: 0,
            config: params.config,
            createdAt: new Date(),
            completedAt: null,
        };
        const result = await this.collection.insertOne(doc);
        return result.insertedId;
    }
    /**
     * 根据 ID 查找任务
     */
    async findById(id) {
        const _id = (0, ensureObjectId_1.ensureObjectId)(id);
        return this.collection.findOne({ _id });
    }
    /**
     * 查找指定域+竞赛的活跃任务 (status != 'archived')
     */
    async findActiveJob(domainId, contestId) {
        return this.collection.findOne({
            domainId,
            contestId,
            status: { $in: ['pending', 'running', 'completed', 'failed', 'stopped'] },
        });
    }
    /**
     * 更新任务状态
     * 当状态为 completed 或 failed 时自动写入 completedAt
     */
    async updateStatus(id, status) {
        const _id = (0, ensureObjectId_1.ensureObjectId)(id);
        const $set = { status };
        if (status === 'completed' || status === 'failed') {
            $set.completedAt = new Date();
        }
        await this.collection.updateOne({ _id }, { $set });
    }
    /**
     * 增加已完成学生计数
     */
    async incrementCompleted(id) {
        const _id = (0, ensureObjectId_1.ensureObjectId)(id);
        await this.collection.updateOne({ _id }, { $inc: { completedCount: 1 } });
    }
    /**
     * 增加失败学生计数
     */
    async incrementFailed(id) {
        const _id = (0, ensureObjectId_1.ensureObjectId)(id);
        await this.collection.updateOne({ _id }, { $inc: { failedCount: 1 } });
    }
    /**
     * 归档任务
     */
    async archive(id) {
        const _id = (0, ensureObjectId_1.ensureObjectId)(id);
        await this.collection.updateOne({ _id }, { $set: { status: 'archived' } });
    }
    async prepareForSupplementary(id, newTotal) {
        const _id = (0, ensureObjectId_1.ensureObjectId)(id);
        await this.collection.updateOne({ _id }, { $set: { totalStudents: newTotal, status: 'running', completedAt: null } });
    }
}
exports.BatchSummaryJobModel = BatchSummaryJobModel;
//# sourceMappingURL=batchSummaryJob.js.map