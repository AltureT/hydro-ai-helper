"use strict";
/**
 * Conversation Model - 对话会话数据模型
 *
 * 管理学生与 AI 的对话会话,记录会话元数据
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConversationModel = void 0;
const mongodb_1 = require("mongodb");
/**
 * Conversation Model 操作类
 * 封装对话会话的 CRUD 操作
 */
class ConversationModel {
    constructor(db) {
        this.collection = db.collection('ai_conversations');
    }
    /**
     * 确保索引已创建
     * 优化常用查询性能: 按用户、题目、时间筛选
     */
    async ensureIndexes() {
        // 创建复合索引: 用户 + 开始时间 (降序)
        await this.collection.createIndex({ userId: 1, startTime: -1 }, { name: 'idx_userId_startTime' });
        // 创建索引: 题目 ID
        await this.collection.createIndex({ problemId: 1 }, { name: 'idx_problemId' });
        // 创建索引: 班级 ID (稀疏索引,因为 classId 可选)
        await this.collection.createIndex({ classId: 1 }, { name: 'idx_classId', sparse: true });
        // 创建索引: 开始时间 (用于时间范围筛选)
        await this.collection.createIndex({ startTime: -1 }, { name: 'idx_startTime' });
        console.log('[ConversationModel] Indexes created successfully');
    }
    /**
     * 创建新的对话会话
     * @param data 会话数据
     * @returns 插入的会话 ID
     */
    async create(data) {
        const result = await this.collection.insertOne(data);
        return result.insertedId;
    }
    /**
     * 根据 ID 查找会话
     * @param id 会话 ID (字符串或 ObjectId)
     * @returns 会话对象或 null
     */
    async findById(id) {
        const _id = typeof id === 'string' ? new mongodb_1.ObjectId(id) : id;
        return this.collection.findOne({ _id });
    }
    /**
     * 更新会话的最后更新时间
     * @param id 会话 ID
     * @param endTime 最后更新时间
     */
    async updateEndTime(id, endTime) {
        const _id = typeof id === 'string' ? new mongodb_1.ObjectId(id) : id;
        await this.collection.updateOne({ _id }, { $set: { endTime } });
    }
    /**
     * 增加会话的消息计数
     * @param id 会话 ID
     */
    async incrementMessageCount(id) {
        const _id = typeof id === 'string' ? new mongodb_1.ObjectId(id) : id;
        await this.collection.updateOne({ _id }, { $inc: { messageCount: 1 } });
    }
    /**
     * 更新会话的有效性标记
     * @param id 会话 ID
     * @param isEffective 是否有效
     */
    async updateEffectiveness(id, isEffective) {
        const _id = typeof id === 'string' ? new mongodb_1.ObjectId(id) : id;
        await this.collection.updateOne({ _id }, { $set: { isEffective } });
    }
    /**
     * 根据筛选条件查找会话列表 (分页)
     * @param filters 筛选条件
     * @param page 页码 (从 1 开始)
     * @param limit 每页条数 (默认 50)
     * @returns 会话列表和总数
     */
    async findByFilters(filters, page = 1, limit = 50) {
        // 构造查询条件
        const query = {};
        if (filters.userId !== undefined) {
            query.userId = filters.userId;
        }
        if (filters.problemId) {
            query.problemId = filters.problemId;
        }
        if (filters.classId) {
            query.classId = filters.classId;
        }
        // 时间范围筛选
        if (filters.startDate || filters.endDate) {
            query.startTime = {};
            if (filters.startDate) {
                query.startTime.$gte = new Date(filters.startDate);
            }
            if (filters.endDate) {
                query.startTime.$lte = new Date(filters.endDate);
            }
        }
        // 查询总数
        const total = await this.collection.countDocuments(query);
        // 查询分页数据 (按开始时间降序排序)
        const skip = (page - 1) * limit;
        const conversations = await this.collection
            .find(query)
            .sort({ startTime: -1 })
            .skip(skip)
            .limit(limit)
            .toArray();
        return { conversations, total };
    }
    /**
     * 更新会话的教师备注和标签 (预留给后续 Phase)
     * @param id 会话 ID
     * @param teacherNote 教师备注
     * @param tags 标签列表
     */
    async updateTeacherAnnotations(id, teacherNote, tags) {
        const _id = typeof id === 'string' ? new mongodb_1.ObjectId(id) : id;
        const update = {};
        if (teacherNote !== undefined) {
            update.teacherNote = teacherNote;
        }
        if (tags !== undefined) {
            update.tags = tags;
        }
        if (Object.keys(update).length > 0) {
            await this.collection.updateOne({ _id }, { $set: update });
        }
    }
}
exports.ConversationModel = ConversationModel;
//# sourceMappingURL=conversation.js.map