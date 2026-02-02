/**
 * OpenAI 客户端封装
 * 支持 OpenAI 格式的所有兼容 API (OpenAI, Azure OpenAI, 第三方代理等)
 */

import axios, { AxiosError } from 'axios';
import type { Context } from 'hydrooj';
import { AIConfigModel, AIConfig } from '../models/aiConfig';
import { decrypt } from '../lib/crypto';

/**
 * AI 客户端配置接口
 */
export interface AIClientConfig {
  /** API Base URL, 例如: https://api.openai.com/v1 */
  apiBaseUrl: string;
  /** 模型名称, 例如: gpt-4, gpt-3.5-turbo */
  modelName: string;
  /** API Key */
  apiKey: string;
  /** 超时时间(秒) */
  timeoutSeconds: number;
}

/**
 * 对话消息接口
 */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/**
 * OpenAI API 响应接口
 */
interface OpenAIResponse {
  choices: Array<{
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * OpenAI Models 列表响应接口
 */
interface OpenAIModelsResponse {
  data: Array<{
    id: string;
    object: string;
    created?: number;
    owned_by?: string;
    capabilities?: {
      chat?: boolean;
      completion?: boolean;
    };
  }>;
}

/**
 * 模型获取结果
 */
export interface FetchModelsResult {
  success: boolean;
  models?: string[];
  error?: string;
}

/**
 * 获取可用模型列表
 * 调用 /models 端点获取 API 提供的模型列表
 *
 * @param apiBaseUrl API Base URL
 * @param apiKey API Key（明文）
 * @param timeoutSeconds 超时时间（秒），默认 15
 * @returns 模型列表或错误信息
 */
export async function fetchAvailableModels(
  apiBaseUrl: string,
  apiKey: string,
  timeoutSeconds: number = 15
): Promise<FetchModelsResult> {
  // 标准化 URL（移除尾部斜杠）
  const baseUrl = apiBaseUrl.replace(/\/+$/, '');

  try {
    const response = await axios.get<OpenAIModelsResponse>(
      `${baseUrl}/models`,
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: timeoutSeconds * 1000
      }
    );

    if (!response.data?.data || !Array.isArray(response.data.data)) {
      return {
        success: false,
        error: 'API 返回格式无效：缺少 data 字段'
      };
    }

    // 过滤聊天类模型
    // 优先根据 capabilities 判断，其次根据模型名称特征
    const chatModels = response.data.data.filter(model => {
      // 如果有 capabilities 字段，优先使用
      if (model.capabilities?.chat === true) {
        return true;
      }

      // 根据模型 ID 特征过滤
      const id = model.id.toLowerCase();

      // 包含这些关键词的通常是聊天模型
      // ep- 用于匹配火山引擎的 Endpoint ID 格式（如 ep-20241234567890-xxxxx）
      const chatKeywords = ['gpt', 'chat', 'claude', 'gemini', 'llama', 'mistral', 'qwen', 'yi', 'deepseek', 'doubao', 'glm', 'kimi', 'ep-'];
      const hasMatch = chatKeywords.some(keyword => id.includes(keyword));

      // 排除明显的非聊天模型
      const excludeKeywords = ['embedding', 'whisper', 'tts', 'dall-e', 'moderation', 'audio'];
      const isExcluded = excludeKeywords.some(keyword => id.includes(keyword));

      return hasMatch && !isExcluded;
    });

    // 按模型 ID 排序
    const modelIds = chatModels.map(m => m.id).sort();

    return {
      success: true,
      models: modelIds
    };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError;

      if (axiosError.response) {
        const status = axiosError.response.status;
        const data = axiosError.response.data as { error?: { message?: string } };

        if (status === 401) {
          return { success: false, error: 'API Key 无效或已过期' };
        } else if (status === 403) {
          return { success: false, error: '无权访问模型列表' };
        } else if (status === 404) {
          // 某些 API（如 Azure）可能不支持 /models 端点
          return { success: false, error: '该 API 不支持获取模型列表，请手动输入模型名称' };
        } else {
          const errorMsg = data?.error?.message || `HTTP ${status}`;
          return { success: false, error: `获取模型列表失败: ${errorMsg}` };
        }
      } else if (axiosError.code === 'ECONNABORTED') {
        return { success: false, error: `请求超时 (${timeoutSeconds} 秒)` };
      } else if (axiosError.code === 'ENOTFOUND' || axiosError.code === 'ECONNREFUSED') {
        return { success: false, error: '无法连接到 API 服务器，请检查 URL' };
      } else {
        return { success: false, error: `网络错误: ${axiosError.message}` };
      }
    }

    return {
      success: false,
      error: `获取模型列表失败: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

/**
 * OpenAI 客户端类
 * 封装所有 AI API 调用逻辑
 */
export class OpenAIClient {
  constructor(private config: AIClientConfig) {}

  /**
   * 发送对话请求并获取 AI 回答
   *
   * @param messages 对话消息数组,包含用户和助手的历史消息
   * @param systemPrompt 系统提示词,用于定义 AI 的行为和角色
   * @returns AI 回答的文本内容
   * @throws {Error} 当 API Key 无效、调用频率超限、网络错误或 AI 服务不可用时抛出错误
   */
  async chat(messages: ChatMessage[], systemPrompt: string): Promise<string> {
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
      const response = await axios.post<OpenAIResponse>(
        `${this.config.apiBaseUrl}/chat/completions`,
        payload,
        {
          headers: {
            'Authorization': `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/json'
          },
          timeout: this.config.timeoutSeconds * 1000
        }
      );

      // 提取 AI 回答
      const aiMessage = response.data.choices[0]?.message?.content;
      if (!aiMessage) {
        throw new Error('AI 返回内容为空');
      }

      return aiMessage;
    } catch (error) {
      // 错误处理
      if (axios.isAxiosError(error)) {
        const axiosError = error as AxiosError;

        // 处理不同类型的错误
        if (axiosError.response) {
          // HTTP 错误响应 (4xx, 5xx)
          const status = axiosError.response.status;
          const data = axiosError.response.data as { error?: { message?: string } };

          if (status === 401) {
            throw new Error('API Key 无效或已过期');
          } else if (status === 429) {
            throw new Error('API 调用频率超限,请稍后再试');
          } else if (status >= 500) {
            throw new Error(`AI 服务暂时不可用 (HTTP ${status})`);
          } else {
            const errorMsg = data?.error?.message || '未知错误';
            throw new Error(`AI API 错误 (HTTP ${status}): ${errorMsg}`);
          }
        } else if (axiosError.code === 'ECONNABORTED') {
          // 超时错误
          throw new Error(`请求超时 (超过 ${this.config.timeoutSeconds} 秒)`);
        } else if (axiosError.code === 'ENOTFOUND' || axiosError.code === 'ECONNREFUSED') {
          // 网络错误
          throw new Error('无法连接到 AI 服务,请检查网络或 API Base URL');
        } else {
          throw new Error(`网络错误: ${axiosError.message}`);
        }
      }

      // 其他未知错误
      throw new Error(`调用 AI 服务失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 测试连接是否正常
   * 发送一个简单的测试请求以验证 API 配置是否正确
   *
   * @returns 测试结果对象,包含 success(是否成功)、error(错误信息)和 latency(响应延迟,毫秒)
   */
  async testConnection(): Promise<{ success: boolean; error?: string; latency?: number }> {
    const startTime = Date.now();

    try {
      await this.chat(
        [{ role: 'user', content: 'Hello' }],
        'You are a helpful assistant.'
      );

      const latency = Date.now() - startTime;
      return { success: true, latency };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
}

/**
 * 从数据库配置创建 OpenAI 客户端
 * 自动读取数据库中的 AI 配置,解密 API Key,并创建客户端实例
 *
 * @param ctx HydroOJ Context,用于访问数据库和日志服务
 * @returns OpenAI 客户端实例
 * @throws {Error} 如果配置不存在、不完整或 API Key 解密失败
 */
export async function createOpenAIClientFromConfig(
  ctx: Context,
  existingConfig?: AIConfig | null
): Promise<OpenAIClient> {
  let config = existingConfig ?? null;

  if (!config) {
    const aiConfigModel: AIConfigModel = ctx.get('aiConfigModel');
    config = await aiConfigModel.getConfig();
  }

  if (!config) {
    throw new Error('AI 服务尚未配置，请联系管理员在控制面板中完成配置。');
  }

  // 检查配置完整性
  if (!config.apiBaseUrl || !config.modelName || !config.apiKeyEncrypted) {
    throw new Error('AI 服务配置不完整，请联系管理员检查 API Base URL、模型名称和 API Key。');
  }

  // 解密 API Key
  let apiKey: string;
  try {
    apiKey = decrypt(config.apiKeyEncrypted);
  } catch (err) {
    throw new Error('AI 服务配置错误：API Key 解密失败，请联系管理员重新配置。');
  }

  // 创建客户端实例
  return new OpenAIClient({
    apiBaseUrl: config.apiBaseUrl,
    modelName: config.modelName,
    apiKey,
    timeoutSeconds: config.timeoutSeconds || 30
  });
}

/**
 * 解析后的模型配置（用于 MultiModelClient）
 */
export interface ResolvedModelConfig {
  endpointId: string;
  endpointName: string;
  apiBaseUrl: string;
  apiKey: string;  // 已解密的 API Key
  modelName: string;
  timeoutSeconds: number;
}

/**
 * MultiModelClient 聊天结果
 */
export interface MultiModelChatResult {
  content: string;
  usedModel: {
    endpointId: string;
    endpointName: string;
    modelName: string;
  };
}

/**
 * 错误类型分类
 */
type ErrorCategory = 'auth' | 'rate_limit' | 'server' | 'client' | 'timeout' | 'network' | 'unknown';

/**
 * 多模型客户端类
 * 支持按 fallback 顺序尝试多个模型
 */
export class MultiModelClient {
  private clients: Array<{
    config: ResolvedModelConfig;
    client: OpenAIClient;
  }>;

  constructor(models: ResolvedModelConfig[]) {
    if (models.length === 0) {
      throw new Error('至少需要配置一个模型');
    }

    this.clients = models.map(config => ({
      config,
      client: new OpenAIClient({
        apiBaseUrl: config.apiBaseUrl,
        modelName: config.modelName,
        apiKey: config.apiKey,
        timeoutSeconds: config.timeoutSeconds
      })
    }));
  }

  /**
   * 发送对话请求，支持 fallback
   */
  async chat(messages: ChatMessage[], systemPrompt: string): Promise<MultiModelChatResult> {
    const errors: Array<{ model: string; error: string; category: ErrorCategory }> = [];
    const skippedEndpoints = new Set<string>(); // 跳过的端点（401/403错误）

    for (const { config, client } of this.clients) {
      // 如果该端点已被跳过（因为认证错误），跳过该端点的所有模型
      if (skippedEndpoints.has(config.endpointId)) {
        continue;
      }

      try {
        const content = await client.chat(messages, systemPrompt);
        return {
          content,
          usedModel: {
            endpointId: config.endpointId,
            endpointName: config.endpointName,
            modelName: config.modelName
          }
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const category = this.categorizeError(errorMessage);

        errors.push({
          model: `${config.endpointName}/${config.modelName}`,
          error: errorMessage,
          category
        });

        // 根据错误类型决定是否继续尝试
        if (category === 'auth') {
          // 认证错误：跳过该端点的所有模型
          skippedEndpoints.add(config.endpointId);
          console.warn(`[MultiModelClient] 端点 "${config.endpointName}" 认证失败，跳过其所有模型`);
        } else if (category === 'client') {
          // 客户端错误（400/404）：跳过该模型，继续尝试下一个
          console.warn(`[MultiModelClient] 模型 "${config.modelName}" 不可用，尝试下一个`);
        } else if (category === 'rate_limit') {
          // 限流：继续尝试下一个
          console.warn(`[MultiModelClient] 端点 "${config.endpointName}" 限流，尝试下一个`);
        } else {
          // 服务器错误、超时、网络错误：继续尝试
          console.warn(`[MultiModelClient] ${config.modelName} 失败: ${errorMessage}`);
        }
      }
    }

    // 所有模型都失败，抛出聚合错误
    const errorSummary = errors
      .map(e => `[${e.model}] ${e.error}`)
      .join('; ');
    throw new Error(`所有 AI 模型均不可用。详情: ${errorSummary}`);
  }

  /**
   * 错误分类
   */
  private categorizeError(message: string): ErrorCategory {
    const lowerMessage = message.toLowerCase();

    if (lowerMessage.includes('401') || lowerMessage.includes('api key') ||
        lowerMessage.includes('无效') || lowerMessage.includes('过期') ||
        lowerMessage.includes('403') || lowerMessage.includes('无权')) {
      return 'auth';
    }
    if (lowerMessage.includes('429') || lowerMessage.includes('频率') ||
        lowerMessage.includes('rate') || lowerMessage.includes('limit')) {
      return 'rate_limit';
    }
    if (lowerMessage.includes('500') || lowerMessage.includes('502') ||
        lowerMessage.includes('503') || lowerMessage.includes('504') ||
        lowerMessage.includes('服务不可用')) {
      return 'server';
    }
    if (lowerMessage.includes('400') || lowerMessage.includes('404') ||
        lowerMessage.includes('不存在') || lowerMessage.includes('无效参数')) {
      return 'client';
    }
    if (lowerMessage.includes('超时') || lowerMessage.includes('timeout')) {
      return 'timeout';
    }
    if (lowerMessage.includes('网络') || lowerMessage.includes('连接') ||
        lowerMessage.includes('econnrefused') || lowerMessage.includes('enotfound')) {
      return 'network';
    }
    return 'unknown';
  }
}

/**
 * 从数据库配置创建 MultiModelClient
 * 支持多端点、多模型 fallback
 */
export async function createMultiModelClientFromConfig(
  ctx: Context,
  existingConfig?: AIConfig | null
): Promise<MultiModelClient> {
  const aiConfigModel: AIConfigModel = ctx.get('aiConfigModel');
  const config = existingConfig ?? await aiConfigModel.getConfig();

  if (!config) {
    throw new Error('AI 服务尚未配置，请联系管理员在控制面板中完成配置。');
  }

  // 优先使用新版多端点配置
  if (config.endpoints && config.endpoints.length > 0 && config.selectedModels && config.selectedModels.length > 0) {
    const resolvedModels: ResolvedModelConfig[] = [];

    for (const selected of config.selectedModels) {
      const endpoint = config.endpoints.find(ep => ep.id === selected.endpointId);
      if (!endpoint || !endpoint.enabled) {
        continue;
      }

      let apiKey: string;
      try {
        apiKey = decrypt(endpoint.apiKeyEncrypted);
      } catch {
        console.warn(`[MultiModelClient] 端点 "${endpoint.name}" 的 API Key 解密失败，跳过`);
        continue;
      }

      resolvedModels.push({
        endpointId: endpoint.id,
        endpointName: endpoint.name,
        apiBaseUrl: endpoint.apiBaseUrl,
        apiKey,
        modelName: selected.modelName,
        timeoutSeconds: config.timeoutSeconds || 30
      });
    }

    if (resolvedModels.length > 0) {
      return new MultiModelClient(resolvedModels);
    }
  }

  // 回退到旧版单端点配置
  if (!config.apiBaseUrl || !config.modelName || !config.apiKeyEncrypted) {
    throw new Error('AI 服务配置不完整，请联系管理员检查配置。');
  }

  let apiKey: string;
  try {
    apiKey = decrypt(config.apiKeyEncrypted);
  } catch {
    throw new Error('AI 服务配置错误：API Key 解密失败，请联系管理员重新配置。');
  }

  return new MultiModelClient([{
    endpointId: 'legacy',
    endpointName: '默认端点',
    apiBaseUrl: config.apiBaseUrl,
    apiKey,
    modelName: config.modelName,
    timeoutSeconds: config.timeoutSeconds || 30
  }]);
}
