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
}
exports.MessageModel = MessageModel;
//# sourceMappingURL=message.js.map