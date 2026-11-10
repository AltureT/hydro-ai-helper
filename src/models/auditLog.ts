/**
 * AuditLog Model - 用户管理操作审计（FR-059/060）
 *
 * 记录插件发起的小组成员变更、额度与覆盖、信誉、AI 抽查等管理动作。
 * 只保存必要的短片段，保留期与安全日志一致（180 天 TTL）。
 */

import type { Collection, Db, Filter } from 'mongodb';
import { ObjectId, type ObjectIdType, unwrapModifyResult } from '../utils/mongo';

export const AUDIT_RETENTION_DAYS = 180;
const AUDIT_RETENTION_MS = AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/** 审计动作分类，对应审计页“动作”筛选 */
export type AuditCategory = 'group' | 'transfer' | 'quota' | 'credit' | 'review' | 'settings';

export const AUDIT_CATEGORIES: readonly AuditCategory[] = [
  'group', 'transfer', 'quota', 'credit', 'review', 'settings',
] as const;

/**
 * 审计动作（`分类.动作`）。后续 PR 在此追加额度、信誉、抽查、转移等动作。
 */
export type AuditAction =
  | 'group.add'
  | 'group.remove'
  | 'group.drift_restore'
  | 'group.drift_dismiss'
  | 'group.meta'
  | 'group.backfill'
  | 'quota.group_create'
  | 'quota.group_update'
  | 'quota.group_delete'
  | 'quota.group_member_add'
  | 'quota.group_member_remove'
  | 'quota.group_link'
  | 'quota.group_unlink'
  | 'quota.override_set'
  | 'quota.override_clear'
  | 'transfer.groups'
  | 'transfer.users'
  | 'credit.reset'
  | 'credit.revoke'
  | 'review.run'
  | 'review.breaker_trip'
  | 'review.auto_penalty_disable'
  | 'review.auto_penalty_resume'
  | 'settings.teacher_access';

export const AUDIT_ACTIONS: readonly AuditAction[] = [
  'group.add',
  'group.remove',
  'group.drift_restore',
  'group.drift_dismiss',
  'group.meta',
  'group.backfill',
  'quota.group_create',
  'quota.group_update',
  'quota.group_delete',
  'quota.group_member_add',
  'quota.group_member_remove',
  'quota.group_link',
  'quota.group_unlink',
  'quota.override_set',
  'quota.override_clear',
  'transfer.groups',
  'transfer.users',
  'credit.reset',
  'credit.revoke',
  'review.run',
  'review.breaker_trip',
  'review.auto_penalty_disable',
  'review.auto_penalty_resume',
  'settings.teacher_access',
] as const;

export function auditCategoryOf(action: AuditAction): AuditCategory {
  return action.split('.')[0] as AuditCategory;
}

export interface AuditTarget {
  type: 'group' | 'user' | 'quota_group' | 'config' | 'review' | 'transfer' | 'domain';
  id: string;
  label?: string;
}

/** 多步骤操作（如跨域转移）逐步追加的执行记录 */
export interface AuditStep {
  name: string;
  status: 'done' | 'failed' | 'skipped';
  detail?: Record<string, unknown>;
  at: Date;
}

export interface AuditLog {
  _id: ObjectIdType;
  at: Date;
  /** 缺省表示系统动作（如 AI 自动处罚） */
  actorUid?: number;
  action: AuditAction;
  category: AuditCategory;
  domainId?: string;
  target: AuditTarget;
  detail: Record<string, unknown>;
  steps?: AuditStep[];
  undoable: boolean;
  undoneAt?: Date;
  undoneBy?: number;
  expireAt: Date;
}

export interface AuditLogListFilters {
  category?: AuditCategory;
  action?: AuditAction;
  actorUid?: number;
  /** 'system' 只看系统动作 */
  actorType?: 'system';
  domainId?: string;
  from?: Date;
  to?: Date;
  targetType?: AuditTarget['type'];
  targetId?: string;
}

export interface AuditLogListResult {
  logs: AuditLog[];
  total: number;
  page: number;
  totalPages: number;
}

export class AuditLogModel {
  private collection: Collection<AuditLog>;

  constructor(db: Db) {
    this.collection = db.collection<AuditLog>('ai_audit_logs');
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex({ at: -1 }, { name: 'idx_at' });
    await this.collection.createIndex({ domainId: 1, at: -1 }, { name: 'idx_domainId_at' });
    await this.collection.createIndex({ category: 1, at: -1 }, { name: 'idx_category_at' });
    await this.collection.createIndex(
      { 'target.type': 1, 'target.id': 1 },
      { name: 'idx_target' },
    );
    await this.collection.createIndex(
      { expireAt: 1 },
      { name: 'idx_expireAt_ttl', expireAfterSeconds: 0 },
    );
    console.log('[AuditLogModel] Indexes created successfully');
  }

  async insert(data: Omit<AuditLog, '_id' | 'category' | 'expireAt' | 'at'> & { at?: Date }): Promise<ObjectIdType> {
    const at = data.at ?? new Date();
    const doc = {
      ...data,
      at,
      category: auditCategoryOf(data.action),
      expireAt: new Date(at.getTime() + AUDIT_RETENTION_MS),
    } as AuditLog;
    const result = await this.collection.insertOne(doc);
    return result.insertedId;
  }

  async findById(id: string | ObjectIdType): Promise<AuditLog | null> {
    const _id = typeof id === 'string' ? new ObjectId(id) : id;
    return this.collection.findOne({ _id });
  }

  async appendStep(id: ObjectIdType, step: AuditStep): Promise<void> {
    await this.collection.updateOne({ _id: id }, { $push: { steps: step } });
  }

  /** 只合并新的 detail 字段，不覆盖整份 detail */
  async mergeDetail(id: ObjectIdType, patch: Record<string, unknown>): Promise<void> {
    const set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) set[`detail.${key}`] = value;
    if (Object.keys(set).length) await this.collection.updateOne({ _id: id }, { $set: set });
  }

  /**
   * 原子地把记录标记为已撤销。已撤销或不可撤销时返回 null，保证同一操作只会被撤销一次。
   */
  async claimUndo(id: ObjectIdType, undoneBy: number, at: Date = new Date()): Promise<AuditLog | null> {
    const raw = await this.collection.findOneAndUpdate(
      { _id: id, undoable: true, undoneAt: { $exists: false } },
      { $set: { undoneAt: at, undoneBy } },
      { returnDocument: 'before' },
    );
    return unwrapModifyResult<AuditLog>(raw);
  }

  /** 撤销执行失败时回滚撤销标记，允许管理员重试 */
  async releaseUndo(id: ObjectIdType): Promise<void> {
    await this.collection.updateOne({ _id: id }, { $unset: { undoneAt: '', undoneBy: '' } });
  }

  async list(filters: AuditLogListFilters, page = 1, limit = 20): Promise<AuditLogListResult> {
    const safeLimit = Math.min(100, Math.max(1, Math.floor(limit) || 20));
    const safePage = Math.max(1, Math.floor(page) || 1);
    const query: Filter<AuditLog> = {};
    if (filters.category) query.category = filters.category;
    if (filters.action) query.action = filters.action;
    if (filters.actorType === 'system') query.actorUid = { $exists: false };
    else if (filters.actorUid !== undefined) query.actorUid = filters.actorUid;
    if (filters.domainId) query.domainId = filters.domainId;
    if (filters.targetType) query['target.type'] = filters.targetType;
    if (filters.targetId) query['target.id'] = filters.targetId;
    if (filters.from || filters.to) {
      query.at = {
        ...(filters.from ? { $gte: filters.from } : {}),
        ...(filters.to ? { $lte: filters.to } : {}),
      };
    }
    const [logs, total] = await Promise.all([
      this.collection.find(query).sort({ at: -1 }).skip((safePage - 1) * safeLimit).limit(safeLimit).toArray(),
      this.collection.countDocuments(query),
    ]);
    return { logs, total, page: safePage, totalPages: Math.ceil(total / safeLimit) };
  }
}
