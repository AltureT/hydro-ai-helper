"use strict";
/**
 * Message Model - 对话消息数据模型
 *
 * 管理对话中的每条消息 (学生问题 / AI 回答)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MessageModel = void 0;
const mongo_1 = require("../utils/mongo");
/**
 * Message Model 操作类
 * 封装对话消息的 CRUD 操作
 */
class MessageModel {
    constructor(db) {
        this.collection = db.collection('ai_messages');
    }
    /**
     * 确保索引已创建
     * 优化常用查询性能: 按会话 ID + 时间戳查询
     */
    async ensureIndexes() {
        // 创建复合索引: 会话 ID + 时间戳 (升序)
        await this.collection.createIndex({ conversationId: 1, timestamp: 1 }, { name: 'idx_conversationId_timestamp' });
        // 创建复合索引: 会话 ID + 角色 + 时间戳 (用于按角色筛选并排序)
        await this.collection.createIndex({ conversationId: 1, role: 1, timestamp: 1 }, { name: 'idx_conversationId_role_timestamp' });
        // 创建索引: 会话 ID (用于快速查找某个会话的所有消息)
        await this.collection.createIndex({ conversationId: 1 }, { name: 'idx_conversationId' });
        console.log('[MessageModel] Indexes created successfully');
    }
    /**
     * 创建新消息
     * @param data 消息数据
     * @returns 插入的消息 ID
     */
    async create(data) {
        const result = await this.collection.insertOne(data);
        return result.insertedId;
    }
    /**
     * 根据会话 ID 查找所有消息 (按时间升序排序)
     * @param conversationId 会话 ID (字符串或 ObjectId)
     * @returns 消息列表
     */
    async findByConversationId(conversationId) {
        const _conversationId = typeof conversationId === 'string'
            ? new mongo_1.ObjectId(conversationId)
            : conversationId;
        return this.collection
            .find({ conversationId: _conversationId })
            .sort({ timestamp: 1 }) // 按时间升序排序
            .toArray();
    }
    /**
     * 获取会话最近的消息列表（按时间升序返回）
     * 性能优化：仅加载最近 N 条消息，避免长对话的内存压力
     * @param conversationId 会话 ID
     * @param limit 最大条数（上限 50）
     */
    async findRecentByConversationId(conversationId, limit) {
        const _conversationId = typeof conversationId === 'string'
            ? new mongo_1.ObjectId(conversationId)
            : conversationId;
        const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)));
        const results = await this.collection
            .find({ conversationId: _conversationId })
            .sort({ timestamp: -1 })
            .limit(safeLimit)
            .toArray();
        return results.reverse();
    }
    /**
     * 根据 ID 查找单条消息
     * @param id 消息 ID (字符串或 ObjectId)
     * @returns 消息对象或 null
     */
    async findById(id) {
        const _id = typeof id === 'string' ? new mongo_1.ObjectId(id) : id;
        return this.collection.findOne({ _id });
    }
    /**
     * 删除会话的所有消息 (用于数据清理或测试)
     * @param conversationId 会话 ID
     * @returns 删除的消息数量
     */
    async deleteByConversationId(conversationId) {
        const _conversationId = typeof conversationId === 'string'
            ? new mongo_1.ObjectId(conversationId)
            : conversationId;
        const result = await this.collection.deleteMany({ conversationId: _conversationId });
        return result.deletedCount;
    }
    /**
     * 统计会话的消息数量
     * @param conversationId 会话 ID
     * @returns 消息数量
     */
    async countByConversationId(conversationId) {
        const _conversationId = typeof conversationId === 'string'
            ? new mongo_1.ObjectId(conversationId)
            : conversationId;
        return this.collection.countDocuments({ conversationId: _conversationId });
    }
    /**
     * 获取会话中学生消息的列表 (用于有效对话判定)
     * @param conversationId 会话 ID
     * @returns 学生消息列表
     */
    async findStudentMessagesByConversationId(conversationId) {
        const _conversationId = typeof conversationId === 'string'
            ? new mongo_1.ObjectId(conversationId)
            : conversationId;
        return this.collection
            .find({ conversationId: _conversationId, role: 'student' })
            .sort({ timestamp: 1 })
            .toArray();
    }
    /**
     * 获取会话中 AI 消息的列表 (用于有效对话判定)
     * @param conversationId 会话 ID
     * @returns AI 消息列表
     */
    async findAiMessagesByConversationId(conversationId) {
        const _conversationId = typeof conversationId === 'string'
            ? new mongo_1.ObjectId(conversationId)
            : conversationId;
        return this.collection
            .find({ conversationId: _conversationId, role: 'ai' })
            .sort({ timestamp: 1 })
            .toArray();
    }
    /**
     * 获取会话的第一条学生消息
     * @param conversationId 会话 ID
     * @returns 第一条学生消息或 null
     */
    async findFirstStudentMessage(conversationId) {
        const _conversationId = typeof conversationId === 'string'
            ? new mongo_1.ObjectId(conversationId)
            : conversationId;
        return this.collection.findOne({ conversationId: _conversationId, role: 'student' }, { sort: { timestamp: 1 } });
    }
    /**
     * 批量获取多个会话的第一条学生消息
     * @param conversationIds 会话 ID 列表
     * @returns Map<conversationId, Message>
     */
    async findFirstStudentMessagesForConversations(conversationIds) {
        if (conversationIds.length === 0) {
            return new Map();
        }
        const _ids = conversationIds.map(id => typeof id === 'string' ? new mongo_1.ObjectId(id) : id);
        // 使用聚合管道获取每个会话的第一条学生消息
        const pipeline = [
            { $match: { conversationId: { $in: _ids }, role: 'student' } },
            { $sort: { conversationId: 1, timestamp: 1 } },
            {
                $group: {
                    _id: '$conversationId',
                    firstMessage: { $first: '$$ROOT' }
                }
            }
        ];
        const results = await this.collection.aggregate(pipeline).toArray();
        const map = new Map();
        for (const result of results) {
            const convId = result._id.toString();
            map.set(convId, result.firstMessage);
        }
        return map;
    }
}
exports.MessageModel = MessageModel;
//# sourceMappingURL=message.js.map