/**
 * AuditService - 管理操作审计（FR-059/060）
 *
 * 写入前对所有字符串做脱敏截断（沿用安全日志的 sanitizeSafetyLogSnippet），
 * 不保存完整对话或代码。uid 数组等撤销所需数据保持完整（批量上限 500，体积可控）。
 */

import {
  AuditLogModel,
  type AuditAction,
  type AuditLog,
  type AuditLogListFilters,
  type AuditLogListResult,
  type AuditStep,
  type AuditTarget,
} from '../models/auditLog';
import { sanitizeSafetyLogSnippet } from '../models/jailbreakLog';
import type { ObjectIdType } from '../utils/mongo';

const MAX_DEPTH = 5;
const MAX_ARRAY_LENGTH = 5000;
const MAX_KEYS = 50;

function isObjectIdLike(value: unknown): boolean {
  return !!value && typeof value === 'object'
    && typeof (value as { toHexString?: unknown }).toHexString === 'function';
}

/** 深度遍历，脱敏截断所有字符串；限制深度、数组长度与键数量 */
export function sanitizeAuditValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return sanitizeSafetyLogSnippet(value);
  if (value === null || value === undefined) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date || isObjectIdLike(value)) return value;
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_LENGTH).map((item) => sanitizeAuditValue(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, MAX_KEYS)) {
      out[key] = sanitizeAuditValue(item, depth + 1);
    }
    return out;
  }
  return undefined;
}

export interface AuditRecordInput {
  /** 缺省表示系统动作 */
  actorUid?: number;
  action: AuditAction;
  domainId?: string;
  target: AuditTarget;
  detail?: Record<string, unknown>;
  undoable?: boolean;
}

export class AuditService {
  constructor(private readonly model: AuditLogModel) {}

  async record(input: AuditRecordInput): Promise<ObjectIdType> {
    return this.model.insert({
      ...(input.actorUid !== undefined ? { actorUid: input.actorUid } : {}),
      action: input.action,
      ...(input.domainId ? { domainId: input.domainId } : {}),
      target: {
        type: input.target.type,
        id: sanitizeSafetyLogSnippet(input.target.id),
        ...(input.target.label ? { label: sanitizeSafetyLogSnippet(input.target.label) } : {}),
      },
      detail: sanitizeAuditValue(input.detail || {}) as Record<string, unknown>,
      undoable: !!input.undoable,
    });
  }

  async appendStep(id: ObjectIdType, step: Omit<AuditStep, 'at'> & { at?: Date }): Promise<void> {
    await this.model.appendStep(id, {
      name: sanitizeSafetyLogSnippet(step.name),
      status: step.status,
      ...(step.detail ? { detail: sanitizeAuditValue(step.detail) as Record<string, unknown> } : {}),
      at: step.at ?? new Date(),
    });
  }

  async mergeDetail(id: ObjectIdType, patch: Record<string, unknown>): Promise<void> {
    await this.model.mergeDetail(id, sanitizeAuditValue(patch) as Record<string, unknown>);
  }

  /**
   * 原子标记撤销：返回撤销前的记录；已撤销、不可撤销或不存在时返回 null。
   * 撤销执行失败时调用 revertUndoMark 允许重试。
   */
  async markUndone(id: ObjectIdType, undoneBy: number): Promise<AuditLog | null> {
    return this.model.claimUndo(id, undoneBy);
  }

  async revertUndoMark(id: ObjectIdType): Promise<void> {
    await this.model.releaseUndo(id);
  }

  async findById(id: string | ObjectIdType): Promise<AuditLog | null> {
    return this.model.findById(id);
  }

  async list(filters: AuditLogListFilters, page = 1, limit = 20): Promise<AuditLogListResult> {
    return this.model.list(filters, page, limit);
  }
}
