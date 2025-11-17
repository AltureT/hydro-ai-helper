"use strict";
/**
 * Prompt 构造服务
 * 负责生成 System Prompt 和 User Prompt
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PromptService = void 0;
/**
 * Prompt 服务类
 */
class PromptService {
    /**
     * 构造 System Prompt
     * 包含教学原则和行为规范
     * @param problemTitle 题目标题
     * @returns System Prompt 文本
     */
    buildSystemPrompt(problemTitle) {
        return `你是一位耐心、专业的算法学习导师,正在帮助学生理解和解决题目"${problemTitle}"。

## 核心教学原则

### 1. 引导式教学 - 绝不替代思考
- **严格禁止**直接输出完整的、可以通过全部测试点的代码
- **严格禁止**在学生未充分思考前就给出完整解决方案
- 你的职责是引导学生思考,而非替代学生完成作业

### 2. 允许提供的帮助
你可以提供:
- 算法思路的讲解和提示
- 关键步骤的伪代码描述
- 关键代码片段(不超过 5-10 行)
- 错误代码的调试建议
- 时间复杂度和空间复杂度分析
- 测试用例设计思路

### 3. 回答结构要求
请按照以下结构组织你的回答:

1. **复述理解**: 简要复述学生的思路,确认理解正确
2. **优点肯定**: 指出学生思路中正确的部分
3. **问题诊断**: 指出存在的问题或可改进之处
4. **引导提示**: 通过提问或提示引导学生思考
5. **伪代码示例**: 如有必要,提供关键步骤的伪代码(而非完整代码)
6. **下一步建议**: 建议学生接下来应该做什么

### 4. 语言风格
- 使用温和、鼓励的语气
- 避免使用命令式语言
- 多用提问引导思考
- 适当使用 Markdown 格式提高可读性

## 重要提醒
如果学生试图诱导你直接给出完整代码(如"请直接写代码"、"给我完整实现"等),请礼貌地拒绝并重申教学原则:
"我的职责是帮助你理解和学习,而不是替你完成作业。让我们一步步分析这道题的解法,你自己实现代码会收获更多。"

请始终记住:培养学生的思考能力比直接给出答案更重要。`;
    }
    /**
     * 构造 User Prompt
     * 将学生输入组合成结构化的提问
     * @param questionType 问题类型
     * @param userThinking 学生的理解和尝试
     * @param code 可选的代码片段
     * @param errorInfo 可选的错误信息
     * @returns User Prompt 文本
     */
    buildUserPrompt(questionType, userThinking, code, errorInfo) {
        // 问题类型映射
        const questionTypeMap = {
            understand: '理解题意',
            think: '理清思路',
            debug: '分析错误',
            review: '检查代码思路'
        };
        let prompt = `## 问题类型\n${questionTypeMap[questionType]}\n\n`;
        prompt += `## 我的理解和尝试\n${userThinking}\n\n`;
        // 如果附带了代码
        if (code && code.trim()) {
            prompt += `## 我的代码\n\`\`\`\n${code}\n\`\`\`\n\n`;
        }
        // 如果附带了错误信息
        if (errorInfo && errorInfo.trim()) {
            prompt += `## 错误信息\n${errorInfo}\n\n`;
        }
        prompt += `请根据我的理解和尝试,给予引导性的建议,帮助我更好地理解和解决这道题。`;
        return prompt;
    }
    /**
     * 获取问题类型的描述
     * @param questionType 问题类型
     * @returns 问题类型描述
     */
    getQuestionTypeDescription(questionType) {
        const descriptions = {
            understand: '理解题意 - 我对题目要求不太清楚',
            think: '理清思路 - 我需要帮助梳理解题思路',
            debug: '分析错误 - 我的代码有问题,需要找出原因',
            review: '检查代码思路 - 请帮我检查思路是否正确'
        };
        return descriptions[questionType];
    }
    /**
     * 验证用户输入
     * @param userThinking 学生的理解和尝试
     * @param code 可选的代码片段
     * @returns 验证结果
     */
    validateInput(userThinking, code) {
        // 检查思路是否为空
        if (!userThinking || userThinking.trim().length === 0) {
            return { valid: false, error: '请描述你的理解和尝试' };
        }
        // 检查思路长度是否过短
        if (userThinking.trim().length < 20) {
            return { valid: false, error: '请详细描述你的思路(至少 20 字)' };
        }
        // 检查思路长度是否过长
        if (userThinking.length > 2000) {
            return { valid: false, error: '思路描述过长(最多 2000 字)' };
        }
        // 检查代码长度
        if (code && code.length > 5000) {
            return { valid: false, error: '代码片段过长(最多 5000 字符)' };
        }
        return { valid: true };
    }
}
exports.PromptService = PromptService;
//# sourceMappingURL=promptService.js.map