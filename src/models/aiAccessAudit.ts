/**
 * AIAccessAudit Model - AI 访问策略变更审计日志
 *
 * 每次策略创建/修改/删除都写入一条记录（谁、何时、改了什么、前后快照）。
 * 永久保留，便于追溯学生额度和禁用的来源。
 */

import type { Db, Collection } from 'mongodb';
import { type ObjectIdType } from '../utils/mongo';
import type { AccessPolicyScope, AIAccessPolicy } from './aiAccessPolicy';

export type AccessAuditAction = 'upsert' | 'delete';

export type AccessPolicySnapshot = Omit<AIAccessPolicy, '_id'> | null;

export interface AIAccessAuditRecord {
  _id: ObjectIdType;
  domainId: string;
  scope: AccessPolicyScope;
  target: number | string;
  action: AccessAuditAction;
  before: AccessPolicySnapshot;
  after: AccessPolicySnapshot;
  operatorUid: number;
  /** 同一次批量操作写入的记录共享 batchId */
  batchId?: string;
  createdAt: Date;
}

export interface AccessAuditListOptions {
  scope?: AccessPolicyScope;
  target?: number | string;
  limit?: number;
}

function snapshot(policy: AIAccessPolicy | null): AccessPolicySnapshot {
  if (!policy) return null;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { _id, ...rest } = policy;
  return rest;
}

export class AIAccessAuditModel {
  private collection: Collection<AIAccessAuditRecord>;

  constructor(db: Db) {
    this.collection = db.collection<AIAccessAuditRecord>('ai_access_audit');
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex(
      { domainId: 1, createdAt: -1 },
      { name: 'idx_domainId_createdAt' },
    );
    await this.collection.createIndex(
      { domainId: 1, scope: 1, target: 1, createdAt: -1 },
      { name: 'idx_domainId_scope_target_createdAt' },
    );
    console.log('[AIAccessAuditModel] Indexes created successfully');
  }

  async record(params: {
    domainId: string;
    scope: AccessPolicyScope;
    target: number | string;
    action: AccessAuditAction;
    before: AIAccessPolicy | null;
    after: AIAccessPolicy | null;
    operatorUid: number;
    batchId?: string;
  }): Promise<void> {
    await this.collection.insertOne({
      domainId: params.domainId,
      scope: params.scope,
      target: params.target,
      action: params.action,
      before: snapshot(params.before),
      after: snapshot(params.after),
      operatorUid: params.operatorUid,
      ...(params.batchId ? { batchId: params.batchId } : {}),
      createdAt: new Date(),
    } as AIAccessAuditRecord);
  }

  async list(domainId: string, options: AccessAuditListOptions = {}): Promise<AIAccessAuditRecord[]> {
    const query: Record<string, unknown> = { domainId };
    if (options.scope) query.scope = options.scope;
    if (options.target !== undefined) query.target = options.target;
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    return this.collection
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .find(query as any)
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
  }
}
