/**
 * AIAccessPolicy Model - 按用户/用户组的 AI 访问策略
 *
 * 管理员手动控制（与 safetyPenaltyService 的自动冷却相互独立）：
 * - 禁用指定账号或用户组
 * - 覆盖每用户日 token 上限（0 = 不限）
 * - 当日一次性追加额度
 * - 覆盖每分钟请求频率
 *
 * 文档以 { domainId, scope, target } 唯一定位：
 * - scope = 'user'  → target 为 uid (number)
 * - scope = 'group' → target 为 HydroOJ 域用户组名 (string)
 */

import type { Db, Collection } from 'mongodb';
import { type ObjectIdType } from '../utils/mongo';

export type AccessPolicyScope = 'user' | 'group';

export const ACCESS_POLICY_SCOPES: readonly AccessPolicyScope[] = ['user', 'group'] as const;

export interface ExtraTokenGrant {
  date: string; // YYYY-MM-DD (UTC，与 ai_usage_daily_agg 的 date 一致)
  amount: number;
}

export interface AIAccessPolicy {
  _id: ObjectIdType;
  domainId: string;
  scope: AccessPolicyScope;
  target: number | string;
  enabled: boolean;
  dailyTokenLimit?: number;     // 覆盖 budgetConfig.dailyTokenLimitPerUser (0 = 不限)
  extraTokens?: ExtraTokenGrant;// 仅在 date 当天生效
  rateLimitPerMinute?: number;  // 覆盖全局 rateLimitPerMinute (0 = 不限)
  expiresAt?: Date;             // 到期后策略不再生效
  reason?: string;
  updatedBy: number;
  updatedAt: Date;
}

/**
 * 策略字段补丁：undefined = 不修改，null = 清除该字段
 */
export interface AccessPolicyPatch {
  enabled?: boolean;
  dailyTokenLimit?: number | null;
  extraTokens?: ExtraTokenGrant | null;
  rateLimitPerMinute?: number | null;
  expiresAt?: Date | null;
  reason?: string | null;
}

const PATCHABLE_FIELDS = ['enabled', 'dailyTokenLimit', 'extraTokens', 'rateLimitPerMinute', 'expiresAt', 'reason'] as const;

export class AIAccessPolicyModel {
  private collection: Collection<AIAccessPolicy>;

  constructor(db: Db) {
    this.collection = db.collection<AIAccessPolicy>('ai_access_policies');
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex(
      { domainId: 1, scope: 1, target: 1 },
      { unique: true, name: 'idx_domainId_scope_target_unique' },
    );
    console.log('[AIAccessPolicyModel] Indexes created successfully');
  }

  /**
   * 一次查询取出某用户相关的全部策略（用户级 + 所属组）
   */
  async findForUser(domainId: string, uid: number, groupNames: string[]): Promise<AIAccessPolicy[]> {
    const or: Record<string, unknown>[] = [{ scope: 'user', target: uid }];
    if (groupNames.length > 0) or.push({ scope: 'group', target: { $in: groupNames } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.collection.find({ domainId, $or: or } as any).toArray();
  }

  async get(domainId: string, scope: AccessPolicyScope, target: number | string): Promise<AIAccessPolicy | null> {
    return this.collection.findOne({ domainId, scope, target });
  }

  async list(domainId: string, scope?: AccessPolicyScope, targets?: Array<number | string>): Promise<AIAccessPolicy[]> {
    const query: Record<string, unknown> = { domainId };
    if (scope) query.scope = scope;
    if (targets) query.target = { $in: targets };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.collection.find(query as any).sort({ updatedAt: -1 }).limit(5000).toArray();
  }

  /**
   * 创建或修改策略，返回修改前后的文档（供审计）
   */
  async upsert(
    domainId: string,
    scope: AccessPolicyScope,
    target: number | string,
    patch: AccessPolicyPatch,
    updatedBy: number,
  ): Promise<{ before: AIAccessPolicy | null; after: AIAccessPolicy | null }> {
    const before = await this.get(domainId, scope, target);
    const $set: Record<string, unknown> = { updatedBy, updatedAt: new Date() };
    const $unset: Record<string, ''> = {};
    for (const field of PATCHABLE_FIELDS) {
      const value = patch[field];
      if (value === undefined) continue;
      if (value === null) $unset[field] = '';
      else $set[field] = value;
    }
    const update: Record<string, unknown> = {
      $set,
      $setOnInsert: patch.enabled === undefined
        ? { domainId, scope, target, enabled: true }
        : { domainId, scope, target },
    };
    if (Object.keys($unset).length > 0) update.$unset = $unset;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await this.collection.updateOne({ domainId, scope, target }, update as any, { upsert: true });
    const after = await this.get(domainId, scope, target);
    return { before, after };
  }

  async delete(domainId: string, scope: AccessPolicyScope, target: number | string): Promise<AIAccessPolicy | null> {
    const before = await this.get(domainId, scope, target);
    if (before) await this.collection.deleteOne({ domainId, scope, target });
    return before;
  }
}
