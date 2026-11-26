/**
 * 知识库数据模型
 *
 * - ai_knowledge_config  : 知识库连接配置(固定文档 'default')
 * - ai_knowledge_entries : 内置知识库条目(题解思路/引导素材)
 *
 * 两种检索模式:
 * - builtin: 检索本集合中的条目, 简单关键词加权打分
 * - http   : 检索外部知识库 HTTP 接口 (用于链接 ima 知识库或其代理)
 */

import type { Db, Collection, Filter } from 'mongodb';

export type KnowledgeMode = 'builtin' | 'http';

export interface KnowledgeHttpConfig {
  /** 检索端点, 仅允许 http/https 且不得指向内网/保留地址 (SSRF 防护) */
  url: string;
  /** 鉴权 token 密文 (AES-256-GCM, 与 AI 端点 key 同一加密体系) */
  apiKeyEncrypted?: string;
  /** 知识库 ID (ima 知识库编号, 由管理员从 ima 客户端获取) */
  kbId?: string;
  /** 请求超时(毫秒) */
  timeoutMs?: number;
}

export interface KnowledgeConfig {
  enabled: boolean;
  mode: KnowledgeMode;
  /** http 模式的连接参数 */
  http?: KnowledgeHttpConfig;
  /** 返回的最大片段数 */
  topK?: number;
  /** 注入 Prompt 的总字符上限 */
  maxChars?: number;
  updatedAt?: Date;
}

export interface KnowledgeEntry {
  _id?: unknown;
  title: string;
  content: string;
  tags: string[];
  /** 关联题目 pid(可选, 命中标题时加权) */
  problemPid?: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export const DEFAULT_KNOWLEDGE_CONFIG: KnowledgeConfig = {
  enabled: false,
  mode: 'builtin',
  topK: 3,
  maxChars: 2000,
};

export interface KnowledgeHit {
  title: string;
  content: string;
  score: number;
  source: 'builtin' | 'http';
}

const FIXED_CONFIG_ID = 'default';

export class KnowledgeModel {
  private configCollection: Collection<KnowledgeConfig>;
  private entryCollection: Collection<KnowledgeEntry>;

  constructor(db: Db) {
    this.configCollection = db.collection<KnowledgeConfig>('ai_knowledge_config');
    this.entryCollection = db.collection<KnowledgeEntry>('ai_knowledge_entries');
  }

  async ensureIndexes(): Promise<void> {
    await this.entryCollection.createIndex({ title: 'text', tags: 'text', content: 'text' });
    await this.entryCollection.createIndex({ enabled: 1, problemPid: 1 });
  }

  async getConfig(): Promise<KnowledgeConfig> {
    const doc = await this.configCollection.findOne({ _id: FIXED_CONFIG_ID } as any);
    if (!doc) return { ...DEFAULT_KNOWLEDGE_CONFIG };
    return { ...DEFAULT_KNOWLEDGE_CONFIG, ...doc };
  }

  async saveConfig(config: KnowledgeConfig): Promise<KnowledgeConfig> {
    const now = new Date();
    const payload: KnowledgeConfig = { ...config, updatedAt: now };
    delete (payload as any)._id;
    await this.configCollection.updateOne(
      { _id: FIXED_CONFIG_ID } as any,
      { $set: payload as any },
      { upsert: true },
    );
    return payload;
  }

  async list(query: { search?: string; page?: number; pageSize?: number } = {}): Promise<{ total: number; entries: KnowledgeEntry[] }> {
    const page = Math.max(1, Math.floor(query.page || 1));
    const pageSize = Math.min(100, Math.max(1, Math.floor(query.pageSize || 20)));
    const filter: Filter<KnowledgeEntry> = {};
    if (query.search) {
      filter.$or = [
        { title: { $regex: query.search, $options: 'i' } },
        { content: { $regex: query.search, $options: 'i' } },
        { tags: { $in: [query.search] } },
      ];
    }
    const [total, entries] = await Promise.all([
      this.entryCollection.countDocuments(filter),
      this.entryCollection.find(filter)
        .sort({ updatedAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray(),
    ]);
    return { total, entries };
  }

  async create(data: Omit<KnowledgeEntry, '_id' | 'createdAt' | 'updatedAt'>): Promise<KnowledgeEntry> {
    const now = new Date();
    const entry: KnowledgeEntry = { ...data, createdAt: now, updatedAt: now };
    await this.entryCollection.insertOne(entry as any);
    return entry;
  }

  async update(id: KnowledgeEntry['_id'], $set: Partial<KnowledgeEntry>): Promise<boolean> {
    const res = await this.entryCollection.updateOne(
      { _id: id } as any,
      { $set: { ...$set, updatedAt: new Date() } as any },
    );
    return res.modifiedCount > 0 || res.matchedCount > 0;
  }

  async remove(id: KnowledgeEntry['_id']): Promise<boolean> {
    const res = await this.entryCollection.deleteOne({ _id: id } as any);
    return res.deletedCount > 0;
  }

  /**
   * 内置库关键词加权检索.
   * 打分: 标题命中 *8, 标签命中 *5, 题目 pid 命中 *10, 正文出现次数 *1 (封顶 8).
   */
  async search(query: string, opts: { topK?: number; problemPid?: string } = {}): Promise<KnowledgeHit[]> {
    const terms = query
      .toLowerCase()
      .split(/[\s,，。、!?！？;；:：]+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 2)
      .slice(0, 12);
    if (!terms.length) return [];
    const topK = opts.topK || 3;
    const docs = await this.entryCollection.find({ enabled: true } as Filter<KnowledgeEntry>).limit(2000).toArray();
    const scored: KnowledgeHit[] = [];
    for (const doc of docs) {
      let score = 0;
      const title = (doc.title || '').toLowerCase();
      const tags = (doc.tags || []).map((t) => String(t).toLowerCase());
      const content = (doc.content || '').toLowerCase();
      for (const term of terms) {
        if (title.includes(term)) score += 8;
        if (tags.some((t) => t.includes(term))) score += 5;
        if (opts.problemPid && doc.problemPid === opts.problemPid) score += 10;
        const occurrences = content.split(term).length - 1;
        if (occurrences > 0) score += Math.min(8, occurrences);
      }
      if (score > 0) {
        scored.push({ title: doc.title, content: doc.content, score, source: 'builtin' });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }
}
