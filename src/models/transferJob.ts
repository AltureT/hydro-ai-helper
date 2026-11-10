/**
 * TransferJob Model - 跨域转移的执行计划与逐步结果（US9，plan R17）
 *
 * 审计记录面向阅读（字符串会被脱敏截断），继续执行和撤销需要原样的计划与结果，
 * 因此单独保存在 ai_transfer_jobs 中；_id 与对应的审计记录相同，保留期一致（180 天）。
 */

import type { Collection, Db } from 'mongodb';
import { AUDIT_RETENTION_DAYS } from './auditLog';
import { unwrapModifyResult, type ObjectIdType } from '../utils/mongo';

export type TransferKind = 'groups' | 'users';
export type TransferMode = 'copy' | 'move';
export type TransferJobStatus = 'running' | 'done' | 'partial' | 'undone';

export type TransferStep =
  | { key: string; type: 'join'; domainId: string; uids: number[]; role: string }
  | { key: string; type: 'group'; domainId: string; name: string; uids: number[]; sourceDomainId?: string; sourceName?: string }
  | { key: string; type: 'relink'; quotaGroupId: string; quotaGroupName: string; from: { domainId: string; name: string }; to: { domainId: string; name: string } }
  | { key: string; type: 'delete_group'; domainId: string; name: string }
  | { key: string; type: 'leave'; domainId: string; uids: number[] }
  | { key: string; type: 'pull'; domainId: string; uids: number[] };

export type TransferStepType = TransferStep['type'];

export interface TransferStepResult {
  key: string;
  at: Date;
  /** join：加入前的记录（用于撤销）；leave：退出前的记录 */
  rows?: Array<{ uid: number; role?: string | null; join?: boolean }>;
  absent?: number[];
  /** group：新建了小组 / 扩展信息，实际新增的成员 */
  created?: boolean;
  metaCreated?: boolean;
  added?: number[];
  /** relink：确实取消了源组关联 / 新增了目标组关联（撤销时只回退做过的部分） */
  unlinked?: boolean;
  linked?: boolean;
  /** delete_group：删除前的成员与扩展信息快照 */
  snapshot?: { uids: number[] } | null;
  metaSnapshot?: Record<string, unknown> | null;
  /** pull：从源域各小组移出的成员；ledger = 其中原本在插件台账里的（撤销时只恢复这些） */
  removed?: Array<{ name: string; uids: number[]; ledger?: number[] }>;
}

export interface TransferJob {
  _id: ObjectIdType;
  kind: TransferKind;
  mode: TransferMode;
  sourceDomainId: string;
  targetDomainId: string;
  actorUid: number;
  plan: TransferStep[];
  /** 每步写入前的快照（重试时沿用，保证中途失败后继续执行或撤销仍以原始状态为准） */
  prepared: Array<{ key: string; data: Record<string, unknown> }>;
  results: TransferStepResult[];
  status: TransferJobStatus;
  failedAt?: string;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
  expireAt: Date;
}

export class TransferJobModel {
  private collection: Collection<TransferJob>;

  constructor(db: Db) {
    this.collection = db.collection<TransferJob>('ai_transfer_jobs');
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex({ expireAt: 1 }, { name: 'ttl_expireAt', expireAfterSeconds: 0 });
    console.log('[TransferJobModel] Indexes created successfully');
  }

  async create(job: Omit<TransferJob, 'prepared' | 'results' | 'status' | 'createdAt' | 'updatedAt' | 'expireAt'>, now = new Date()): Promise<TransferJob> {
    const doc: TransferJob = {
      ...job,
      prepared: [],
      results: [],
      status: 'running',
      createdAt: now,
      updatedAt: now,
      expireAt: new Date(now.getTime() + AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000),
    };
    await this.collection.insertOne(doc);
    return doc;
  }

  async get(id: ObjectIdType): Promise<TransferJob | null> {
    return this.collection.findOne({ _id: id });
  }

  async addPrepared(id: ObjectIdType, key: string, data: Record<string, unknown>): Promise<void> {
    await this.collection.updateOne({ _id: id }, { $push: { prepared: { key, data } }, $set: { updatedAt: new Date() } });
  }

  async addResult(id: ObjectIdType, result: TransferStepResult): Promise<void> {
    await this.collection.updateOne({ _id: id }, { $push: { results: result }, $set: { updatedAt: result.at } });
  }

  async setStatus(id: ObjectIdType, status: TransferJobStatus, extra: { failedAt?: string; error?: string } = {}): Promise<void> {
    const update: Record<string, unknown> = { $set: { status, updatedAt: new Date(), ...extra } };
    if (!extra.failedAt) update.$unset = { failedAt: '', error: '' };
    await this.collection.updateOne({ _id: id }, update);
  }

  /** 原子地把“部分完成”改为“执行中”，防止两个请求同时继续执行 */
  async claimResume(id: ObjectIdType): Promise<TransferJob | null> {
    return unwrapModifyResult<TransferJob>(await this.collection.findOneAndUpdate(
      { _id: id, status: 'partial' },
      { $set: { status: 'running', updatedAt: new Date() } },
      { returnDocument: 'after' },
    ));
  }
}
