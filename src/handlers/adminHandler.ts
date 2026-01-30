/**
 * 管理员配置 Handler
 * 处理管理员配置 AI 服务的请求
 */

import { Handler, PRIV } from 'hydrooj';
import { AIConfigModel, AIConfig } from '../models/aiConfig';
import { encrypt, decrypt, maskApiKey } from '../lib/crypto';
import { OpenAIClient, fetchAvailableModels } from '../services/openaiClient';
import { builtinJailbreakPatternSources } from '../constants/jailbreakRules';
import { JailbreakLogModel } from '../models/jailbreakLog';
import type { JailbreakLog } from '../models/jailbreakLog';

/**
 * 更新配置请求接口
 */
interface UpdateConfigRequest {
  apiBaseUrl?: string;
  modelName?: string;
  apiKey?: string;             // 新的明文 API Key，若为空字符串则不修改
  rateLimitPerMinute?: number;
  timeoutSeconds?: number;
  systemPromptTemplate?: string;
  extraJailbreakPatternsText?: string;
}

/**
 * GetConfigHandler - 获取当前配置
 * GET /ai-helper/admin/config
 */
export class GetConfigHandler extends Handler {
  async get() {
    try {
      const aiConfigModel: AIConfigModel = this.ctx.get('aiConfigModel');
      const jailbreakLogModel: JailbreakLogModel = this.ctx.get('jailbreakLogModel');

      // 读取配置
      const config = await aiConfigModel.getConfig();
      const recentLogs = await jailbreakLogModel.listRecent(20);

      if (!config) {
        // 尚未配置，返回 null
        this.response.body = {
          config: null,
          builtinJailbreakPatterns: builtinJailbreakPatternSources,
          recentJailbreakLogs: recentLogs.map(formatJailbreakLog)
        };
        this.response.type = 'application/json';
        return;
      }

      // 解密 API Key 并脱敏
      let apiKeyMasked = '';
      let hasApiKey = false;

      try {
        if (config.apiKeyEncrypted) {
          const apiKeyPlain = decrypt(config.apiKeyEncrypted);
          apiKeyMasked = maskApiKey(apiKeyPlain);
          hasApiKey = true;
        }
      } catch (err) {
        // 解密失败，视为无有效 API Key
        console.error('[GetConfigHandler] API Key 解密失败:', err);
        hasApiKey = false;
      }

      // 构造响应(不包含 apiKeyEncrypted 和明文 API Key)
      this.response.body = {
        config: {
          apiBaseUrl: config.apiBaseUrl,
          modelName: config.modelName,
          rateLimitPerMinute: config.rateLimitPerMinute,
          timeoutSeconds: config.timeoutSeconds,
          systemPromptTemplate: config.systemPromptTemplate,
          extraJailbreakPatternsText: config.extraJailbreakPatternsText || '',
          apiKeyMasked,
          hasApiKey,
          updatedAt: config.updatedAt.toISOString()
        },
        builtinJailbreakPatterns: builtinJailbreakPatternSources,
        recentJailbreakLogs: recentLogs.map(formatJailbreakLog)
      };
      this.response.type = 'application/json';

    } catch (err) {
      console.error('[GetConfigHandler] Error:', err);
      this.response.status = 500;
      this.response.body = {
        error: err instanceof Error ? err.message : '获取配置失败'
      };
      this.response.type = 'application/json';
    }
  }
}

/**
 * UpdateConfigHandler - 更新配置
 * PUT /ai-helper/admin/config
 */
export class UpdateConfigHandler extends Handler {
  async put() {
    try {
      const aiConfigModel: AIConfigModel = this.ctx.get('aiConfigModel');

      // 读取请求体
      const body = this.request.body as UpdateConfigRequest;

      // 构造部分更新对象
      const partial: Partial<Omit<AIConfig, '_id' | 'updatedAt'>> = {};

      // 更新字段（如果提供）
      if (body.apiBaseUrl !== undefined) {
        partial.apiBaseUrl = body.apiBaseUrl.trim();
      }

      if (body.modelName !== undefined) {
        partial.modelName = body.modelName.trim();
      }

      if (body.rateLimitPerMinute !== undefined) {
        const rate = parseInt(String(body.rateLimitPerMinute), 10);
        if (rate <= 0) {
          this.response.status = 400;
          this.response.body = {
            error: 'rateLimitPerMinute 必须大于 0'
          };
          this.response.type = 'application/json';
          return;
        }
        partial.rateLimitPerMinute = rate;
      }

      if (body.timeoutSeconds !== undefined) {
        const timeout = parseInt(String(body.timeoutSeconds), 10);
        if (timeout <= 0) {
          this.response.status = 400;
          this.response.body = {
            error: 'timeoutSeconds 必须大于 0'
          };
          this.response.type = 'application/json';
          return;
        }
        partial.timeoutSeconds = timeout;
      }

      if (body.systemPromptTemplate !== undefined) {
        partial.systemPromptTemplate = body.systemPromptTemplate;
      }

      if (body.extraJailbreakPatternsText !== undefined) {
        partial.extraJailbreakPatternsText = body.extraJailbreakPatternsText;
      }

      // 处理 API Key
      if (body.apiKey !== undefined && body.apiKey !== '') {
        // 提供了新的 API Key，加密后存储
        try {
          partial.apiKeyEncrypted = encrypt(body.apiKey.trim());
        } catch (err) {
          this.response.status = 500;
          this.response.body = {
            error: `API Key 加密失败: ${err instanceof Error ? err.message : String(err)}`
          };
          this.response.type = 'application/json';
          return;
        }
      }
      // 如果 apiKey 字段不存在或为空字符串，不修改现有 key

      // 更新配置
      const jailbreakLogModel: JailbreakLogModel = this.ctx.get('jailbreakLogModel');

      await aiConfigModel.updateConfig(partial);

      // 重新读取配置并返回
      const updatedConfig = await aiConfigModel.getConfig();

      if (!updatedConfig) {
        throw new Error('配置更新后读取失败');
      }

      // 解密 API Key 并脱敏
      let apiKeyMasked = '';
      let hasApiKey = false;

      try {
        if (updatedConfig.apiKeyEncrypted) {
          const apiKeyPlain = decrypt(updatedConfig.apiKeyEncrypted);
          apiKeyMasked = maskApiKey(apiKeyPlain);
          hasApiKey = true;
        }
      } catch (err) {
        console.error('[UpdateConfigHandler] API Key 解密失败:', err);
        hasApiKey = false;
      }

      // 返回更新后的配置
      const recentLogs = await jailbreakLogModel.listRecent(20);

      this.response.body = {
        config: {
          apiBaseUrl: updatedConfig.apiBaseUrl,
          modelName: updatedConfig.modelName,
          rateLimitPerMinute: updatedConfig.rateLimitPerMinute,
          timeoutSeconds: updatedConfig.timeoutSeconds,
          systemPromptTemplate: updatedConfig.systemPromptTemplate,
          extraJailbreakPatternsText: updatedConfig.extraJailbreakPatternsText || '',
          apiKeyMasked,
          hasApiKey,
          updatedAt: updatedConfig.updatedAt.toISOString()
        },
        builtinJailbreakPatterns: builtinJailbreakPatternSources,
        recentJailbreakLogs: recentLogs.map(formatJailbreakLog)
      };
      this.response.type = 'application/json';

    } catch (err) {
      console.error('[UpdateConfigHandler] Error:', err);
      this.response.status = 500;
      this.response.body = {
        error: err instanceof Error ? err.message : '更新配置失败'
      };
      this.response.type = 'application/json';
    }
  }
}

/**
 * TestConnectionHandler - 测试 AI 服务连接
 * POST /ai-helper/admin/test-connection
 */
export class TestConnectionHandler extends Handler {
  async post() {
    try {
      const aiConfigModel: AIConfigModel = this.ctx.get('aiConfigModel');

      // 读取当前配置
      const config = await aiConfigModel.getConfig();

      if (!config) {
        this.response.status = 400;
        this.response.body = {
          success: false,
          message: 'AI 服务配置不存在，请先设置配置。'
        };
        this.response.type = 'application/json';
        return;
      }

      // 检查配置完整性
      if (!config.apiBaseUrl || !config.modelName || !config.apiKeyEncrypted) {
        this.response.status = 400;
        this.response.body = {
          success: false,
          message: 'AI 服务配置不完整，请先设置 API Base URL、模型名称和 API Key。'
        };
        this.response.type = 'application/json';
        return;
      }

      // 解密 API Key
      let apiKey: string;
      try {
        apiKey = decrypt(config.apiKeyEncrypted);
      } catch (err) {
        this.response.status = 500;
        this.response.body = {
          success: false,
          message: `API Key 解密失败: ${err instanceof Error ? err.message : String(err)}`
        };
        this.response.type = 'application/json';
        return;
      }

      // 创建临时 OpenAI 客户端
      const client = new OpenAIClient({
        apiBaseUrl: config.apiBaseUrl,
        modelName: config.modelName,
        apiKey,
        timeoutSeconds: config.timeoutSeconds || 30
      });

      // 发送测试请求
      try {
        await client.chat(
          [{ role: 'user', content: 'ping' }],
          'You are a health check assistant for AI Helper.'
        );

        this.response.body = {
          success: true,
          message: '连接成功！AI 服务配置正确。'
        };
        this.response.type = 'application/json';

      } catch (err) {
        // 调用失败，但返回 200(业务层错误，不是 HTTP 错误)
        this.response.status = 200;
        this.response.body = {
          success: false,
          message: err instanceof Error ? err.message : '调用 AI 服务失败'
        };
        this.response.type = 'application/json';
      }

    } catch (err) {
      console.error('[TestConnectionHandler] Error:', err);
      this.response.status = 500;
      this.response.body = {
        success: false,
        message: err instanceof Error ? err.message : '测试连接失败'
      };
      this.response.type = 'application/json';
    }
  }
}

/**
 * 导出路由权限配置
 * 使用 PRIV.PRIV_EDIT_SYSTEM (root-only 权限)
 * AI 配置敏感，仅允许系统管理员访问
 */
export const GetConfigHandlerPriv = PRIV.PRIV_EDIT_SYSTEM;
export const UpdateConfigHandlerPriv = PRIV.PRIV_EDIT_SYSTEM;
export const TestConnectionHandlerPriv = PRIV.PRIV_EDIT_SYSTEM;
export const FetchModelsHandlerPriv = PRIV.PRIV_EDIT_SYSTEM;

/**
 * FetchModelsHandler - 获取 API 端点的可用模型列表
 * POST /ai-helper/admin/fetch-models
 */
export class FetchModelsHandler extends Handler {
  async post() {
    try {
      const body = this.request.body as {
        endpointId?: string;
        apiBaseUrl?: string;
        apiKey?: string;
      };

      let apiBaseUrl: string;
      let apiKey: string;

      if (body.endpointId) {
        // 从现有端点获取配置
        const aiConfigModel: AIConfigModel = this.ctx.get('aiConfigModel');
        const endpoint = await aiConfigModel.getEndpointById(body.endpointId);

        if (!endpoint) {
          this.response.status = 404;
          this.response.body = { success: false, error: '端点不存在' };
          this.response.type = 'application/json';
          return;
        }

        apiBaseUrl = endpoint.apiBaseUrl;
        try {
          apiKey = decrypt(endpoint.apiKeyEncrypted);
        } catch {
          this.response.status = 400;
          this.response.body = { success: false, error: 'API Key 解密失败' };
          this.response.type = 'application/json';
          return;
        }
      } else if (body.apiBaseUrl && body.apiKey) {
        // 使用传入的参数
        apiBaseUrl = body.apiBaseUrl;
        apiKey = body.apiKey;
      } else {
        this.response.status = 400;
        this.response.body = {
          success: false,
          error: '请提供 endpointId 或者 apiBaseUrl + apiKey'
        };
        this.response.type = 'application/json';
        return;
      }

      // 获取模型列表
      const result = await fetchAvailableModels(apiBaseUrl, apiKey);

      if (result.success) {
        // 如果是从端点获取的，更新端点的模型列表和时间戳
        if (body.endpointId) {
          const aiConfigModel: AIConfigModel = this.ctx.get('aiConfigModel');
          await aiConfigModel.updateEndpoint(body.endpointId, {
            models: result.models || [],
            modelsLastFetched: new Date()
          });
        }

        this.response.body = {
          success: true,
          models: result.models
        };
      } else {
        this.response.body = {
          success: false,
          error: result.error
        };
      }
      this.response.type = 'application/json';
    } catch (err) {
      console.error('[FetchModelsHandler] Error:', err);
      this.response.status = 500;
      this.response.body = {
        success: false,
        error: err instanceof Error ? err.message : '获取模型列表失败'
      };
      this.response.type = 'application/json';
    }
  }
}

function formatJailbreakLog(log: JailbreakLog) {
  return {
    id: log._id.toHexString(),
    userId: log.userId,
    problemId: log.problemId,
    conversationId: log.conversationId ? log.conversationId.toHexString() : undefined,
    questionType: log.questionType,
    matchedPattern: log.matchedPattern,
    matchedText: log.matchedText,
    createdAt: log.createdAt.toISOString()
  };
}
