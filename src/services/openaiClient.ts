/**
 * OpenAI 客户端封装
 * 支持 OpenAI 格式的所有兼容 API (OpenAI, Azure OpenAI, 第三方代理等)
 */

import http from 'http';
import https from 'https';
import { Readable } from 'stream';
import axios, { AxiosError } from 'axios';
import type { Context } from 'hydrooj';
import { AIConfigModel, AIConfig } from '../models/aiConfig';
import { decrypt } from '../lib/crypto';
import { API_DEFAULTS } from '../constants/limits';

// ─── HTTP 连接池 ───────────────────────────────────────

const HTTP_AGENT = new http.Agent({ keepAlive: true, maxSockets: 20, maxFreeSockets: 5, timeout: 60_000 });
const HTTPS_AGENT = new https.Agent({ keepAlive: true, maxSockets: 20, maxFreeSockets: 5, timeout: 60_000 });

// ─── 错误分类 & 结构化错误 ────────────────────────────

export type ErrorCategory = 'auth' | 'rate_limit' | 'server' | 'client' | 'timeout' | 'network' | 'aborted' | 'unknown';

const RETRYABLE_CATEGORIES = new Set<ErrorCategory>(['rate_limit', 'server', 'timeout', 'network']);

export class AIServiceError extends Error {
  readonly category: ErrorCategory;
  readonly httpStatus?: number;
  readonly isRetryable: boolean;

  constructor(message: string, category: ErrorCategory, httpStatus?: number) {
    super(message);
    this.name = 'AIServiceError';
    this.category = category;
    this.httpStatus = httpStatus;
    this.isRetryable = RETRYABLE_CATEGORIES.has(category);
  }
}

export const USER_ERROR_MESSAGES: Record<ErrorCategory, string> = {
  auth: 'AI 服务认证失败，请联系管理员检查配置',
  rate_limit: 'AI 服务繁忙，请稍后再试',
  server: 'AI 服务暂时不可用，请稍后再试',
  client: 'AI 服务配置错误，请联系管理员',
  timeout: 'AI 服务响应超时，请稍后再试',
  network: '无法连接到 AI 服务，请稍后再试',
  aborted: '请求已取消',
  unknown: 'AI 服务异常，请稍后再试',
};

export function getHttpStatusForCategory(category: ErrorCategory): number {
  switch (category) {
    case 'rate_limit': return 429;
    case 'auth':       return 503;
    case 'timeout':    return 504;
    case 'network':    return 502;
    case 'server':     return 502;
    case 'client':     return 500;
    case 'aborted':    return 499;
    case 'unknown':
    default:           return 500;
  }
}

// ─── 重试 & 超时 ──────────────────────────────────────

const RETRY = {
  MAX_RETRIES: 2,
  BASE_DELAY_MS: 1000,
  MAX_DELAY_MS: 8000,
  JITTER: 0.3,
  TOTAL_TIMEOUT_MS: 60_000,
} as const;

function calculateBackoffMs(attempt: number): number {
  const base = Math.min(RETRY.BASE_DELAY_MS * 2 ** attempt, RETRY.MAX_DELAY_MS);
  const jitter = base * RETRY.JITTER * (Math.random() * 2 - 1);
  return Math.round(base + jitter);
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new AIServiceError('请求已取消', 'aborted'));
  if (!signal) return new Promise(resolve => setTimeout(resolve, ms));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AIServiceError('请求已取消', 'aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// ─── Token 用量接口 ─────────────────────────────────────

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatResult {
  content: string;
  usage?: TokenUsage;
}

export interface StreamCallbacks {
  onChunk: (content: string) => void;
  onDone: (result: ChatResult) => void;
  onError: (error: AIServiceError) => void;
}

// ─── 接口定义 ─────────────────────────────────────────

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
  timeoutSeconds: number = API_DEFAULTS.FETCH_MODELS_TIMEOUT_MS / 1000
): Promise<FetchModelsResult> {
  // 标准化 URL（移除尾部斜杠）
  const baseUrl = apiBaseUrl.replace(/\/+$/, '');

  try {
    const response = await axios.get<OpenAIModelsResponse>(
      `${baseUrl}${API_DEFAULTS.MODELS_ENDPOINT}`,
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: timeoutSeconds * 1000,
        httpAgent: HTTP_AGENT,
        httpsAgent: HTTPS_AGENT,
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
   * @param options 可选配置,支持 AbortSignal 取消
   * @returns AI 回答的文本内容
   * @throws {AIServiceError} 当 API Key 无效、调用频率超限、网络错误或 AI 服务不可用时抛出
   */
  async chat(messages: ChatMessage[], systemPrompt: string, options?: { signal?: AbortSignal }): Promise<ChatResult> {
    // 构造 OpenAI 格式请求
    const payload = {
      model: this.config.modelName,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages
      ],
      temperature: API_DEFAULTS.DEFAULT_TEMPERATURE,
      max_tokens: API_DEFAULTS.MAX_COMPLETION_TOKENS
    };

    try {
      // 发送请求
      const response = await axios.post<OpenAIResponse>(
        `${this.config.apiBaseUrl}${API_DEFAULTS.CHAT_ENDPOINT}`,
        payload,
        {
          headers: {
            'Authorization': `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/json'
          },
          timeout: this.config.timeoutSeconds * 1000,
          signal: options?.signal,
          httpAgent: HTTP_AGENT,
          httpsAgent: HTTPS_AGENT,
        }
      );

      // 提取 AI 回答
      const aiMessage = response.data?.choices?.[0]?.message?.content;
      if (!aiMessage) {
        throw new AIServiceError('AI 返回内容为空', 'server');
      }

      // 提取 token 用量
      const rawUsage = response.data?.usage;
      const usage: TokenUsage | undefined = rawUsage ? {
        promptTokens: rawUsage.prompt_tokens ?? 0,
        completionTokens: rawUsage.completion_tokens ?? 0,
        totalTokens: rawUsage.total_tokens ?? 0,
      } : undefined;

      return { content: aiMessage, usage };
    } catch (error) {
      // 已经是 AIServiceError 则直接抛出
      if (error instanceof AIServiceError) throw error;

      // AbortController 取消
      if (axios.isCancel(error)) {
        throw new AIServiceError('请求已取消', 'aborted');
      }

      // Axios 错误处理
      if (axios.isAxiosError(error)) {
        const axiosError = error as AxiosError;

        if (axiosError.response) {
          const status = axiosError.response.status;
          const data = axiosError.response.data as { error?: { message?: string } };

          if (status === 401 || status === 403) {
            throw new AIServiceError('API Key 无效或已过期', 'auth', status);
          } else if (status === 429) {
            throw new AIServiceError('API 调用频率超限', 'rate_limit', status);
          } else if (status >= 500) {
            throw new AIServiceError(`AI 服务暂时不可用 (HTTP ${status})`, 'server', status);
          } else {
            const errorMsg = data?.error?.message || '未知错误';
            throw new AIServiceError(`AI API 错误 (HTTP ${status}): ${errorMsg}`, 'client', status);
          }
        } else if (axiosError.code === 'ECONNABORTED' || axiosError.code === 'ETIMEDOUT') {
          throw new AIServiceError(`请求超时 (超过 ${this.config.timeoutSeconds} 秒)`, 'timeout');
        } else if (axiosError.code === 'ENOTFOUND' || axiosError.code === 'ECONNREFUSED') {
          throw new AIServiceError('无法连接到 AI 服务', 'network');
        } else if (axiosError.code === 'ECONNRESET' || axiosError.code === 'EPIPE') {
          throw new AIServiceError('与 AI 服务的连接被中断', 'network');
        } else {
          throw new AIServiceError('网络错误，请稍后重试', 'network');
        }
      }

      // 其他未知错误
      throw new AIServiceError(
        `调用 AI 服务失败: ${error instanceof Error ? error.message : String(error)}`,
        'unknown'
      );
    }
  }

  async chatStream(
    messages: ChatMessage[],
    systemPrompt: string,
    options: { signal?: AbortSignal; callbacks: StreamCallbacks },
  ): Promise<void> {
    const payload = {
      model: this.config.modelName,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages,
      ],
      temperature: API_DEFAULTS.DEFAULT_TEMPERATURE,
      max_tokens: API_DEFAULTS.MAX_COMPLETION_TOKENS,
      stream: true,
      stream_options: { include_usage: true },
    };

    let response: any;
    try {
      response = await axios.post(
        `${this.config.apiBaseUrl}${API_DEFAULTS.CHAT_ENDPOINT}`,
        payload,
        {
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: this.config.timeoutSeconds * 1000,
          signal: options.signal,
          responseType: 'stream',
          httpAgent: HTTP_AGENT,
          httpsAgent: HTTPS_AGENT,
        },
      );
    } catch (error) {
      if (error instanceof AIServiceError) throw error;
      if (axios.isCancel(error)) throw new AIServiceError('请求已取消', 'aborted');
      if (axios.isAxiosError(error)) {
        const ae = error as AxiosError;
        if (ae.response) {
          const status = ae.response.status;
          if (status === 401 || status === 403) throw new AIServiceError('API Key 无效或已过期', 'auth', status);
          if (status === 429) throw new AIServiceError('API 调用频率超限', 'rate_limit', status);
          if (status >= 500) throw new AIServiceError(`AI 服务暂时不可用 (HTTP ${status})`, 'server', status);
          throw new AIServiceError(`AI API 错误 (HTTP ${status})`, 'client', status);
        }
        if (ae.code === 'ECONNABORTED' || ae.code === 'ETIMEDOUT') throw new AIServiceError('请求超时', 'timeout');
        if (ae.code === 'ENOTFOUND' || ae.code === 'ECONNREFUSED') throw new AIServiceError('无法连接到 AI 服务', 'network');
        throw new AIServiceError('网络错误', 'network');
      }
      throw new AIServiceError(error instanceof Error ? error.message : String(error), 'unknown');
    }

    // Verify streaming response
    const contentType = response.headers?.['content-type'] || '';
    if (!contentType.includes('text/event-stream') && !contentType.includes('application/octet-stream')) {
      response.data?.destroy?.();
      throw new AIServiceError('端点不支持流式响应', 'client');
    }

    const stream: Readable = response.data;

    // Extend socket timeout for long-running streaming connections (e.g. thinking models)
    const socketTimeoutMs = this.config.timeoutSeconds * 1000 + 10_000;
    response.data?.socket?.setTimeout?.(socketTimeoutMs);

    // Use configured timeout as chunk timeout (minimum: default 30s for fast models)
    const chunkTimeoutMs = Math.max(API_DEFAULTS.STREAM_CHUNK_TIMEOUT_MS, this.config.timeoutSeconds * 1000);
    await this.parseSSEStream(stream, options.callbacks, options.signal, chunkTimeoutMs);
  }

  private parseSSEStream(stream: Readable, callbacks: StreamCallbacks, signal?: AbortSignal, chunkTimeoutMs?: number): Promise<void> {
    const effectiveChunkTimeout = chunkTimeoutMs ?? API_DEFAULTS.STREAM_CHUNK_TIMEOUT_MS;
    return new Promise<void>((resolve, reject) => {
      let buffer = '';
      let fullContent = '';
      let usage: TokenUsage | undefined;
      let chunkTimer: ReturnType<typeof setTimeout> | null = null;

      const resetChunkTimer = () => {
        if (chunkTimer) clearTimeout(chunkTimer);
        chunkTimer = setTimeout(() => {
          stream.destroy();
          reject(new AIServiceError('流式响应 chunk 超时', 'timeout'));
        }, effectiveChunkTimeout);
      };

      const cleanup = () => {
        if (chunkTimer) clearTimeout(chunkTimer);
        signal?.removeEventListener('abort', onAbort);
      };

      const onAbort = () => {
        cleanup();
        stream.destroy();
        reject(new AIServiceError('请求已取消', 'aborted'));
      };

      signal?.addEventListener('abort', onAbort, { once: true });
      resetChunkTimer();

      stream.on('data', (chunk: Buffer) => {
        resetChunkTimer();
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue;
          if (!trimmed.startsWith('data: ')) continue;
          const payload = trimmed.slice(6);
          if (payload === '[DONE]') continue;

          try {
            const parsed = JSON.parse(payload);
            // Extract usage from final chunk
            if (parsed.usage) {
              usage = {
                promptTokens: parsed.usage.prompt_tokens ?? 0,
                completionTokens: parsed.usage.completion_tokens ?? 0,
                totalTokens: parsed.usage.total_tokens ?? 0,
              };
            }
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) {
              fullContent += delta;
              callbacks.onChunk(delta);
            }
          } catch {
            // Skip malformed JSON lines
          }
        }
      });

      stream.on('end', () => {
        cleanup();
        if (!fullContent) {
          reject(new AIServiceError('AI 返回内容为空', 'server'));
          return;
        }
        callbacks.onDone({ content: fullContent, usage });
        resolve();
      });

      stream.on('error', (err) => {
        cleanup();
        reject(new AIServiceError(err.message || '流式传输错误', 'network'));
      });
    });
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
      const result = await this.chat(
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
  usage?: TokenUsage;
  usedModel: {
    endpointId: string;
    endpointName: string;
    modelName: string;
  };
}

/**
 * 多模型客户端类
 * 支持按 fallback 顺序尝试多个模型，带重试和总超时
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
   * 发送对话请求，支持 fallback + 重试 + 总超时
   */
  async chat(messages: ChatMessage[], systemPrompt: string, options?: { signal?: AbortSignal }): Promise<MultiModelChatResult> {
    // 外部 signal 已取消则立即抛出
    if (options?.signal?.aborted) {
      throw new AIServiceError('请求已取消', 'aborted');
    }

    const errors: Array<{ model: string; error: string; category: ErrorCategory }> = [];
    const skippedEndpoints = new Set<string>();

    // L3: 全 fallback 链总超时 — 取配置值与默认值中的较大者
    const totalTimeoutMs = Math.max(RETRY.TOTAL_TIMEOUT_MS, this.clients[0].config.timeoutSeconds * 1000);
    const totalAc = new AbortController();
    let timedOut = false;
    const totalTimer = setTimeout(() => { timedOut = true; totalAc.abort(); }, totalTimeoutMs);

    // 外部 signal 级联到内部 totalAc
    const onExternalAbort = () => totalAc.abort();
    options?.signal?.addEventListener('abort', onExternalAbort, { once: true });

    try {
      for (const { config, client } of this.clients) {
        if (skippedEndpoints.has(config.endpointId)) continue;

        for (let attempt = 0; attempt <= RETRY.MAX_RETRIES; attempt++) {
          // 每次迭代检查总超时
          if (totalAc.signal.aborted) {
            throw timedOut
              ? new AIServiceError('AI 服务总超时', 'timeout')
              : new AIServiceError('请求已取消', 'aborted');
          }

          try {
            const chatResult = await client.chat(messages, systemPrompt, { signal: totalAc.signal });
            return {
              content: chatResult.content,
              usage: chatResult.usage,
              usedModel: {
                endpointId: config.endpointId,
                endpointName: config.endpointName,
                modelName: config.modelName
              }
            };
          } catch (error) {
            const aiError = error instanceof AIServiceError
              ? error
              : new AIServiceError(error instanceof Error ? error.message : String(error), 'unknown');

            // aborted → 区分内部超时 vs 外部取消
            if (aiError.category === 'aborted') {
              throw timedOut
                ? new AIServiceError('AI 服务总超时', 'timeout')
                : aiError;
            }

            errors.push({
              model: `${config.endpointName}/${config.modelName}`,
              error: aiError.message,
              category: aiError.category
            });

            // auth → 跳过该端点的所有模型
            if (aiError.category === 'auth') {
              skippedEndpoints.add(config.endpointId);
              console.warn(`[MultiModelClient] 端点 "${config.endpointName}" 认证失败，跳过其所有模型`);
              break;
            }

            // client → 跳过该模型
            if (aiError.category === 'client') {
              console.warn(`[MultiModelClient] 模型 "${config.modelName}" 不可用，尝试下一个`);
              break;
            }

            // 可重试 + 尚有重试次数 → backoff 后重试
            if (aiError.isRetryable && attempt < RETRY.MAX_RETRIES) {
              const delay = calculateBackoffMs(attempt);
              console.warn(`[MultiModelClient] ${config.modelName} 失败 (${aiError.category})，${delay}ms 后重试 (${attempt + 1}/${RETRY.MAX_RETRIES})`);
              try {
                await abortableDelay(delay, totalAc.signal);
              } catch (delayErr) {
                // backoff 期间被 abort → 区分内部超时 vs 外部取消
                if (delayErr instanceof AIServiceError && delayErr.category === 'aborted') {
                  throw timedOut
                    ? new AIServiceError('AI 服务总超时', 'timeout')
                    : delayErr;
                }
                throw delayErr;
              }
              continue;
            }

            // 不可重试 或 重试次数耗尽 → 尝试下一个模型
            console.warn(`[MultiModelClient] ${config.modelName} 最终失败: ${aiError.message}`);
            break;
          }
        }
      }

      // 所有模型均失败 — 结构化日志
      const categoryCounts = new Map<ErrorCategory, number>();
      for (const e of errors) {
        categoryCounts.set(e.category, (categoryCounts.get(e.category) || 0) + 1);
      }
      let dominantCategory: ErrorCategory = 'unknown';
      let maxCount = 0;
      for (const [cat, count] of categoryCounts) {
        if (count > maxCount) { maxCount = count; dominantCategory = cat; }
      }

      console.error('[MultiModelClient] 所有模型均失败:', JSON.stringify({
        timestamp: new Date().toISOString(),
        totalAttempts: errors.length,
        modelCount: this.clients.length,
        skippedEndpoints: [...skippedEndpoints],
        errors: errors.map(e => ({
          model: e.model,
          category: e.category,
          message: e.error.substring(0, 200)
        })),
      }));

      throw new AIServiceError(USER_ERROR_MESSAGES[dominantCategory], dominantCategory);
    } finally {
      clearTimeout(totalTimer);
      options?.signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  async chatStream(
    messages: ChatMessage[],
    systemPrompt: string,
    options: { signal?: AbortSignal; callbacks: StreamCallbacks },
  ): Promise<{ usedModel: MultiModelChatResult['usedModel'] }> {
    if (options.signal?.aborted) {
      throw new AIServiceError('请求已取消', 'aborted');
    }

    const errors: Array<{ model: string; error: string; category: ErrorCategory }> = [];
    const skippedEndpoints = new Set<string>();

    for (const { config, client } of this.clients) {
      if (skippedEndpoints.has(config.endpointId)) continue;

      try {
        await client.chatStream(messages, systemPrompt, {
          signal: options.signal,
          callbacks: options.callbacks,
        });
        return {
          usedModel: {
            endpointId: config.endpointId,
            endpointName: config.endpointName,
            modelName: config.modelName,
          },
        };
      } catch (error) {
        const aiError = error instanceof AIServiceError
          ? error
          : new AIServiceError(error instanceof Error ? error.message : String(error), 'unknown');

        if (aiError.category === 'aborted') throw aiError;

        errors.push({
          model: `${config.endpointName}/${config.modelName}`,
          error: aiError.message,
          category: aiError.category,
        });

        if (aiError.category === 'auth') {
          skippedEndpoints.add(config.endpointId);
          console.warn(`[MultiModelClient] Stream: 端点 "${config.endpointName}" 认证失败，跳过`);
          continue;
        }
        if (aiError.category === 'client') {
          console.warn(`[MultiModelClient] Stream: 模型 "${config.modelName}" 不支持流式，尝试下一个`);
          continue;
        }

        // Non-retryable or only one endpoint — no retry for streaming
        console.warn(`[MultiModelClient] Stream: ${config.modelName} 失败: ${aiError.message}`);
        continue;
      }
    }

    // All failed
    let dominantCategory: ErrorCategory = 'unknown';
    let maxCount = 0;
    const categoryCounts = new Map<ErrorCategory, number>();
    for (const e of errors) {
      categoryCounts.set(e.category, (categoryCounts.get(e.category) || 0) + 1);
    }
    for (const [cat, count] of categoryCounts) {
      if (count > maxCount) { maxCount = count; dominantCategory = cat; }
    }

    throw new AIServiceError(USER_ERROR_MESSAGES[dominantCategory], dominantCategory);
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
