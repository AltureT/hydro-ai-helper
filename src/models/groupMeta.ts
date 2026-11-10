/**
 * GroupMeta Model - Hydro 小组的插件扩展信息（FR-009/010）
 *
 * Hydro 原生小组只有 { domainId, name, uids }。插件额外保存：
 * - 类型、学年、负责老师、归档状态
 * - pluginAdded 台账：由插件加入、尚未由插件移出的成员。
 *   “漂移” = pluginAdded − 当前 uids，通常是 Hydro 原生页面用旧列表覆盖所致（plan R3）。
 */

import type { Collection, Db } from 'mongodb';
import { unwrapModifyResult } from '../utils/mongo';

export type GroupKind = 'class' | 'other';

export interface GroupMeta {
  _id: string;                 // `${domainId}:${name}`
  domainId: string;
  name: string;
  kind: GroupKind;
  academicYear?: string;
  teacherUids: number[];
  archived: boolean;
  pluginAdded: number[];
  createdBy?: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface GroupMetaPatch {
  kind?: GroupKind;
  academicYear?: string | null;
  teacherUids?: number[];
  archived?: boolean;
}

export function groupMetaId(domainId: string, name: string): string {
  return `${domainId}:${name}`;
}

/** 名称形如“2023级1班”时默认视为班级组 */
export function guessGroupKind(name: string): GroupKind {
  return /^\d{4}级.+班$/.test(name) ? 'class' : 'other';
}

export class GroupMetaModel {
  private collection: Collection<GroupMeta>;

  constructor(db: Db) {
    this.collection = db.collection<GroupMeta>('ai_group_meta');
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex({ domainId: 1, archived: 1 }, { name: 'idx_domainId_archived' });
    await this.collection.createIndex({ teacherUids: 1 }, { name: 'idx_teacherUids' });
    console.log('[GroupMetaModel] Indexes created successfully');
  }

  private insertDefaults(domainId: string, name: string, actorUid: number | undefined, now: Date) {
    return {
      domainId,
      name,
      kind: guessGroupKind(name),
      teacherUids: [] as number[],
      archived: false,
      ...(actorUid !== undefined ? { createdBy: actorUid } : {}),
      createdAt: now,
    };
  }

  async listByDomain(domainId: string): Promise<GroupMeta[]> {
    return this.collection.find({ domainId }).toArray();
  }

  async get(domainId: string, name: string): Promise<GroupMeta | null> {
    return this.collection.findOne({ _id: groupMetaId(domainId, name) });
  }

  /** 更新扩展信息，返回更新前的文档（不存在时为 null） */
  async update(domainId: string, name: string, patch: GroupMetaPatch, actorUid?: number): Promise<GroupMeta | null> {
    const now = new Date();
    const set: Record<string, unknown> = { updatedAt: now };
    const unset: Record<string, ''> = {};
    if (patch.kind !== undefined) set.kind = patch.kind;
    if (patch.teacherUids !== undefined) set.teacherUids = patch.teacherUids;
    if (patch.archived !== undefined) set.archived = patch.archived;
    if (patch.academicYear !== undefined) {
      if (patch.academicYear) set.academicYear = patch.academicYear;
      else unset.academicYear = '';
    }
    const defaults = this.insertDefaults(domainId, name, actorUid, now);
    const setOnInsert: Record<string, unknown> = { pluginAdded: [] };
    for (const [key, value] of Object.entries(defaults)) {
      if (!(key in set) && !(key in unset)) setOnInsert[key] = value;
    }
    const raw = await this.collection.findOneAndUpdate(
      { _id: groupMetaId(domainId, name) },
      {
        $set: set,
        ...(Object.keys(unset).length ? { $unset: unset } : {}),
        $setOnInsert: setOnInsert,
      } as never,
      { upsert: true, returnDocument: 'before' },
    );
    return unwrapModifyResult<GroupMeta>(raw);
  }

  /** 台账：记录由插件加入的成员 */
  async addPluginAdded(domainId: string, name: string, uids: number[], actorUid?: number): Promise<void> {
    if (!uids.length) return;
    const now = new Date();
    await this.collection.updateOne(
      { _id: groupMetaId(domainId, name) },
      {
        $addToSet: { pluginAdded: { $each: uids } },
        $set: { updatedAt: now },
        $setOnInsert: this.insertDefaults(domainId, name, actorUid, now),
      },
      { upsert: true },
    );
  }

  /** 台账：移除成员，返回移除前确实在台账中的 uid */
  async removePluginAdded(domainId: string, name: string, uids: number[]): Promise<number[]> {
    if (!uids.length) return [];
    const raw = await this.collection.findOneAndUpdate(
      { _id: groupMetaId(domainId, name) },
      { $pull: { pluginAdded: { $in: uids } }, $set: { updatedAt: new Date() } },
      { returnDocument: 'before' },
    );
    const before = unwrapModifyResult<GroupMeta>(raw);
    const ledger = new Set(before?.pluginAdded || []);
    return uids.filter((uid) => ledger.has(uid));
  }

  async delete(domainId: string, name: string): Promise<GroupMeta | null> {
    const raw = await this.collection.findOneAndDelete({ _id: groupMetaId(domainId, name) });
    return unwrapModifyResult<GroupMeta>(raw);
  }
}
