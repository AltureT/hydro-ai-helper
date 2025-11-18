"use strict";
/**
 * EffectivenessService - 有效对话判定服务
 *
 * 根据规则判定会话是否为「有效对话」，并更新数据库
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.EffectivenessService = void 0;
const mongo_1 = require("../utils/mongo");
/**
 * 有效对话判定规则
 */
const EFFECTIVENESS_RULES = {
    // 最小消息数量要求
    MIN_STUDENT_MESSAGES: 2,
    MIN_AI_MESSAGES: 2,
    // 学生消息平均长度要求（字符数）
    MIN_STUDENT_AVG_LENGTH: 20,
    // 学习相关关键词（至少匹配一个）
    LEARNING_KEYWORDS: [
        '理解', '思路', '算法', '复杂度', '优化', '错误', '调试'
    ]
};
/**
 * EffectivenessService 类
 * 负责分析会话并判定是否为有效对话
 */
class EffectivenessService {
    constructor(ctx) {
        this.ctx = ctx;
    }
    /**
     * 分析会话并判定是否为有效对话
     *
     * @param conversationId 会话 ID（字符串或 ObjectId）
     * @returns boolean - 是否为有效对话
     */
    async analyzeConversation(conversationId) {
        try {
            // 获取模型实例
            const messageModel = this.ctx.get('messageModel');
            const conversationModel = this.ctx.get('conversationModel');
            // 转换为 ObjectId
            const convObjectId = typeof conversationId === 'string'
                ? new mongo_1.ObjectId(conversationId)
                : conversationId;
            // 从数据库读取所有消息（按时间升序）
            const messages = await messageModel.findByConversationId(convObjectId);
            if (!messages.length) {
                // 没有消息，标记为无效
                await conversationModel.updateEffectiveness(convObjectId, false);
                return false;
            }
            // 1. 按 role 划分学生/AI 消息
            const studentMessages = messages.filter(msg => msg.role === 'student');
            const aiMessages = messages.filter(msg => msg.role === 'ai');
            // 2. 检查消息数量要求
            const hasEnoughStudentMessages = studentMessages.length >= EFFECTIVENESS_RULES.MIN_STUDENT_MESSAGES;
            const hasEnoughAiMessages = aiMessages.length >= EFFECTIVENESS_RULES.MIN_AI_MESSAGES;
            if (!hasEnoughStudentMessages || !hasEnoughAiMessages) {
                // 消息数量不足，标记为无效
                await conversationModel.updateEffectiveness(convObjectId, false);
                return false;
            }
            // 3. 计算学生消息平均长度
            const totalStudentLength = studentMessages.reduce((sum, msg) => sum + msg.content.length, 0);
            const avgStudentLength = totalStudentLength / studentMessages.length;
            if (avgStudentLength <= EFFECTIVENESS_RULES.MIN_STUDENT_AVG_LENGTH) {
                // 平均长度不足，标记为无效
                await conversationModel.updateEffectiveness(convObjectId, false);
                return false;
            }
            // 4. 检查关键词命中情况
            const hasLearningKeyword = studentMessages.some(msg => {
                const content = msg.content;
                return EFFECTIVENESS_RULES.LEARNING_KEYWORDS.some(keyword => content.includes(keyword));
            });
            if (!hasLearningKeyword) {
                // 未命中任何学习关键词，标记为无效
                await conversationModel.updateEffectiveness(convObjectId, false);
                return false;
            }
            // 所有条件都满足，标记为有效
            await conversationModel.updateEffectiveness(convObjectId, true);
            return true;
        }
        catch (err) {
            // 记录错误日志，但不抛出异常（保守处理为 false）
            this.ctx.logger.error('EffectivenessService analyzeConversation error', err);
            // 出现错误时，尝试将会话标记为无效（如果可能）
            try {
                const conversationModel = this.ctx.get('conversationModel');
                const convObjectId = typeof conversationId === 'string'
                    ? new mongo_1.ObjectId(conversationId)
                    : conversationId;
                await conversationModel.updateEffectiveness(convObjectId, false);
            }
            catch (updateErr) {
                this.ctx.logger.error('EffectivenessService updateEffectiveness error', updateErr);
            }
            return false;
        }
    }
}
exports.EffectivenessService = EffectivenessService;
//# sourceMappingURL=effectivenessService.js.map