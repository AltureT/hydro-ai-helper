/**
 * AI 配置页面 Handler
 * 处理管理员配置页面的渲染和配置请求
 */

import { Handler, PRIV } from 'hydrooj';
import { AIConfig, AIConfigModel, APIEndpoint, SelectedModel } from '../models/aiConfig';
import { decrypt, encrypt, maskApiKey } from '../lib/crypto';
import { builtinJailbreakPatternSources } from '../constants/jailbreakRules';
import { JailbreakLogModel } from '../models/jailbreakLog';
import type { JailbreakLog } from '../models/jailbreakLog';

/**
 * 更新配置请求接口（兼容旧版 + 新版多端点）
 */
interface UpdateConfigRequest {
  // 旧版单端点字段（向后兼容）
  apiBaseUrl?: string;
  modelName?: string;
  apiKey?: string;
  // 新版多端点字段
  endpoints?: Array<{
    id?: string;
    name: string;
    apiBaseUrl: string;
    apiKey?: string;  // 明文 API Key，仅新建或更新时传入
    models?: string[];
    enabled?: boolean;
  }>;
  selectedModels?: SelectedModel[];
  // 通用字段
  rateLimitPerMinute?: number;
  timeoutSeconds?: number;
  systemPromptTemplate?: string;
  extraJailbreakPatternsText?: string;
}

/**
 * AdminConfigHandler - AI 配置页面
 * GET /ai-helper/admin/config
 */
export class AdminConfigHandler extends Handler {
  async get() {
    try {
      // 当 Accept 包含 text/html 时才渲染页面；其他情况返回 JSON 配置
      const accept = this.request.headers.accept || '';
      const prefersHtml = accept.includes('text/html');

      if (prefersHtml) {
        this.response.template = 'ai-helper/admin_config.html';
        this.response.body = {};
        return;
      }

      const aiConfigModel: AIConfigModel = this.ctx.get('aiConfigModel');
      const jailbreakLogModel: JailbreakLogModel = this.ctx.get('jailbreakLogModel');

      // 解析分页参数
      const page = parseInt(String(this.request.query.page || '1'), 10) || 1;
      const limit = parseInt(String(this.request.query.limit || '20'), 10) || 20;

      const config = await aiConfigModel.getConfig();
      const logResult = await jailbreakLogModel.listWithPagination(page, limit);

      if (!config) {
        this.response.body = {
          config: null,
          builtinJailbreakPatterns: builtinJailbreakPatternSources,
          jailbreakLogs: {
            logs: logResult.logs.map(formatJailbreakLog),
            total: logResult.total,
            page: logResult.page,
            totalPages: logResult.totalPages
          },
          // 兼容旧前端
          recentJailbreakLogs: logResult.logs.map(formatJailbreakLog)
        };
        this.response.type = 'application/json';
        return;
      }

      // 处理端点的 API Key 脱敏
      const endpointsWithMaskedKeys = (config.endpoints || []).map(ep => {
        let apiKeyMasked = '';
        let hasApiKey = false;
        try {
          if (ep.apiKeyEncrypted) {
            const apiKeyPlain = decrypt(ep.apiKeyEncrypted);
            apiKeyMasked = maskApiKey(apiKeyPlain);
            hasApiKey = true;
          }
        } catch {
          hasApiKey = false;
        }
        return {
          id: ep.id,
          name: ep.name,
          apiBaseUrl: ep.apiBaseUrl,
          models: ep.models || [],
          modelsLastFetched: ep.modelsLastFetched?.toISOString(),
          enabled: ep.enabled,
          apiKeyMasked,
          hasApiKey,
        };
      });

      // 兼容旧版：处理旧版单 API Key
      let apiKeyMasked = '';
      let hasApiKey = false;
      try {
        if (config.apiKeyEncrypted) {
          const apiKeyPlain = decrypt(config.apiKeyEncrypted);
          apiKeyMasked = maskApiKey(apiKeyPlain);
          hasApiKey = true;
        }
      } catch (err) {
        console.error('[AdminConfigHandler] API Key 解密失败:', err);
        hasApiKey = false;
      }

      this.response.body = {
        config: {
          // 新版多端点字段
          endpoints: endpointsWithMaskedKeys,
          selectedModels: config.selectedModels || [],
          // 旧版字段（向后兼容）
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
        jailbreakLogs: {
          logs: logResult.logs.map(formatJailbreakLog),
          total: logResult.total,
          page: logResult.page,
          totalPages: logResult.totalPages
        },
        // 兼容旧前端
        recentJailbreakLogs: logResult.logs.map(formatJailbreakLog)
      };
      this.response.type = 'application/json';
    } catch (err) {
      console.error('[AI Helper] AdminConfigHandler error:', err);
      this.response.status = 500;
      this.response.body = { error: err instanceof Error ? err.message : '服务器内部错误' };
      this.response.type = 'application/json';
    }
  }

  /**
   * PUT /ai-helper/admin/config
   * 更新配置（支持旧版单端点和新版多端点）
   */
  async put() {
    try {
      const aiConfigModel: AIConfigModel = this.ctx.get('aiConfigModel');
      const body = this.request.body as UpdateConfigRequest;

      const partial: Partial<Omit<AIConfig, '_id' | 'updatedAt'>> = {};

      // 处理新版多端点配置
      if (body.endpoints !== undefined) {
        const existingConfig = await aiConfigModel.getConfig();
        const existingEndpoints = existingConfig?.endpoints || [];

        const newEndpoints: APIEndpoint[] = [];
        for (const ep of body.endpoints) {
          // 查找是否有现有端点
          const existing = ep.id ? existingEndpoints.find(e => e.id === ep.id) : null;

          let apiKeyEncrypted = existing?.apiKeyEncrypted || '';

          // 如果提供了新的 API Key，加密它
          if (ep.apiKey && ep.apiKey.trim()) {
            try {
              apiKeyEncrypted = encrypt(ep.apiKey.trim());
            } catch (err) {
              this.response.status = 500;
              this.response.body = {
                error: `端点 "${ep.name}" 的 API Key 加密失败`
              };
              this.response.type = 'application/json';
              return;
            }
          }

          newEndpoints.push({
            id: ep.id || (await import('crypto')).randomUUID(),
            name: ep.name,
            apiBaseUrl: ep.apiBaseUrl,
            apiKeyEncrypted,
            models: ep.models || existing?.models || [],
            modelsLastFetched: existing?.modelsLastFetched,
            enabled: ep.enabled !== undefined ? ep.enabled : true,
          });
        }
        partial.endpoints = newEndpoints;
      }

      // 处理选中的模型
      if (body.selectedModels !== undefined) {
        partial.selectedModels = body.selectedModels;
      }

      // 旧版单端点字段（向后兼容）
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
          this.response.body = { error: 'rateLimitPerMinute 必须大于 0' };
          this.response.type = 'application/json';
          return;
        }
        partial.rateLimitPerMinute = rate;
      }

      if (body.timeoutSeconds !== undefined) {
        const timeout = parseInt(String(body.timeoutSeconds), 10);
        if (timeout <= 0) {
          this.response.status = 400;
          this.response.body = { error: 'timeoutSeconds 必须大于 0' };
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

      // 旧版单 API Key（向后兼容）
      if (body.apiKey !== undefined && body.apiKey !== '') {
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

      const jailbreakLogModel: JailbreakLogModel = this.ctx.get('jailbreakLogModel');

      await aiConfigModel.updateConfig(partial);

      const updatedConfig = await aiConfigModel.getConfig();
      if (!updatedConfig) {
        throw new Error('配置更新后读取失败');
      }

      // 处理端点的 API Key 脱敏
      const endpointsWithMaskedKeys = (updatedConfig.endpoints || []).map(ep => {
        let apiKeyMasked = '';
        let hasApiKey = false;
        try {
          if (ep.apiKeyEncrypted) {
            const apiKeyPlain = decrypt(ep.apiKeyEncrypted);
            apiKeyMasked = maskApiKey(apiKeyPlain);
            hasApiKey = true;
          }
        } catch {
          hasApiKey = false;
        }
        return {
          id: ep.id,
          name: ep.name,
          apiBaseUrl: ep.apiBaseUrl,
          models: ep.models || [],
          modelsLastFetched: ep.modelsLastFetched?.toISOString(),
          enabled: ep.enabled,
          apiKeyMasked,
          hasApiKey,
        };
      });

      // 兼容旧版：处理单 API Key
      let apiKeyMasked = '';
      let hasApiKey = false;
      try {
        if (updatedConfig.apiKeyEncrypted) {
          const apiKeyPlain = decrypt(updatedConfig.apiKeyEncrypted);
          apiKeyMasked = maskApiKey(apiKeyPlain);
          hasApiKey = true;
        }
      } catch (err) {
        console.error('[AdminConfigHandler] API Key 解密失败:', err);
        hasApiKey = false;
      }

      const logResult = await jailbreakLogModel.listWithPagination(1, 20);

      this.response.body = {
        config: {
          endpoints: endpointsWithMaskedKeys,
          selectedModels: updatedConfig.selectedModels || [],
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
        jailbreakLogs: {
          logs: logResult.logs.map(formatJailbreakLog),
          total: logResult.total,
          page: logResult.page,
          totalPages: logResult.totalPages
        },
        recentJailbreakLogs: logResult.logs.map(formatJailbreakLog)
      };
      this.response.type = 'application/json';
    } catch (err) {
      console.error('[AdminConfigHandler] 更新配置失败:', err);
      this.response.status = 500;
      this.response.body = {
        error: err instanceof Error ? err.message : '更新配置失败'
      };
      this.response.type = 'application/json';
    }
  }
}

// 导出路由权限配置（使用系统管理员权限）
export const AdminConfigHandlerPriv = PRIV.PRIV_EDIT_SYSTEM;

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
