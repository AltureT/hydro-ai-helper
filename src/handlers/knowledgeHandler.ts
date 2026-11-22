/**
 * 知识库管理 Handler
 *
 * GET  /ai-helper/admin/knowledge            管理页面 (HTML) 或配置+条目 JSON
 * POST /ai-helper/admin/knowledge            op 分发: saveConfig/list/create/update/delete/test
 */

import { Handler, PRIV } from 'hydrooj';
import { ObjectId, type ObjectIdType } from '../utils/mongo';
import { encrypt, decrypt, maskApiKey } from '../lib/crypto';
import { KnowledgeModel } from '../models/knowledge';
import type { KnowledgeConfig, KnowledgeHttpConfig } from '../models/knowledge';
import { KnowledgeService } from '../services/knowledgeService';

const DEFAULT_TOP_K = 3;
const DEFAULT_MAX_CHARS = 2000;

function normalizeHttpConfig(input: any): KnowledgeHttpConfig {
  return {
    url: String(input?.url || '').trim(),
    kbId: input?.kbId ? String(input.kbId).trim() : undefined,
    timeoutMs: input?.timeoutMs ? Math.min(60000, Math.max(1000, Math.floor(Number(input.timeoutMs)))) : undefined,
  };
}

export function sanitizeKnowledgeConfig(config: KnowledgeConfig & { http?: KnowledgeHttpConfig }): {
  config: Omit<KnowledgeConfig, never>;
  http?: { url: string; kbId?: string; timeoutMs?: number; hasApiKey: boolean; apiKeyMasked?: string };
} {
  const { http, ...rest } = config;
  if (!http) return { config: rest };
  const result: any = {
    config: {
      ...rest,
      http: {
        url: http.url,
        kbId: http.kbId,
        timeoutMs: http.timeoutMs,
        apiKeyEncrypted: http.apiKeyEncrypted,
      },
    },
  };
  let apiKeyMasked = '';
  let hasApiKey = false;
  try {
    if (http.apiKeyEncrypted) {
      apiKeyMasked = maskApiKey(decrypt(http.apiKeyEncrypted));
      hasApiKey = true;
    }
  } catch {
    hasApiKey = false;
  }
  result.http = {
    url: http.url,
    kbId: http.kbId,
    timeoutMs: http.timeoutMs,
    hasApiKey,
    apiKeyMasked,
  };
  return result;
}

export class KnowledgeAdminHandler extends Handler {
  async get() {
    const accept = this.request.headers.accept || '';
    const model: KnowledgeModel = this.ctx.get('knowledgeModel');

    if (accept.includes('text/html')) {
      this.response.template = 'ai-helper/knowledge_admin.html';
      this.response.body = {};
      return;
    }

    const [config, entries] = await Promise.all([
      model.getConfig(),
      model.list({ page: 1, pageSize: 50 }),
    ]);
    const sanitized = sanitizeKnowledgeConfig(config);
    this.response.body = {
      config: {
        enabled: sanitized.config.enabled,
        mode: sanitized.config.mode,
        topK: sanitized.config.topK,
        maxChars: sanitized.config.maxChars,
        http: sanitized.http,
      },
      total: entries.total,
      entries: entries.entries.map((e) => ({
        id: (e._id as ObjectIdType)?.toHexString?.() || String(e._id),
        title: e.title,
        content: e.content,
        tags: e.tags,
        problemPid: e.problemPid,
        enabled: e.enabled,
      })),
    };
    this.response.type = 'application/json';
  }

  async post() {
    const model: KnowledgeModel = this.ctx.get('knowledgeModel');
    const body: any = this.request.body || {};
    const op = String(body.op || '');

    try {
      switch (op) {
        case 'saveConfig': {
          const incoming: any = body.config || {};
          const current = await model.getConfig();
          const next: KnowledgeConfig = {
            enabled: Boolean(incoming.enabled),
            mode: incoming.mode === 'http' ? 'http' : 'builtin',
            topK: Math.min(10, Math.max(1, Math.floor(Number(incoming.topK) || DEFAULT_TOP_K))),
            maxChars: Math.min(8000, Math.max(200, Math.floor(Number(incoming.maxChars) || DEFAULT_MAX_CHARS))),
          };
          if (incoming.http && typeof incoming.http === 'object') {
            const http = normalizeHttpConfig(incoming.http);
            // 保留旧密文, 除非前端提交了新明文 key
            let apiKeyEncrypted = incoming.http.apiKeyEncrypted || current.http?.apiKeyEncrypted;
            if (typeof incoming.http.apiKey === 'string' && incoming.http.apiKey.trim()) {
              apiKeyEncrypted = encrypt(incoming.http.apiKey.trim());
            } else if (incoming.http.apiKey === '') {
              apiKeyEncrypted = undefined;
            }
            if (apiKeyEncrypted) http.apiKeyEncrypted = apiKeyEncrypted;
            next.http = http;
          } else if (current.http) {
            next.http = current.http;
          }
          const saved = await model.saveConfig(next);
          const sanitized = sanitizeKnowledgeConfig(saved);
          this.response.body = { ok: true, config: sanitized.http ? { ...sanitized.config, http: sanitized.http } : sanitized.config };
          break;
        }
        case 'list': {
          const { total, entries } = await model.list({
            search: body.search ? String(body.search) : undefined,
            page: Math.floor(Number(body.page) || 1),
            pageSize: Math.floor(Number(body.pageSize) || 20),
          });
          this.response.body = {
            ok: true,
            total,
            entries: entries.map((e) => ({
              id: (e._id as ObjectIdType)?.toHexString?.() || String(e._id),
              title: e.title,
              content: e.content,
              tags: e.tags,
              problemPid: e.problemPid,
              enabled: e.enabled,
            })),
          };
          break;
        }
        case 'create': {
          const title = String(body.title || '').trim();
          const content = String(body.content || '').trim();
          if (!title || !content) {
            this.response.status = 400;
            this.response.body = { ok: false, error: 'title/content required' };
            break;
          }
          await model.create({
            title: title.slice(0, 200),
            content: content.slice(0, 20000),
            tags: Array.isArray(body.tags) ? body.tags.map((t: any) => String(t).slice(0, 50)).slice(0, 20) : [],
            problemPid: body.problemPid ? String(body.problemPid).slice(0, 100) : undefined,
            enabled: body.enabled !== false,
          });
          this.response.body = { ok: true };
          break;
        }
        case 'update': {
          if (!body.id || !ObjectId.isValid(String(body.id))) {
            this.response.status = 400;
            this.response.body = { ok: false, error: 'invalid id' };
            break;
          }
          const $set: Record<string, any> = {};
          if (typeof body.title === 'string') $set.title = body.title.trim().slice(0, 200);
          if (typeof body.content === 'string') $set.content = body.content.trim().slice(0, 20000);
          if (Array.isArray(body.tags)) $set.tags = body.tags.map((t: any) => String(t).slice(0, 50)).slice(0, 20);
          if (body.problemPid !== undefined) $set.problemPid = body.problemPid ? String(body.problemPid).slice(0, 100) : undefined;
          if (typeof body.enabled === 'boolean') $set.enabled = body.enabled;
          const updated = await model.update(new ObjectId(String(body.id)), $set);
          this.response.body = { ok: updated };
          break;
        }
        case 'delete': {
          if (!body.id || !ObjectId.isValid(String(body.id))) {
            this.response.status = 400;
            this.response.body = { ok: false, error: 'invalid id' };
            break;
          }
          const removed = await model.remove(new ObjectId(String(body.id)));
          this.response.body = { ok: removed };
          break;
        }
        case 'test': {
          const query = String(body.query || '').trim();
          if (!query) {
            this.response.status = 400;
            this.response.body = { ok: false, error: 'query required' };
            break;
          }
          const service = new KnowledgeService(this.ctx);
          const block = await service.retrieveBlock(query, { problemPid: body.problemPid ? String(body.problemPid) : undefined });
          this.response.body = { ok: true, block: block || '(无检索结果或知识库未启用)', truncated: Boolean(block) };
          break;
        }
        default:
          this.response.status = 400;
          this.response.body = { ok: false, error: `unknown op: ${op}` };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.response.status = message.includes('不允许') || message.includes('受限') ? 403 : 500;
      this.response.body = { ok: false, error: message };
    }
    this.response.type = 'application/json';
  }
}

export const KnowledgeAdminHandlerPriv = PRIV.PRIV_EDIT_SYSTEM;
