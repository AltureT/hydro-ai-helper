/**
 * QuotaAdminService - 额度组与个人覆盖的管理（US3，FR-021–FR-026）
 *
 * 只由系统管理员调用（处理器校验）。每次写入：
 * - 记审计（不可撤销；变更前后都写入 detail）；
 * - 额度组变化后立即失效解析缓存并广播（个人覆盖不缓存，无需失效）。
 */

import type { Collection, Db } from 'mongodb';
import { PRIV } from 'hydrooj';
import {
  QuotaGroupModel,
  QuotaGroupNameTakenError,
  toObjectId,
  type LinkedHydroGroup,
  type QuotaGroup,
  type QuotaGroupMode,
  type QuotaGroupPatch,
} from '../models/quotaGroup';
import { QuotaOverrideModel, type QuotaOverride, type QuotaOverrideMode } from '../models/quotaOverride';
import { groupColl } from '../utils/hydroCompat';
import { AuditService } from './auditService';
import { GroupServiceError } from './hydroGroupService';
import { QuotaGroupResolver } from './quotaGroupResolver';
import type { ObjectIdType } from '../utils/mongo';

export const QUOTA_LIMIT_MAX = 100000;
export const QUOTA_GROUP_NAME_MAX = 32;
export const QUOTA_REASON_MAX = 200;
export const QUOTA_BATCH_MAX = 500;
export const QUOTA_DIRECT_MEMBERS_MAX = 5000;
export const QUOTA_LINKS_MAX = 50;
export const OVERRIDE_MAX_DAYS = 366;

const DAY_MS = 24 * 60 * 60 * 1000;

interface UserDocLite {
  _id: number;
  uname: string;
  priv?: number;
}

export interface LinkedGroupView {
  domainId: string;
  domainName: string;
  name: string;
  exists: boolean;
  memberCount: number;
}

export interface QuotaGroupView {
  id: string;
  name: string;
  mode: QuotaGroupMode;
  dailyLimit: number;
  enabled: boolean;
  directCount: number;
  /** 关联小组带来的成员数（不含已直接添加的人） */
  linkedOnlyCount: number;
  totalCount: number;
  linkedGroups: LinkedGroupView[];
  createdBy?: number;
  createdAt: string;
  updatedAt: string;
}

export interface OverrideView {
  uid: number;
  uname: string;
  mode: QuotaOverrideMode;
  dailyLimit?: number;
  expiresAt?: string;
  reason: string;
  setBy: number;
  setByName: string;
  setAt: string;
}

function invalid(code: string, key: string, params: Array<string | number> = []): GroupServiceError {
  return new GroupServiceError(code, 400, key, params);
}

function notFound(): GroupServiceError {
  return new GroupServiceError('QUOTA_GROUP_NOT_FOUND', 404, 'ai_helper_quota_group_not_found');
}

function sanitizeUids(raw: unknown): number[] | null {
  if (!Array.isArray(raw)) return null;
  const out: number[] = [];
  for (const item of raw) {
    const uid = typeof item === 'string' && /^\d+$/.test(item) ? Number(item) : item;
    if (typeof uid !== 'number' || !Number.isSafeInteger(uid) || uid <= 1) return null;
    if (!out.includes(uid)) out.push(uid);
  }
  return out;
}

function hasControlChars(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(value);
}

export function validateQuotaGroupName(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw invalid('INVALID_QUOTA_GROUP_NAME', 'ai_helper_quota_group_name_required');
  const name = raw.trim();
  if (name.length > QUOTA_GROUP_NAME_MAX) {
    throw invalid('INVALID_QUOTA_GROUP_NAME', 'ai_helper_quota_group_name_too_long', [QUOTA_GROUP_NAME_MAX]);
  }
  if (hasControlChars(name)) throw invalid('INVALID_QUOTA_GROUP_NAME', 'ai_helper_quota_group_name_invalid');
  return name;
}

/** 授予型 ≥ 1；限制型 ≥ 0（0 = 关闭 AI）；上限 100000 */
export function validateGroupLimit(mode: unknown, limit: unknown): { mode: QuotaGroupMode; dailyLimit: number } {
  if (mode !== 'grant' && mode !== 'cap') throw invalid('INVALID_QUOTA_GROUP_MODE', 'ai_helper_quota_group_mode_invalid');
  const min = mode === 'grant' ? 1 : 0;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < min || limit > QUOTA_LIMIT_MAX) {
    throw invalid(
      'INVALID_QUOTA_LIMIT',
      mode === 'grant' ? 'ai_helper_quota_group_limit_grant_invalid' : 'ai_helper_quota_group_limit_cap_invalid',
      [QUOTA_LIMIT_MAX],
    );
  }
  return { mode, dailyLimit: limit };
}

function iso(date: Date | undefined): string | undefined {
  return date ? new Date(date).toISOString() : undefined;
}

export class QuotaAdminService {
  private readonly users: Collection<UserDocLite>;
  private readonly domains: Collection<{ _id: string; name?: string }>;

  constructor(
    private readonly db: Db,
    private readonly groups: QuotaGroupModel,
    private readonly overrides: QuotaOverrideModel,
    private readonly resolver: QuotaGroupResolver,
    private readonly audit: AuditService,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.users = db.collection<UserDocLite>('user');
    this.domains = db.collection<{ _id: string; name?: string }>('domain');
  }

  // ─── 读取 ──────────────────────────────────────────────────────────────────

  private async unameMap(uids: number[]): Promise<Map<number, string>> {
    if (!uids.length) return new Map();
    const docs = await this.users.find({ _id: { $in: uids } }, { projection: { _id: 1, uname: 1 } }).toArray();
    return new Map(docs.map((doc) => [doc._id, doc.uname]));
  }

  private async domainNames(ids: string[]): Promise<Map<string, string>> {
    if (!ids.length) return new Map();
    const docs = await this.domains.find({ _id: { $in: ids } }, { projection: { _id: 1, name: 1 } }).toArray();
    return new Map(docs.map((doc) => [doc._id, doc.name || doc._id]));
  }

  async listDomains(): Promise<Array<{ id: string; name: string }>> {
    const docs = await this.domains.find({}, { projection: { _id: 1, name: 1 } }).sort({ _id: 1 }).limit(500).toArray();
    return docs.map((doc) => ({ id: doc._id, name: doc.name || doc._id }));
  }

  /** 读取 Hydro 小组成员（不走缓存：管理页面要看到最新状态） */
  private async linkedMembers(docs: QuotaGroup[]): Promise<Map<string, number[] | null>> {
    const pairs = new Map<string, LinkedHydroGroup>();
    for (const doc of docs) for (const link of doc.linkedGroups || []) pairs.set(`${link.domainId}\u0000${link.name}`, link);
    const out = new Map<string, number[] | null>([...pairs.keys()].map((key) => [key, null]));
    if (!pairs.size) return out;
    const found = await groupColl(this.db)
      .find({ $or: [...pairs.values()].map((link) => ({ domainId: link.domainId, name: link.name })) }, { projection: { domainId: 1, name: 1, uids: 1 } })
      .toArray();
    for (const group of found) out.set(`${group.domainId}\u0000${group.name}`, group.uids || []);
    return out;
  }

  private async views(docs: QuotaGroup[]): Promise<QuotaGroupView[]> {
    const [members, names] = await Promise.all([
      this.linkedMembers(docs),
      this.domainNames([...new Set(docs.flatMap((doc) => (doc.linkedGroups || []).map((link) => link.domainId)))]),
    ]);
    return docs.map((doc) => {
      const direct = new Set(doc.memberUids || []);
      const linkedOnly = new Set<number>();
      const linkedGroups = (doc.linkedGroups || []).map((link) => {
        const uids = members.get(`${link.domainId}\u0000${link.name}`) ?? null;
        for (const uid of uids || []) if (!direct.has(uid)) linkedOnly.add(uid);
        return {
          domainId: link.domainId,
          domainName: names.get(link.domainId) || link.domainId,
          name: link.name,
          exists: uids !== null,
          memberCount: uids?.length ?? 0,
        };
      });
      return {
        id: String(doc._id),
        name: doc.name,
        mode: doc.mode,
        dailyLimit: doc.dailyLimit,
        enabled: doc.enabled !== false,
        directCount: direct.size,
        linkedOnlyCount: linkedOnly.size,
        totalCount: direct.size + linkedOnly.size,
        linkedGroups,
        ...(doc.createdBy !== undefined ? { createdBy: doc.createdBy } : {}),
        createdAt: new Date(doc.createdAt).toISOString(),
        updatedAt: new Date(doc.updatedAt).toISOString(),
      };
    });
  }

  async listGroups(): Promise<{ groups: QuotaGroupView[]; domains: Array<{ id: string; name: string }> }> {
    const [docs, domains] = await Promise.all([this.groups.list(), this.listDomains()]);
    return { groups: await this.views(docs), domains };
  }

  private async requireGroup(idRaw: unknown): Promise<QuotaGroup> {
    const id = typeof idRaw === 'string' ? toObjectId(idRaw) : null;
    const doc = id ? await this.groups.get(id) : null;
    if (!doc) throw notFound();
    return doc;
  }

  /** 成员对话框：直接成员（含用户名）与关联小组 */
  async groupDetail(idRaw: unknown): Promise<{ group: QuotaGroupView; direct: Array<{ uid: number; uname: string }> }> {
    const doc = await this.requireGroup(idRaw);
    const [view] = await this.views([doc]);
    const uids = (doc.memberUids || []).slice(0, QUOTA_DIRECT_MEMBERS_MAX);
    const names = await this.unameMap(uids);
    const direct = uids
      .map((uid) => ({ uid, uname: names.get(uid) || `#${uid}` }))
      .sort((a, b) => a.uname.localeCompare(b.uname));
    return { group: view, direct };
  }

  async listOverrides(): Promise<{ items: OverrideView[]; total: number }> {
    const { items, total } = await this.overrides.listActive(this.clock());
    const names = await this.unameMap([...new Set(items.flatMap((item) => [item._id, item.setBy]))]);
    return {
      total,
      items: items.map((item) => ({
        uid: item._id,
        uname: names.get(item._id) || `#${item._id}`,
        mode: item.mode,
        ...(item.mode === 'limit' ? { dailyLimit: item.dailyLimit } : {}),
        ...(item.expiresAt ? { expiresAt: iso(item.expiresAt) } : {}),
        reason: item.reason,
        setBy: item.setBy,
        setByName: names.get(item.setBy) || `#${item.setBy}`,
        setAt: new Date(item.setAt).toISOString(),
      })),
    };
  }

  // ─── 额度组写入 ────────────────────────────────────────────────────────────

  private groupTarget(doc: Pick<QuotaGroup, '_id' | 'name'>) {
    return { type: 'quota_group' as const, id: String(doc._id), label: doc.name };
  }

  async createGroup(input: { name: unknown; mode: unknown; dailyLimit: unknown; enabled?: unknown }, actorUid: number): Promise<QuotaGroupView> {
    const name = validateQuotaGroupName(input.name);
    const { mode, dailyLimit } = validateGroupLimit(input.mode, input.dailyLimit);
    const enabled = input.enabled === undefined ? true : input.enabled === true;
    let doc: QuotaGroup;
    try {
      doc = await this.groups.create({ name, mode, dailyLimit, enabled, createdBy: actorUid, now: this.clock() });
    } catch (err) {
      if (err instanceof QuotaGroupNameTakenError) throw invalid('QUOTA_GROUP_NAME_TAKEN', 'ai_helper_quota_group_name_taken', [name]);
      throw err;
    }
    await this.audit.record({
      actorUid,
      action: 'quota.group_create',
      target: this.groupTarget(doc),
      detail: { mode, dailyLimit, enabled },
    });
    this.resolver.invalidate();
    const [view] = await this.views([doc]);
    return view;
  }

  async updateGroup(
    idRaw: unknown,
    input: { name?: unknown; mode?: unknown; dailyLimit?: unknown; enabled?: unknown },
    actorUid: number,
  ): Promise<QuotaGroupView> {
    const current = await this.requireGroup(idRaw);
    const patch: QuotaGroupPatch = {};
    if (input.name !== undefined) patch.name = validateQuotaGroupName(input.name);
    if (input.mode !== undefined || input.dailyLimit !== undefined) {
      const checked = validateGroupLimit(input.mode ?? current.mode, input.dailyLimit ?? current.dailyLimit);
      patch.mode = checked.mode;
      patch.dailyLimit = checked.dailyLimit;
    }
    if (input.enabled !== undefined) {
      if (typeof input.enabled !== 'boolean') throw invalid('INVALID_QUOTA_GROUP_ENABLED', 'ai_helper_quota_group_enabled_invalid');
      patch.enabled = input.enabled;
    }
    const changedKeys = (Object.keys(patch) as Array<keyof QuotaGroupPatch>)
      .filter((key) => patch[key] !== current[key]);
    if (!changedKeys.length) {
      const [view] = await this.views([current]);
      return view;
    }
    let result: { before: QuotaGroup; after: QuotaGroup } | null;
    try {
      result = await this.groups.update(current._id, patch, this.clock());
    } catch (err) {
      if (err instanceof QuotaGroupNameTakenError) throw invalid('QUOTA_GROUP_NAME_TAKEN', 'ai_helper_quota_group_name_taken', [String(patch.name)]);
      throw err;
    }
    if (!result) throw notFound();
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const key of changedKeys) {
      before[key] = result.before[key];
      after[key] = result.after[key];
    }
    await this.audit.record({
      actorUid,
      action: 'quota.group_update',
      target: this.groupTarget(result.after),
      detail: { before, after },
    });
    this.resolver.invalidate();
    const [view] = await this.views([result.after]);
    return view;
  }

  async deleteGroup(idRaw: unknown, actorUid: number): Promise<{ deleted: string }> {
    const current = await this.requireGroup(idRaw);
    const removed = await this.groups.delete(current._id);
    if (!removed) throw notFound();
    await this.audit.record({
      actorUid,
      action: 'quota.group_delete',
      target: this.groupTarget(removed),
      detail: {
        mode: removed.mode,
        dailyLimit: removed.dailyLimit,
        enabled: removed.enabled,
        memberUids: removed.memberUids || [],
        linkedGroups: removed.linkedGroups || [],
      },
    });
    this.resolver.invalidate();
    return { deleted: String(removed._id) };
  }

  private requireUids(raw: unknown): number[] {
    const uids = sanitizeUids(raw);
    if (!uids || !uids.length) throw invalid('INVALID_UIDS', 'ai_helper_group_uids_invalid');
    if (uids.length > QUOTA_BATCH_MAX) throw invalid('TOO_MANY_USERS', 'ai_helper_group_too_many_users', [QUOTA_BATCH_MAX]);
    return uids;
  }

  /** 只保留真实用户（排除游客与系统内置账号） */
  private async existingUsers(uids: number[]): Promise<number[]> {
    const docs = await this.users
      .find({ _id: { $in: uids, $gt: 1 }, priv: { $bitsAllSet: Number(PRIV.PRIV_USER_PROFILE) } }, { projection: { _id: 1 } })
      .toArray();
    const found = new Set(docs.map((doc) => doc._id));
    return uids.filter((uid) => found.has(uid));
  }

  async changeMembers(
    idRaw: unknown,
    action: unknown,
    uidsRaw: unknown,
    actorUid: number,
  ): Promise<{ changed: number[]; unchanged: number[]; missing: number[] }> {
    if (action !== 'add' && action !== 'remove') throw invalid('INVALID_ACTION', 'ai_helper_quota_action_invalid');
    const current = await this.requireGroup(idRaw);
    const uids = this.requireUids(uidsRaw);
    let targets = uids;
    let missing: number[] = [];
    if (action === 'add') {
      targets = await this.existingUsers(uids);
      missing = uids.filter((uid) => !targets.includes(uid));
      const existing = new Set(current.memberUids || []);
      const newCount = targets.filter((uid) => !existing.has(uid)).length;
      if (existing.size + newCount > QUOTA_DIRECT_MEMBERS_MAX) {
        throw invalid('QUOTA_GROUP_TOO_LARGE', 'ai_helper_quota_group_too_large', [QUOTA_DIRECT_MEMBERS_MAX]);
      }
    }
    if (!targets.length) return { changed: [], unchanged: [], missing };
    const changed = action === 'add'
      ? await this.groups.addMembers(current._id, targets, this.clock())
      : await this.groups.removeMembers(current._id, targets, this.clock());
    if (changed === null) throw notFound();
    if (changed.length) {
      await this.audit.record({
        actorUid,
        action: action === 'add' ? 'quota.group_member_add' : 'quota.group_member_remove',
        target: this.groupTarget(current),
        detail: action === 'add' ? { added: changed } : { removed: changed },
      });
      this.resolver.invalidate();
    }
    return { changed, unchanged: targets.filter((uid) => !changed.includes(uid)), missing };
  }

  private requireLink(raw: unknown): LinkedHydroGroup {
    const link = raw && typeof raw === 'object' ? raw as { domainId?: unknown; name?: unknown } : {};
    if (typeof link.domainId !== 'string' || !link.domainId.trim() || typeof link.name !== 'string' || !link.name.trim()) {
      throw invalid('INVALID_LINK', 'ai_helper_quota_link_invalid');
    }
    return { domainId: link.domainId.trim(), name: link.name.trim() };
  }

  async link(idRaw: unknown, linkRaw: unknown, actorUid: number): Promise<{ linked: boolean }> {
    const current = await this.requireGroup(idRaw);
    const link = this.requireLink(linkRaw);
    const exists = await groupColl(this.db).findOne({ domainId: link.domainId, name: link.name });
    if (!exists) {
      throw new GroupServiceError('HYDRO_GROUP_NOT_FOUND', 404, 'ai_helper_quota_link_group_missing', [link.name, link.domainId]);
    }
    const already = (current.linkedGroups || []).some((item) => item.domainId === link.domainId && item.name === link.name);
    if (!already && (current.linkedGroups || []).length >= QUOTA_LINKS_MAX) {
      throw invalid('TOO_MANY_LINKS', 'ai_helper_quota_link_too_many', [QUOTA_LINKS_MAX]);
    }
    const linked = await this.groups.link(current._id as ObjectIdType, link, this.clock());
    if (linked === null) throw notFound();
    if (linked) {
      await this.audit.record({
        actorUid,
        action: 'quota.group_link',
        domainId: link.domainId,
        target: this.groupTarget(current),
        detail: { domainId: link.domainId, name: link.name },
      });
      this.resolver.invalidate();
    }
    return { linked };
  }

  /** 取消关联不要求 Hydro 小组仍存在（关联失效时也要能清理） */
  async unlink(idRaw: unknown, linkRaw: unknown, actorUid: number): Promise<{ unlinked: boolean }> {
    const current = await this.requireGroup(idRaw);
    const link = this.requireLink(linkRaw);
    const unlinked = await this.groups.unlink(current._id, link, this.clock());
    if (unlinked === null) throw notFound();
    if (unlinked) {
      await this.audit.record({
        actorUid,
        action: 'quota.group_unlink',
        domainId: link.domainId,
        target: this.groupTarget(current),
        detail: { domainId: link.domainId, name: link.name },
      });
      this.resolver.invalidate();
    }
    return { unlinked };
  }

  // ─── 个人覆盖 ──────────────────────────────────────────────────────────────

  private parseOverride(input: { mode?: unknown; dailyLimit?: unknown; expiresAt?: unknown; reason?: unknown }) {
    const { mode } = input;
    if (mode !== 'limit' && mode !== 'disabled') throw invalid('INVALID_OVERRIDE_MODE', 'ai_helper_quota_override_mode_invalid');
    let dailyLimit: number | undefined;
    if (mode === 'limit') {
      const value = input.dailyLimit;
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > QUOTA_LIMIT_MAX) {
        throw invalid('INVALID_QUOTA_LIMIT', 'ai_helper_quota_override_limit_invalid', [QUOTA_LIMIT_MAX]);
      }
      dailyLimit = value;
    }
    const now = this.clock();
    let expiresAt: Date | null = null;
    if (input.expiresAt !== undefined && input.expiresAt !== null && input.expiresAt !== '') {
      const parsed = typeof input.expiresAt === 'string' ? new Date(input.expiresAt) : null;
      if (!parsed || Number.isNaN(parsed.getTime()) || parsed.getTime() <= now.getTime()
        || parsed.getTime() > now.getTime() + OVERRIDE_MAX_DAYS * DAY_MS) {
        throw invalid('INVALID_EXPIRES_AT', 'ai_helper_quota_override_expires_invalid', [OVERRIDE_MAX_DAYS]);
      }
      expiresAt = parsed;
    }
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (!reason) throw invalid('REASON_REQUIRED', 'ai_helper_quota_override_reason_required');
    if (reason.length > QUOTA_REASON_MAX) throw invalid('REASON_TOO_LONG', 'ai_helper_quota_override_reason_too_long', [QUOTA_REASON_MAX]);
    return { mode: mode as QuotaOverrideMode, dailyLimit, expiresAt, reason, now };
  }

  private overrideSnapshot(doc: QuotaOverride | null) {
    if (!doc) return null;
    return {
      mode: doc.mode,
      ...(doc.mode === 'limit' ? { dailyLimit: doc.dailyLimit } : {}),
      ...(doc.expiresAt ? { expiresAt: doc.expiresAt } : {}),
      reason: doc.reason,
    };
  }

  private async userTarget(uids: number[]) {
    const names = await this.unameMap(uids.slice(0, 5));
    const label = uids.slice(0, 5).map((uid) => names.get(uid) || `#${uid}`).join(', ')
      + (uids.length > 5 ? ` +${uids.length - 5}` : '');
    return { type: 'user' as const, id: uids.length === 1 ? String(uids[0]) : `batch:${uids.length}`, label };
  }

  async setOverrides(
    uidsRaw: unknown,
    input: { mode?: unknown; dailyLimit?: unknown; expiresAt?: unknown; reason?: unknown },
    actorUid: number,
  ): Promise<{ updated: number[]; missing: number[] }> {
    const uids = this.requireUids(uidsRaw);
    const parsed = this.parseOverride(input);
    const targets = await this.existingUsers(uids);
    const missing = uids.filter((uid) => !targets.includes(uid));
    if (!targets.length) return { updated: [], missing };
    const before: Array<{ uid: number; previous: ReturnType<QuotaAdminService['overrideSnapshot']> }> = [];
    for (const uid of targets) {
      const previous = await this.overrides.set(uid, {
        mode: parsed.mode,
        dailyLimit: parsed.dailyLimit,
        expiresAt: parsed.expiresAt,
        reason: parsed.reason,
        setBy: actorUid,
        setAt: parsed.now,
      });
      before.push({ uid, previous: this.overrideSnapshot(previous) });
    }
    await this.audit.record({
      actorUid,
      action: 'quota.override_set',
      target: await this.userTarget(targets),
      detail: {
        uids: targets,
        mode: parsed.mode,
        ...(parsed.dailyLimit !== undefined ? { dailyLimit: parsed.dailyLimit } : {}),
        ...(parsed.expiresAt ? { expiresAt: parsed.expiresAt } : {}),
        reason: parsed.reason,
        before: before.filter((item) => item.previous),
      },
    });
    return { updated: targets, missing };
  }

  async clearOverrides(uidsRaw: unknown, actorUid: number): Promise<{ cleared: number[] }> {
    const uids = this.requireUids(uidsRaw);
    const cleared: number[] = [];
    const before: Array<{ uid: number; previous: ReturnType<QuotaAdminService['overrideSnapshot']> }> = [];
    for (const uid of uids) {
      const previous = await this.overrides.clear(uid);
      if (previous) {
        cleared.push(uid);
        before.push({ uid, previous: this.overrideSnapshot(previous) });
      }
    }
    if (cleared.length) {
      await this.audit.record({
        actorUid,
        action: 'quota.override_clear',
        target: await this.userTarget(cleared),
        detail: { uids: cleared, before },
      });
    }
    return { cleared };
  }
}
