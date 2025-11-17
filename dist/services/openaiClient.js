"use strict";
/**
 * OpenAI 客户端封装
 * 支持 OpenAI 格式的所有兼容 API (OpenAI, Azure OpenAI, 第三方代理等)
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpenAIClient = void 0;
const axios_1 = __importDefault(require("axios"));
/**
 * OpenAI 客户端类
 * 封装所有 AI API 调用逻辑
 */
class OpenAIClient {
    constructor(config) {
        this.config = config;
    }
    /**
     * 发送对话请求并获取 AI 回答
     * @param messages 对话消息数组
     * @param systemPrompt 系统提示词
     * @returns AI 回答内容
     */
    async chat(messages, systemPrompt) {
        // 构造 OpenAI 格式请求
        const payload = {
            model: this.config.modelName,
            messages: [
                { role: 'system', content: systemPrompt },
                ...messages
            ],
            temperature: 0.7,
            max_tokens: 1500
        };
        try {
            // 发送请求
            const response = await axios_1.default.post(`${this.config.apiBaseUrl}/chat/completions`, payload, {
                headers: {
                    'Authorization': `Bearer ${this.config.apiKey}`,
                    'Content-Type': 'application/json'
                },
                timeout: this.config.timeoutSeconds * 1000
            });
            // 提取 AI 回答
            const aiMessage = response.data.choices[0]?.message?.content;
            if (!aiMessage) {
                throw new Error('AI 返回内容为空');
            }
            return aiMessage;
        }
        catch (error) {
            // 错误处理
            if (axios_1.default.isAxiosError(error)) {
                const axiosError = error;
                // 处理不同类型的错误
                if (axiosError.response) {
                    // HTTP 错误响应 (4xx, 5xx)
                    const status = axiosError.response.status;
                    const data = axiosError.response.data;
                    if (status === 401) {
                        throw new Error('API Key 无效或已过期');
                    }
                    else if (status === 429) {
                        throw new Error('API 调用频率超限,请稍后再试');
                    }
                    else if (status >= 500) {
                        throw new Error(`AI 服务暂时不可用 (HTTP ${status})`);
                    }
                    else {
                        const errorMsg = data?.error?.message || '未知错误';
                        throw new Error(`AI API 错误: ${errorMsg}`);
                    }
                }
                else if (axiosError.code === 'ECONNABORTED') {
                    // 超时错误
                    throw new Error(`请求超时 (超过 ${this.config.timeoutSeconds} 秒)`);
                }
                else if (axiosError.code === 'ENOTFOUND' || axiosError.code === 'ECONNREFUSED') {
                    // 网络错误
                    throw new Error('无法连接到 AI 服务,请检查网络或 API Base URL');
                }
                else {
                    throw new Error(`网络错误: ${axiosError.message}`);
                }
            }
            // 其他未知错误
            throw new Error(`调用 AI 服务失败: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    /**
     * 测试连接是否正常
     * @returns 测试结果
     */
    async testConnection() {
        const startTime = Date.now();
        try {
            await this.chat([{ role: 'user', content: 'Hello' }], 'You are a helpful assistant.');
            const latency = Date.now() - startTime;
            return { success: true, latency };
        }
        catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }
}
exports.OpenAIClient = OpenAIClient;
//# sourceMappingURL=openaiClient.js.map